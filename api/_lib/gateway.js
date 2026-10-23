const crypto = require('node:crypto');

function configuration() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, ''),
    supabaseKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    providerKey: process.env.OPENAI_API_KEY,
    providerUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    models: (process.env.AETHEL_ALLOWED_MODELS || 'gpt-4o-mini').split(',').map(x => x.trim()).filter(Boolean),
    dailyLimit: Math.max(1, Number.parseInt(process.env.AETHEL_DAILY_REQUEST_LIMIT || '100', 10) || 100),
    maxOutputTokens: Math.max(1, Number.parseInt(process.env.AETHEL_MAX_OUTPUT_TOKENS || '2048', 10) || 2048),
  };
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

module.exports = { configuration, send, fail, database, bearer, hash, safeEqual };
