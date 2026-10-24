const test = require('node:test');
const assert = require('node:assert/strict');
const chatHandler = require('../api/v1/chat/completions');
const agentHandler = require('../api/v1/agent/run');
const topupHandler = require('../api/v1/keys/topup');
const { evaluateArithmetic, selectTools } = require('../api/_lib/agent-tools');
const { configuration, resolveGroqModel } = require('../api/_lib/gateway');

const apiToken = `aethel_live_${'a'.repeat(40)}`;
const apiKeyId = 'f0ad8b80-335f-4a6b-a62e-98c81dbe12c8';
const originalFetch = global.fetch;
const savedEnvironment = {};
for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AETHEL_ADMIN_KEY', 'AETHEL_ALLOWED_MODELS', 'AETHEL_DAILY_REQUEST_LIMIT', 'AETHEL_MAX_DAILY_REQUEST_LIMIT', 'AETHEL_MAX_OUTPUT_TOKENS', 'AETHEL_ENABLE_GROQ_FALLBACK', 'AETHEL_GROQ_MODEL_MAP', 'AETHEL_GROQ_FALLBACK_MODEL', 'GROQ_API_KEY']) {
  savedEnvironment[key] = process.env[key];
}
test.after(() => {
  global.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setTestEnvironment() {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://db.test.invalid',
    SUPABASE_SECRET_KEY: 'test-supabase-service-secret',
    OPENAI_API_KEY: '',
    GROQ_API_KEY: 'test-groq-secret',
    AETHEL_ADMIN_KEY: 'test-admin-secret',
    AETHEL_ALLOWED_MODELS: 'gpt-4o-mini',
    AETHEL_DAILY_REQUEST_LIMIT: '100',
    AETHEL_MAX_DAILY_REQUEST_LIMIT: '1000',
    AETHEL_MAX_OUTPUT_TOKENS: '4096',
    AETHEL_ENABLE_GROQ_FALLBACK: 'false',
    AETHEL_GROQ_FALLBACK_MODEL: 'llama-3.1-8b-instant',
    AETHEL_GROQ_MODEL_MAP: '{"gpt-4o-mini":"llama-3.1-8b-instant"}',
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function groqModelsResponse(ids = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']) {
  return jsonResponse({ data: ids.map(id => ({ id, active: true, context_window: 8192 })) });
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(raw) { this.body = JSON.parse(raw); return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(handler, body, headers = {}, method = 'POST') {
  const res = makeResponse();
  await handler({ method, headers, body }, res);
  return res;
}

test('calculator supports arithmetic while rejecting executable input', () => {
  assert.equal(evaluateArithmetic('(2 + 3) * 4 - 1'), 19);
  assert.throws(() => evaluateArithmetic('process.exit()'), /unsupported characters/);
  assert.throws(() => evaluateArithmetic('5 / 0'), /Division by zero/);
});

test('tool schemas include object type, properties, and required fields', () => {
  const selected = selectTools([{ type: 'function', function: { name: 'get_utc_time' } }]);
  assert.deepEqual(selected.definitions[0].function.parameters, {
    type: 'object', properties: {}, required: [], additionalProperties: false,
  });
  assert.deepEqual(selectTools().definitions, []);
});

test('Groq model router pins compatibility aliases and unknown IDs to active models', () => {
  setTestEnvironment();
  const cfg = configuration();
  assert.equal(resolveGroqModel('gpt-4o', cfg), 'llama-3.1-8b-instant');
  assert.equal(resolveGroqModel('gpt-4o-mini', cfg), 'llama-3.1-8b-instant');
  assert.equal(resolveGroqModel('unmapped-client-model', cfg), 'llama-3.1-8b-instant');
  assert.equal(resolveGroqModel('llama-3.3-70b-versatile', cfg), 'llama-3.3-70b-versatile');
  assert.equal(cfg.groqFallbackModel, 'llama-3.3-70b-versatile');
});

test('agent uses Groq without an OpenAI key, stores history and tool step output', async () => {
  setTestEnvironment();
  const storedSessions = [];
  const providerRequests = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) return groqModelsResponse();
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) {
        return jsonResponse([{ id: apiKeyId, daily_limit: 8 }]);
      }
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-123');
      if (parsed.pathname.endsWith('/agent_sessions') && (!options.method || options.method === 'GET')) return jsonResponse([]);
      if (parsed.pathname.endsWith('/agent_sessions') && options.method === 'POST') {
        storedSessions.push(JSON.parse(options.body));
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname.endsWith('/aethel_usage')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected database request ${options.method || 'GET'} ${parsed.pathname}`);
    }
    assert.equal(parsed.hostname, 'api.groq.com');
    assert.equal(options.headers.Authorization, 'Bearer test-groq-secret');
    providerRequests.push(JSON.parse(options.body));
    assert.equal(providerRequests.at(-1).model, 'llama-3.1-8b-instant');
    assert.equal(providerRequests.at(-1).max_tokens, 2048);
    assert.equal(providerRequests.at(-1).temperature, 0.7);
    if (providerRequests.length === 1) {
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
          id: 'call-1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"2+3*4"}' },
        }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    }
    return jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'The result is 14.' } }],
      usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 },
    });
  };

  const res = await invoke(agentHandler, {
    task: 'What is 2 + 3 * 4?',
    session_id: 'beta-session-1',
    tools: [{ type: 'function', function: { name: 'calculator', parameters: { type: 'object' } } }],
  }, { authorization: `Bearer ${apiToken}` });

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.output, 'The result is 14.');
  assert.equal(providerRequests.length, 2);
  assert.equal(providerRequests[0].tools[0].function.name, 'calculator');
  assert.deepEqual(providerRequests[1].messages.at(-1), {
    role: 'tool', tool_call_id: 'call-1', name: 'calculator', content: '{"result":{"result":14}}',
  });
  assert.ok(storedSessions.length >= 2);
  const finalSession = storedSessions.at(-1);
  assert.equal(finalSession.status, 'completed');
  assert.ok(finalSession.history.some(message => message.role === 'tool'));
  assert.ok(finalSession.steps.some(step => step.type === 'tool' && step.output.result === 14));
});

test('agent rejects unsupported tool names before using provider', async () => {
  setTestEnvironment();
  let called = false;
  global.fetch = async () => { called = true; throw new Error('unexpected fetch'); };
  const res = await invoke(agentHandler, {
    task: 'Browse the web',
    session_id: 'session-2',
    tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }],
  }, { authorization: `Bearer ${apiToken}` });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'unsupported_tool');
  assert.equal(called, false);
});

test('agent stops after five tool-calling iterations', async () => {
  setTestEnvironment();
  const persisted = [];
  let completions = 0;
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) return groqModelsResponse();
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 8 }]);
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-max-iterations');
      if (parsed.pathname.endsWith('/agent_sessions') && (!options.method || options.method === 'GET')) return jsonResponse([]);
      if (parsed.pathname.endsWith('/agent_sessions') && options.method === 'POST') { persisted.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); }
      if (parsed.pathname.endsWith('/aethel_usage')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected database request ${parsed.pathname}`);
    }
    completions++;
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
      id: `call-${completions}`, type: 'function', function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
    }] } }] });
  };
  const res = await invoke(agentHandler, {
    task: 'Keep calculating.', session_id: 'session-max',
    tools: [{ type: 'function', function: { name: 'calculator', parameters: { type: 'object' } } }],
  }, { authorization: `Bearer ${apiToken}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'max_iterations_reached');
  assert.equal(res.body.iterations, 5);
  assert.equal(completions, 5);
  assert.equal(persisted.at(-1).status, 'max_iterations_reached');
});

test('chat quota returns the specified 429 shape and next UTC reset time', async () => {
  setTestEnvironment();
  global.fetch = async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 1 }]);
    if (path.endsWith('/rpc/aethel_start_request')) return jsonResponse({ message: 'daily_limit_reached' }, 400);
    throw new Error(`Unexpected request ${path}`);
  };
  const res = await invoke(chatHandler, {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello' }],
  }, { authorization: `Bearer ${apiToken}` });

  assert.equal(res.statusCode, 429);
  assert.deepEqual(Object.keys(res.body).sort(), ['error', 'message', 'resets_at']);
  assert.equal(res.body.error, 'rate_limit_exceeded');
  assert.equal(res.body.message, 'Daily pilot limit reached.');
  assert.ok(Number.isFinite(Date.parse(res.body.resets_at)));
});

test('chat routes directly to Groq using the mapped model without contacting OpenAI', async () => {
  setTestEnvironment();
  let usageFinished = false;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) return groqModelsResponse();
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 10 }]);
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-fallback-1');
      if (parsed.pathname.endsWith('/aethel_usage')) { usageFinished = true; return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected database request ${parsed.pathname}`);
    }
    calls.push({ host: parsed.hostname, authorization: options.headers.Authorization, body: JSON.parse(options.body) });
    assert.equal(parsed.hostname, 'api.groq.com');
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'fallback response' } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
  };
  const res = await invoke(chatHandler, {
    model: 'unmapped-client-model', messages: [{ role: 'user', content: { text: 'hello' } }],
    temperature: 1.9, max_tokens: 9000, tools: [],
  }, { authorization: `Bearer ${apiToken}` });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aethel-provider'], 'groq');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'Bearer test-groq-secret');
  assert.equal(calls[0].body.model, 'llama-3.1-8b-instant');
  assert.equal(calls[0].body.max_tokens, 2048);
  assert.equal(calls[0].body.temperature, 0.7);
  assert.equal(calls[0].body.messages[0].content, 'hello');
  assert.equal(Object.hasOwn(calls[0].body, 'tools'), false);
  assert.equal(usageFinished, true);
});

test('agent retries a tool-enabled Groq failure without tool parameters', async () => {
  setTestEnvironment();
  const payloads = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) return groqModelsResponse();
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 8 }]);
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-tool-retry');
      if (parsed.pathname.endsWith('/agent_sessions') && (!options.method || options.method === 'GET')) return jsonResponse([]);
      if (parsed.pathname.endsWith('/agent_sessions') && options.method === 'POST') return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith('/aethel_usage')) return new Response(null, { status: 204 });
    }
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payloads.length === 1) return jsonResponse({ error: { message: 'tool mode unavailable' } }, 400);
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Plain chat fallback response.' } }] });
  };
  const res = await invoke(agentHandler, {
    task: 'Use a tool if needed.', session_id: 'tool-retry',
    tools: [{ type: 'function', function: { name: 'calculator' } }],
  }, { authorization: `Bearer ${apiToken}` });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.output, 'Plain chat fallback response.');
  assert.ok(Array.isArray(payloads[0].tools));
  assert.equal(Object.hasOwn(payloads[0].tools[0].function.parameters, 'type'), true);
  assert.equal(Object.hasOwn(payloads[0].tools[0].function.parameters, 'properties'), true);
  assert.ok(Array.isArray(payloads[0].tools[0].function.parameters.required));
  assert.equal(Object.hasOwn(payloads[1], 'tools'), false);
  assert.equal(Object.hasOwn(payloads[1], 'tool_choice'), false);
  assert.equal(payloads[1].messages[0].content, 'Use a tool if needed.');
});

test('agent returns a structured Groq provider error', async () => {
  setTestEnvironment();
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) return groqModelsResponse();
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 8 }]);
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-provider-error');
      if (parsed.pathname.endsWith('/agent_sessions') && (!options.method || options.method === 'GET')) return jsonResponse([]);
      if (parsed.pathname.endsWith('/agent_sessions') && options.method === 'POST') return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith('/aethel_usage')) return new Response(null, { status: 204 });
    }
    assert.equal(parsed.hostname, 'api.groq.com');
    return jsonResponse({ error: { message: 'model unavailable' } }, 404);
  };
  const res = await invoke(agentHandler, { task: 'hello', session_id: 'groq-error', tools: [] }, { authorization: `Bearer ${apiToken}` });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body.error, {
    code: 'provider_model_unavailable',
    message: 'The configured Groq model is unavailable.',
    provider: 'groq',
    upstream_status: 404,
    retryable: false,
  });
});

test('agent selects the first discovered Llama 3 text model when its configured model is unavailable', async () => {
  setTestEnvironment();
  const requestedModels = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) {
      assert.equal(options.headers.Authorization, 'Bearer test-groq-secret');
      return groqModelsResponse(['llama-3.3-70b-versatile', 'whisper-large-v3']);
    }
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 8 }]);
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-discovered-model');
      if (parsed.pathname.endsWith('/agent_sessions') && (!options.method || options.method === 'GET')) return jsonResponse([]);
      if (parsed.pathname.endsWith('/agent_sessions') && options.method === 'POST') return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith('/aethel_usage')) return new Response(null, { status: 204 });
    }
    requestedModels.push(JSON.parse(options.body).model);
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Discovered model response.' } }] });
  };
  const res = await invoke(agentHandler, { task: 'Hello', session_id: 'discovered-model', tools: [] }, { authorization: `Bearer ${apiToken}` });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(requestedModels, ['llama-3.3-70b-versatile']);
  assert.equal(res.body.output, 'Discovered model response.');
});

test('agent falls back to an active text chat model when the account has no Llama 3 models', async () => {
  setTestEnvironment();
  const requestedModels = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) {
      return groqModelsResponse(['openai/gpt-oss-20b', 'whisper-large-v3']);
    }
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 8 }]);
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-non-llama-model');
      if (parsed.pathname.endsWith('/agent_sessions') && (!options.method || options.method === 'GET')) return jsonResponse([]);
      if (parsed.pathname.endsWith('/agent_sessions') && options.method === 'POST') return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith('/aethel_usage')) return new Response(null, { status: 204 });
    }
    requestedModels.push(JSON.parse(options.body).model);
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Available chat model response.' } }] });
  };
  const res = await invoke(agentHandler, { task: 'Hello', session_id: 'no-llama-models', tools: [] }, { authorization: `Bearer ${apiToken}` });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(requestedModels, ['openai/gpt-oss-20b']);
  assert.equal(res.body.model, 'openai/gpt-oss-20b');
});

test('agent retries unavailable Groq model with llama-3.3-70b-versatile and logs IDs plus exact error body', async () => {
  setTestEnvironment();
  const requestedModels = [];
  const loggedErrors = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = (...args) => loggedErrors.push(args.join(' '));
  console.warn = () => {};
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.groq.com' && parsed.pathname.endsWith('/models')) return groqModelsResponse();
    if (parsed.hostname === 'db.test.invalid') {
      if (parsed.pathname.endsWith('/aethel_api_keys')) return jsonResponse([{ id: apiKeyId, daily_limit: 8 }]);
      if (parsed.pathname.endsWith('/rpc/aethel_start_request')) return jsonResponse('usage-model-fallback');
      if (parsed.pathname.endsWith('/agent_sessions') && (!options.method || options.method === 'GET')) return jsonResponse([]);
      if (parsed.pathname.endsWith('/agent_sessions') && options.method === 'POST') return new Response(null, { status: 204 });
      if (parsed.pathname.endsWith('/aethel_usage')) return new Response(null, { status: 204 });
    }
    const payload = JSON.parse(options.body);
    requestedModels.push(payload.model);
    if (requestedModels.length === 1) {
      const body = '{"error":{"message":"The model `llama-3.1-8b-instant` does not exist","type":"invalid_request_error","code":"model_not_found"}}';
      return new Response(body, { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Fallback model response.' } }] });
  };
  try {
    const res = await invoke(agentHandler, { task: 'Say hello', session_id: 'fallback-model', tools: [] }, { authorization: `Bearer ${apiToken}` });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(requestedModels, ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
    assert.equal(res.body.model, 'llama-3.3-70b-versatile');
    const apiErrorLog = loggedErrors.find(line => line.startsWith('[aethel:groq_api_error] '));
    assert.ok(apiErrorLog);
    const logPayload = JSON.parse(apiErrorLog.slice('[aethel:groq_api_error] '.length));
    assert.deepEqual(logPayload.available_model_ids, ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']);
    assert.equal(logPayload.response_body,
      '{"error":{"message":"The model `llama-3.1-8b-instant` does not exist","type":"invalid_request_error","code":"model_not_found"}}');
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }
});

test('admin top-up calls the atomic Supabase procedure and returns the new cap', async () => {
  setTestEnvironment();
  let rpcBody;
  global.fetch = async (url, options) => {
    assert.ok(new URL(url).pathname.endsWith('/rpc/aethel_topup_key'));
    rpcBody = JSON.parse(options.body);
    return jsonResponse(125);
  };
  const res = await invoke(topupHandler, { id: apiKeyId, increase_by: 25 }, { 'x-aethel-admin-key': 'test-admin-secret' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { id: apiKeyId, daily_limit: 125, status: 'increased' });
  assert.equal(rpcBody.p_increase_by, 25);
  assert.equal(rpcBody.p_reset, false);
});

test('admin top-up rejects missing admin credentials', async () => {
  setTestEnvironment();
  let called = false;
  global.fetch = async () => { called = true; throw new Error('unexpected fetch'); };
  const res = await invoke(topupHandler, { id: apiKeyId, increase_by: 10 });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test('admin top-up can restore the configured default cap', async () => {
  setTestEnvironment();
  let rpcBody;
  global.fetch = async (url, options) => {
    rpcBody = JSON.parse(options.body);
    return jsonResponse(100);
  };
  const res = await invoke(topupHandler, { id: apiKeyId, reset: true }, { 'x-aethel-admin-key': 'test-admin-secret' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.daily_limit, 100);
  assert.equal(res.body.status, 'reset');
  assert.equal(rpcBody.p_reset, true);
  assert.equal(rpcBody.p_increase_by, 0);
});
