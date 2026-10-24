const crypto = require('node:crypto');

function configuration() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    providerKey: process.env.OPENAI_API_KEY,
    providerUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    groqKey: process.env.GROQ_API_KEY,
    groqFallbackEnabled: /^true$/i.test((process.env.AETHEL_ENABLE_GROQ_FALLBACK || '').trim()),
    groqModelMap: parseGroqModelMap(process.env.AETHEL_GROQ_MODEL_MAP),
    models: (process.env.AETHEL_ALLOWED_MODELS || 'gpt-4o-mini').split(',').map(x => x.trim()).filter(Boolean),
    dailyLimit: Math.max(1, Number.parseInt(process.env.AETHEL_DAILY_REQUEST_LIMIT || '100', 10) || 100),
    maxDailyLimit: Math.max(1, Number.parseInt(process.env.AETHEL_MAX_DAILY_REQUEST_LIMIT || '10000', 10) || 10000),
    maxOutputTokens: Math.max(1, Number.parseInt(process.env.AETHEL_MAX_OUTPUT_TOKENS || '2048', 10) || 2048),
  };
}

function parseGroqModelMap(value) {
  const defaultMap = { 'gpt-4o-mini': 'openai/gpt-oss-20b' };
  if (!value) return defaultMap;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return defaultMap;
    const overrides = Object.fromEntries(Object.entries(parsed).filter(([from, to]) =>
      typeof from === 'string' && from.length > 0 && typeof to === 'string' && to.length > 0
    ));
    return { ...defaultMap, ...overrides };
  } catch {
    return defaultMap;
  }
}

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message) {
  send(res, status, { error: { code, message } });
}

async function database(path, options = {}) {
  const cfg = configuration();
  if (!cfg.supabaseUrl || !cfg.supabaseKey) throw new Error('DATABASE_NOT_CONFIGURED');
  const response = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: cfg.supabaseKey,
      Authorization: `Bearer ${cfg.supabaseKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error('DATABASE_REQUEST_FAILED');
    error.status = response.status;
    error.detail = text;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

function bearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer (aethel_live_[A-Za-z0-9_-]{30,})$/.exec(header);
  return match && match[1];
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function quotaResetsAt(now = new Date()) {
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return reset.toISOString();
}

async function startUsage(keyId, model, dailyLimit) {
  const usageId = await database('rpc/aethel_start_request', {
    method: 'POST',
    body: JSON.stringify({ p_key_id: keyId, p_model: model, p_daily_limit: dailyLimit }),
  });
  if (typeof usageId !== 'string') throw new Error('REQUEST_NOT_CLAIMED');
  return usageId;
}

async function finishUsage(id, status, usage, model) {
  const body = {
    status,
    prompt_tokens: Number.isInteger(usage?.prompt_tokens) ? usage.prompt_tokens : 0,
    completion_tokens: Number.isInteger(usage?.completion_tokens) ? usage.completion_tokens : 0,
    total_tokens: Number.isInteger(usage?.total_tokens) ? usage.total_tokens : 0,
    completed_at: new Date().toISOString(),
  };
  if (model) body.model = model;
  await database(`aethel_usage?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
}

module.exports = { configuration, send, fail, database, bearer, hash, safeEqual, quotaResetsAt, startUsage, finishUsage };
