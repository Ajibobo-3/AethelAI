const {
  configuration, resolveGroqModel, send, fail, database, bearer, hash, quotaResetsAt, startUsage, finishUsage,
} = require('../../_lib/gateway');
const { selectTools, executeTool } = require('../../_lib/agent-tools');

const MAX_ITERATIONS = 5;
const MAX_HISTORY_BYTES = 512 * 1024;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'method_not_allowed', 'Use POST to run an agent task.');
  }
  const cfg = configuration();
  const apiKey = bearer(req);
  if (!apiKey) return fail(res, 401, 'unauthorized', 'Provide an Aethel API key as a Bearer token.');
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !cfg.providerKey) {
    return fail(res, 503, 'setup_required', 'The agent is waiting for its database and inference provider configuration.');
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'invalid_request', 'Send a JSON request body.');
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > 65536) return fail(res, 413, 'request_too_large', 'Requests must be smaller than 64 KB.');
  const task = typeof body.task === 'string' ? body.task.trim() : '';
  const sessionId = body.session_id;
  if (!task || task.length > 8000) return fail(res, 400, 'invalid_task', 'Provide a task from 1 to 8,000 characters.');
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(sessionId)) {
    return fail(res, 400, 'invalid_session_id', 'Provide a session_id of 1 to 100 letters, numbers, dots, underscores, colons, or hyphens.');
  }
  let selectedTools;
  try { selectedTools = selectTools(body.tools ?? []); }
  catch (error) {
    const code = error.message === 'unsupported_tool' ? 'unsupported_tool' : 'invalid_tools';
    return fail(res, 400, code, 'Tools must be unique supported function definitions. Available tools: calculator and get_utc_time.');
  }

  let keyRow;
  try {
    const rows = await database(`aethel_api_keys?key_hash=eq.${hash(apiKey)}&disabled_at=is.null&select=id,daily_limit&limit=1`);
    keyRow = rows?.[0];
  } catch (_) {
    return fail(res, 503, 'service_unavailable', 'The key service is temporarily unavailable.');
  }
  if (!keyRow) return fail(res, 401, 'unauthorized', 'This API key is invalid or disabled.');

  const discovery = await discoverGroqModels(cfg);
  if (!discovery.ok) {
    return send(res, 502, { error: { code: 'model_discovery_failed', message: 'Could not verify Groq model availability.', provider: 'groq', upstream_status: discovery.status || null, retryable: true } });
  }
  if (discovery.activeModels.length === 0) {
    console.error('[aethel:groq_no_supported_chat_models]', JSON.stringify({ available_model_ids: discovery.modelIds }));
    return send(res, 503, { error: { code: 'no_supported_models', message: 'Groq returned no active text chat models for this account.', provider: 'groq', retryable: false } });
  }
  const requestedModel = resolveGroqModel(cfg.models[0] || 'llama-3.1-8b-instant', cfg);
  const model = discovery.activeModels.includes(requestedModel) ? requestedModel : discovery.activeModels[0];
  if (model !== requestedModel) {
    console.info('[aethel:groq_model_selected_from_discovery]', JSON.stringify({ requested_model: requestedModel, selected_model: model, available_model_ids: discovery.modelIds }));
  }

  let usageId;
  try {
    usageId = await startUsage(keyRow.id, model, keyRow.daily_limit || cfg.dailyLimit);
  } catch (error) {
    if (error.detail?.includes('daily_limit_reached')) {
      return send(res, 429, { error: 'rate_limit_exceeded', message: 'Daily pilot limit reached.', resets_at: quotaResetsAt() });
    }
    return fail(res, 503, 'service_unavailable', 'Usage metering is temporarily unavailable.');
  }

  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let session;
  try {
    const rows = await database(`agent_sessions?key_id=eq.${encodeURIComponent(keyRow.id)}&session_id=eq.${encodeURIComponent(sessionId)}&select=history,steps`);
    session = rows?.[0] || { history: [], steps: [] };
    if (!Array.isArray(session.history) || !Array.isArray(session.steps)) throw new Error('INVALID_SESSION_DATA');
    const history = session.history.map(normalizeHistoryMessage);
    const allSteps = session.steps;
    if (Buffer.byteLength(JSON.stringify(history), 'utf8') > MAX_HISTORY_BYTES) {
      await finishUsage(usageId, 'failed', usage);
      return fail(res, 413, 'session_too_large', 'This session history is too large to continue. Start a new session.');
    }
    history.push({ role: 'user', content: task });

    const persist = async status => {
      if (Buffer.byteLength(JSON.stringify(history), 'utf8') > MAX_HISTORY_BYTES) throw new Error('SESSION_TOO_LARGE');
      await database('agent_sessions?on_conflict=key_id,session_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          key_id: keyRow.id,
          session_id: sessionId,
          history,
          steps: allSteps.slice(-500),
          status,
          updated_at: new Date().toISOString(),
        }),
      });
    };
    await persist('running');

    let completedOutput = null;
    let completed = false;
    let lastProvider = 'groq';
    let lastModel = model;
    const runSteps = [];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const payload = {
        model,
        messages: history,
        max_tokens: Math.min(cfg.maxOutputTokens, 2048),
        temperature: 0.7,
      };
      if (selectedTools.definitions.length) {
        payload.tools = selectedTools.definitions;
        payload.tool_choice = 'auto';
      }
      const routed = await requestWithPlainChatFallback(cfg, payload, discovery.activeModels);
      lastProvider = routed.provider;
      lastModel = routed.model;
      if (routed.networkError) {
        await finishUsage(usageId, 'failed', usage, lastModel);
        await persist('failed');
        return send(res, 502, { error: { code: 'provider_unavailable', message: 'Groq could not be reached. Retry the request.', provider: 'groq', retryable: true } });
      }
      if (!routed.response.ok || !routed.result) {
        await finishUsage(usageId, 'failed', usage, lastModel);
        await persist('failed');
        res.setHeader('X-Aethel-Provider', routed.provider);
        res.setHeader('X-Aethel-Upstream-Status', String(routed.response.status));
        if (routed.response.status === 429) return send(res, 429, { error: { code: 'provider_rate_limited', message: 'Groq is rate limiting this request. Retry shortly.', provider: 'groq', upstream_status: 429, retryable: true } });
        if (routed.response.status === 401 || routed.response.status === 403) return send(res, 502, { error: { code: 'provider_auth_failed', message: 'Groq rejected the configured provider credentials.', provider: 'groq', upstream_status: routed.response.status, retryable: false } });
        if (routed.response.status === 404) return send(res, 502, { error: { code: 'provider_model_unavailable', message: 'The configured Groq model is unavailable.', provider: 'groq', upstream_status: 404, retryable: false } });
        return send(res, 502, { error: { code: 'provider_error', message: 'Groq could not complete the inference request.', provider: 'groq', upstream_status: routed.response.status, retryable: routed.response.status >= 500 } });
      }

      const modelUsage = routed.result.usage || {};
      for (const field of Object.keys(usage)) usage[field] += Number.isInteger(modelUsage[field]) ? modelUsage[field] : 0;
      const assistant = routed.result.choices?.[0]?.message;
      if (!assistant || typeof assistant !== 'object') {
        await finishUsage(usageId, 'failed', usage, lastModel);
        await persist('failed');
        return fail(res, 502, 'invalid_provider_response', 'The inference provider returned an unsupported response.');
      }
      const assistantMessage = {
        role: 'assistant',
        content: typeof assistant.content === 'string' ? assistant.content : null,
      };
      if (Array.isArray(assistant.tool_calls) && assistant.tool_calls.length) assistantMessage.tool_calls = assistant.tool_calls;
      history.push(assistantMessage);
      const assistantStep = {
        iteration: iteration + 1,
        type: 'assistant',
        content: assistantMessage.content,
        tool_calls: assistantMessage.tool_calls || [],
        provider: routed.provider,
        model: routed.model,
        created_at: new Date().toISOString(),
      };
      allSteps.push(assistantStep);
      runSteps.push(assistantStep);

      if (!Array.isArray(assistantMessage.tool_calls) || assistantMessage.tool_calls.length === 0) {
        completedOutput = assistantMessage.content;
        completed = true;
        await persist('completed');
        await finishUsage(usageId, 'succeeded', usage, lastModel);
        res.setHeader('X-Aethel-Provider', lastProvider);
        res.setHeader('X-Aethel-Usage-Id', usageId);
        return send(res, 200, {
          session_id: sessionId,
          status: 'completed',
          iterations: iteration + 1,
          output: completedOutput,
          steps: runSteps,
          model: lastModel,
        });
      }

      for (const call of assistantMessage.tool_calls) {
        const functionName = call?.function?.name;
        const callId = typeof call?.id === 'string' ? call.id : '';
        let content;
        let result;
        try {
          if (!callId || !selectedTools.names.has(functionName)) throw new Error('The model requested a tool that is not enabled for this run.');
          if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 4096) throw new Error('Tool arguments exceed the supported size.');
          result = executeTool(functionName, JSON.parse(call.function.arguments));
          content = JSON.stringify({ result });
        } catch (error) {
          content = JSON.stringify({ error: error instanceof SyntaxError ? 'Tool arguments were not valid JSON.' : error.message });
          result = { error: error instanceof SyntaxError ? 'Tool arguments were not valid JSON.' : error.message };
        }
        history.push({ role: 'tool', tool_call_id: callId || `invalid-${iteration}`, name: functionName || 'unknown', content });
        const toolStep = {
          iteration: iteration + 1,
          type: 'tool',
          name: functionName || 'unknown',
          arguments: call.function?.arguments || '',
          output: result,
          created_at: new Date().toISOString(),
        };
        allSteps.push(toolStep);
        runSteps.push(toolStep);
      }
      await persist(iteration + 1 === MAX_ITERATIONS ? 'max_iterations_reached' : 'running');
    }

    if (!completed) {
      await finishUsage(usageId, 'succeeded', usage, lastModel);
      res.setHeader('X-Aethel-Provider', lastProvider);
      res.setHeader('X-Aethel-Usage-Id', usageId);
      return send(res, 200, {
        session_id: sessionId,
        status: 'max_iterations_reached',
        iterations: MAX_ITERATIONS,
        output: completedOutput,
        steps: runSteps,
        model: lastModel,
      });
    }
  } catch (error) {
    try { await finishUsage(usageId, 'failed', usage); } catch (_) { /* Preserve the safe error below. */ }
    if (error.message === 'SESSION_TOO_LARGE') return fail(res, 413, 'session_too_large', 'This session history reached its storage limit. Start a new session.');
    return fail(res, 503, 'service_unavailable', 'The agent session could not be stored. Check the beta database migration.');
  }
};

async function requestGroq(cfg, payload, availableModels) {
  const primary = await requestProvider(cfg.providerUrl, cfg.providerKey, payload);
  if (!primary.networkError && !primary.response.ok) logGroqError(payload.model, primary, availableModels);
  if (primary.networkError || !isModelUnavailable(primary)) {
    return { ...primary, provider: 'groq', model: payload.model };
  }

  const fallbackModel = availableModels.includes(cfg.groqFallbackModel) && cfg.groqFallbackModel !== payload.model
    ? cfg.groqFallbackModel
    : availableModels.find(candidate => candidate !== payload.model) || cfg.groqFallbackModel;
  console.warn('[aethel:groq_model_fallback]', JSON.stringify({
    primary_model: payload.model,
    fallback_model: fallbackModel,
    upstream_status: primary.response.status,
    available_model_ids: availableModels,
  }));
  const fallback = await requestProvider(cfg.providerUrl, cfg.providerKey, { ...payload, model: fallbackModel });
  if (!fallback.networkError && !fallback.response.ok) logGroqError(fallbackModel, fallback, availableModels);
  return { ...fallback, provider: 'groq', model: fallbackModel };
}

async function requestWithPlainChatFallback(cfg, payload, availableModels) {
  const first = await requestGroq(cfg, payload, availableModels);
  if (!payload.tools?.length || (!first.networkError && first.response?.ok && first.result)) return first;

  console.warn('[aethel:groq_tool_call_fallback]', JSON.stringify({
    model: first.model,
    upstream_status: first.response?.status || null,
    network_error: Boolean(first.networkError),
  }));
  const plainPayload = { ...payload };
  delete plainPayload.tools;
  delete plainPayload.tool_choice;
  return requestGroq(cfg, plainPayload, availableModels);
}

function normalizeHistoryMessage(message) {
  if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
    throw new Error('INVALID_SESSION_DATA');
  }
  const normalized = { ...message, content: plainText(message.content) };
  if (message.role !== 'assistant') delete normalized.tool_calls;
  return normalized;
}

function plainText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    return Object.values(value).map(plainText).filter(Boolean).join('\n');
  }
  return '';
}

function isModelUnavailable(attempt) {
  if (attempt.response?.status === 404) return true;
  const error = attempt.result?.error;
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  const modelError = ['model_not_found', 'model_unavailable', 'model_decommissioned'].includes(code)
    || /model.{0,30}(not found|unavailable|decommissioned)|(?:not found|unavailable).{0,30}model/.test(message);
  return modelError || (attempt.response?.status === 400 && /model/.test(message));
}

function logGroqError(model, attempt, availableModels = []) {
  console.error('[aethel:groq_api_error]', JSON.stringify({
    provider: 'groq',
    model,
    status: attempt.response.status,
    response_body: attempt.errorBody,
    available_model_ids: availableModels,
  }));
}

async function discoverGroqModels(cfg) {
  try {
    const response = await fetch(`${cfg.providerUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.providerKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    let result;
    try { result = JSON.parse(body); } catch (_) { result = null; }
    if (!response.ok || !Array.isArray(result?.data)) {
      console.error('[aethel:groq_model_discovery_error]', JSON.stringify({ status: response.status, response_body: body }));
      return { ok: false, status: response.status, modelIds: [], activeModels: [] };
    }
    const records = result.data.filter(model => typeof model?.id === 'string');
    const modelIds = records.map(model => model.id);
    const activeRecords = records.filter(model => model.active !== false);
    const isTextChatModel = model => Number(model.context_window) > 0
      && !/(whisper|speech|audio|transcri|tts|guard|embed|rerank|moderation|vision|image)/i.test(model.id);
    const llamaModels = activeRecords
      .filter(model => /^llama-3\.\d+-\d+b-(?:instant|versatile)$/.test(model.id))
      .map(model => model.id);
    const productionTextModels = activeRecords.filter(isTextChatModel).map(model => model.id);
    if (!llamaModels.length) {
      console.warn('[aethel:groq_no_llama_models_using_active_text_model]', JSON.stringify({
        available_model_ids: modelIds,
        eligible_text_model_ids: productionTextModels,
      }));
    }
    return { ok: true, modelIds, activeModels: llamaModels.length ? llamaModels : productionTextModels };
  } catch (error) {
    console.error('[aethel:groq_model_discovery_error]', JSON.stringify({ message: error?.message || 'Groq model discovery failed.' }));
    return { ok: false, status: null, modelIds: [], activeModels: [] };
  }
}

async function requestProvider(baseUrl, apiKey, payload) {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000),
    });
    const errorBody = await response.text();
    let result;
    try { result = JSON.parse(errorBody); } catch (_) { result = null; }
    return { response, result, errorBody, networkError: false };
  } catch (_) {
    return { response: null, result: null, networkError: true };
  }
}
