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

  const payload = { model: input.model, messages: input.messages };
  for (const field of allowedFields) if (input[field] !== undefined) payload[field] = input[field];
  if (input.max_tokens !== undefined) payload.max_tokens = input.max_tokens;
  else payload.max_completion_tokens = input.max_completion_tokens ?? cfg.maxOutputTokens;
  let provider = 'openai';
  let actualModel = input.model;
  let attempt = await requestProvider(cfg.providerUrl, cfg.providerKey, payload);
  if (attempt.networkError) {
    try { await finishUsage(usageId, 'failed', null); } catch (_) { /* Keep the upstream failure response safe. */ }
    return fail(res, 502, 'provider_unavailable', 'The inference provider did not respond. Retry the request.');
  }

  const groqModel = cfg.groqModelMap[input.model];
  if (attempt.response.status === 429 && cfg.groqFallbackEnabled && cfg.groqKey && groqModel) {
    const fallbackPayload = { ...payload, model: groqModel };
    const fallback = await requestProvider('https://api.groq.com/openai/v1', cfg.groqKey, fallbackPayload);
    if (!fallback.networkError && fallback.response.ok && fallback.result) {
      attempt = fallback;
      provider = 'groq';
      actualModel = groqModel;
      attempt.result.model = groqModel;
    } else {
      try { await finishUsage(usageId, 'failed', null, input.model); } catch (_) { /* Keep provider errors safe. */ }
      if (fallback.networkError) return fail(res, 502, 'fallback_unavailable', 'The primary provider was rate limited and the fallback provider did not respond.');
      if (fallback.response.status === 429) return fail(res, 429, 'providers_rate_limited', 'The primary and fallback providers are rate limited. Retry later.');
      res.setHeader('X-Aethel-Provider', 'groq');
      res.setHeader('X-Aethel-Upstream-Status', String(fallback.response.status));
      if (fallback.response.status === 401 || fallback.response.status === 403) {
        return fail(res, 502, 'fallback_auth_failed', 'The fallback provider rejected its configured credentials.');
      }
      if (fallback.response.status === 404) {
        return fail(res, 502, 'fallback_model_unavailable', 'The configured fallback model is unavailable from the fallback provider.');
      }
      return fail(res, 502, 'fallback_provider_error', 'The primary provider was rate limited and the fallback provider could not complete this request.');
    }
  }

  if (!attempt.response.ok || !attempt.result) {
    try { await finishUsage(usageId, 'failed', null); } catch (_) { /* Keep provider errors safe. */ }
    if (attempt.response.status === 429) return fail(res, 429, 'provider_rate_limited', 'The configured inference provider is rate limited. Retry later or configure additional capacity.');
    res.setHeader('X-Aethel-Provider', 'openai');
    res.setHeader('X-Aethel-Upstream-Status', String(attempt.response.status));
    if (attempt.response.status === 401 || attempt.response.status === 403) {
      return fail(res, 502, 'provider_auth_failed', 'The primary inference provider rejected its configured credentials.');
    }
    if (attempt.response.status === 404) {
      return fail(res, 502, 'provider_model_unavailable', 'The primary inference provider could not find the configured model.');
    }
    return fail(res, 502, 'provider_error', 'The configured inference provider could not complete this request.');
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
