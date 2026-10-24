const test = require('node:test');
const assert = require('node:assert/strict');
const chatHandler = require('../api/v1/chat/completions');
const agentHandler = require('../api/v1/agent/run');
const topupHandler = require('../api/v1/keys/topup');
const { evaluateArithmetic } = require('../api/_lib/agent-tools');

const apiToken = `aethel_live_${'a'.repeat(40)}`;
const apiKeyId = 'f0ad8b80-335f-4a6b-a62e-98c81dbe12c8';
const originalFetch = global.fetch;
const savedEnvironment = {};
for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AETHEL_ADMIN_KEY', 'AETHEL_ALLOWED_MODELS', 'AETHEL_DAILY_REQUEST_LIMIT', 'AETHEL_MAX_DAILY_REQUEST_LIMIT', 'AETHEL_ENABLE_GROQ_FALLBACK', 'AETHEL_GROQ_MODEL_MAP', 'AETHEL_GROQ_FALLBACK_MODEL', 'GROQ_API_KEY']) {
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
    AETHEL_ENABLE_GROQ_FALLBACK: 'false',
    AETHEL_GROQ_FALLBACK_MODEL: 'llama3-8b-8192',
    AETHEL_GROQ_MODEL_MAP: '{"gpt-4o-mini":"openai/gpt-oss-20b"}',
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

test('agent uses Groq without an OpenAI key, stores history and tool step output', async () => {
  setTestEnvironment();
  const storedSessions = [];
  const providerRequests = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
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
    assert.equal(providerRequests.at(-1).model, 'llama-3.3-70b-versatile');
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
    model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }],
  }, { authorization: `Bearer ${apiToken}` });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aethel-provider'], 'groq');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authorization, 'Bearer test-groq-secret');
  assert.equal(calls[0].body.model, 'llama-3.3-70b-versatile');
  assert.equal(usageFinished, true);
});

test('agent returns a structured Groq provider error', async () => {
  setTestEnvironment();
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
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

test('agent retries unavailable Groq model with llama3-8b-8192 and logs the exact error body', async () => {
  setTestEnvironment();
  const requestedModels = [];
  const loggedErrors = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  console.error = (...args) => loggedErrors.push(args.join(' '));
  console.warn = () => {};
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
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
      const body = '{"error":{"message":"The model `llama-3.3-70b-versatile` does not exist","type":"invalid_request_error","code":"model_not_found"}}';
      return new Response(body, { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Fallback model response.' } }] });
  };
  try {
    const res = await invoke(agentHandler, { task: 'Say hello', session_id: 'fallback-model', tools: [] }, { authorization: `Bearer ${apiToken}` });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(requestedModels, ['llama-3.3-70b-versatile', 'llama3-8b-8192']);
    assert.equal(res.body.model, 'llama3-8b-8192');
    const apiErrorLog = loggedErrors.find(line => line.startsWith('[aethel:groq_api_error] '));
    assert.ok(apiErrorLog);
    assert.equal(JSON.parse(apiErrorLog.slice('[aethel:groq_api_error] '.length)).response_body,
      '{"error":{"message":"The model `llama-3.3-70b-versatile` does not exist","type":"invalid_request_error","code":"model_not_found"}}');
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
