const { configuration, send, fail, database, bearer, hash, quotaResetsAt, startUsage, finishUsage } = require('../../_lib/gateway');

const allowedFields = ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'response_format', 'tools', 'tool_choice', 'parallel_tool_calls', 'seed'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'method_not_allowed', 'Use POST to create a chat completion.');
  }
  const cfg = configuration();
  const key = bearer(req);
  if (!key) return fail(res, 401, 'unauthorized', 'Provide an Aethel API key as a Bearer token.');
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !cfg.providerKey) {
    return fail(res, 503, 'setup_required', 'The gateway is waiting for its database and inference provider configuration.');
  }
  const length = Number(req.headers['content-length'] || 0);
  if (length > 65536) return fail(res, 413, 'request_too_large', 'Requests must be smaller than 64 KB.');
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(res, 400, 'invalid_request', 'Send a JSON request body.');
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 65536) return fail(res, 413, 'request_too_large', 'Requests must be smaller than 64 KB.');
  if (input.stream === true) return fail(res, 400, 'streaming_not_supported', 'Streaming is not available in this gateway release.');
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined) {
    return fail(res, 400, 'invalid_token_limit', 'Provide only one output token limit field.');
  }
  const requestedTokenLimit = input.max_completion_tokens ?? input.max_tokens;
  if (requestedTokenLimit !== undefined && (!Number.isInteger(requestedTokenLimit) || requestedTokenLimit < 1 || requestedTokenLimit > cfg.maxOutputTokens)) {
    return fail(res, 400, 'invalid_token_limit', `The output token limit must be between 1 and ${cfg.maxOutputTokens}.`);
  }
  if (typeof input.model !== 'string' || !cfg.models.includes(input.model)) {
    return fail(res, 400, 'model_not_allowed', `Choose one of the enabled models: ${cfg.models.join(', ')}.`);
  }
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 50) {
    return fail(res, 400, 'invalid_messages', 'Provide between 1 and 50 chat messages.');
  }
  for (const message of input.messages) {
    if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || message.content == null) {
      return fail(res, 400, 'invalid_messages', 'Each message needs a supported role and content.');
    }
  }

  let apiKeyRow;
  try {
    let rows;
    try {
      rows = await database(`aethel_api_keys?key_hash=eq.${hash(key)}&disabled_at=is.null&select=id,name,daily_limit&limit=1`);
    } catch (error) {
      // Keep chat serving during the deployment window before the beta migration is applied.
      if (!error.detail?.includes('daily_limit')) throw error;
      rows = await database(`aethel_api_keys?key_hash=eq.${hash(key)}&disabled_at=is.null&select=id,name&limit=1`);
    }
    apiKeyRow = rows?.[0];
  } catch (_) {
    return fail(res, 503, 'service_unavailable', 'The key service is temporarily unavailable.');
  }
  if (!apiKeyRow) return fail(res, 401, 'unauthorized', 'This API key is invalid or disabled.');

  const dailyLimit = Number.isInteger(apiKeyRow.daily_limit) ? apiKeyRow.daily_limit : cfg.dailyLimit;
  let usageId;
  try {
    usageId = await startUsage(apiKeyRow.id, input.model, dailyLimit);
  } catch (error) {
    if (error.detail?.includes('daily_limit_reached')) {
      return send(res, 429, {
        error: 'rate_limit_exceeded',
        message: 'Daily pilot limit reached.',
        resets_at: quotaResetsAt(),
      });
    }
    return fail(res, 503, 'service_unavailable', 'Usage metering is temporarily unavailable.');
  }

  const actualModel = cfg.groqModelMap[input.model] || input.model;
  const payload = { model: actualModel, messages: input.messages };
  for (const field of allowedFields) if (input[field] !== undefined) payload[field] = input[field];
  if (input.max_tokens !== undefined) payload.max_tokens = input.max_tokens;
  else payload.max_completion_tokens = input.max_completion_tokens ?? cfg.maxOutputTokens;
  const provider = 'groq';
  let attempt = await requestProvider(cfg.providerUrl, cfg.providerKey, payload);
  if (attempt.networkError) {
    try { await finishUsage(usageId, 'failed', null); } catch (_) { /* Keep the upstream failure response safe. */ }
    return res.status(502).json({ error: { code: 'provider_unavailable', message: 'Groq could not be reached. Retry the request.', provider: 'groq', retryable: true } });
  }

  if (!attempt.response.ok || !attempt.result) {
    try { await finishUsage(usageId, 'failed', null); } catch (_) { /* Keep provider errors safe. */ }
    res.setHeader('X-Aethel-Provider', 'groq');
    res.setHeader('X-Aethel-Upstream-Status', String(attempt.response.status));
    const status = attempt.response.status === 429 ? 429 : 502;
    const code = status === 429 ? 'provider_rate_limited' : attempt.response.status === 401 || attempt.response.status === 403 ? 'provider_auth_failed' : attempt.response.status === 404 ? 'provider_model_unavailable' : 'provider_error';
    const message = status === 429 ? 'Groq is rate limiting this request. Retry shortly.' : code === 'provider_auth_failed' ? 'Groq rejected the configured provider credentials.' : code === 'provider_model_unavailable' ? 'The configured Groq model is unavailable.' : 'Groq could not complete the inference request.';
    return res.status(status).json({ error: { code, message, provider: 'groq', upstream_status: attempt.response.status, retryable: status === 429 || attempt.response.status >= 500 } });
  }
  try {
    await finishUsage(usageId, 'succeeded', attempt.result.usage || null, actualModel);
  } catch (_) {
    return fail(res, 503, 'usage_record_failed', 'The provider completed this request, but usage could not be saved. It may have been billed; check provider usage before retrying.');
  }
  res.setHeader('X-Aethel-Usage-Id', usageId);
  res.setHeader('X-Aethel-Provider', provider);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(attempt.result);
};

async function requestProvider(baseUrl, apiKey, payload) {
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch (_) { result = null; }
    return { response, result, networkError: false };
  } catch (_) {
    return { response: null, result: null, networkError: true };
  }
}
