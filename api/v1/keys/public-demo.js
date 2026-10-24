const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { configuration, send, fail, database, hash, quotaResetsAt } = require('../../_lib/gateway');

const DEMO_DAILY_LIMIT = 20;
const MAX_ISSUES_PER_IP_PER_DAY = 3;
const KEY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'method_not_allowed', 'Use POST to request a pilot demo key.');
  }

  const cfg = configuration();
  if (!cfg.supabaseUrl || !cfg.supabaseKey) {
    return fail(res, 503, 'setup_required', 'The demo key service is waiting for database configuration.');
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return fail(res, 403, 'origin_not_allowed', 'Request the demo key from the Aethel AI website.');
    } catch (_) {
      return fail(res, 403, 'origin_not_allowed', 'Request the demo key from the Aethel AI website.');
    }
  }

  const forwarded = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
  const clientIp = String(forwarded).split(',')[0].trim();
  if (!clientIp || !isIP(clientIp)) {
    return fail(res, 503, 'client_ip_unavailable', 'The demo key service could not determine your network address.');
  }

  const key = `aethel_live_${crypto.randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + KEY_LIFETIME_MS).toISOString();
  const ipHash = crypto.createHmac('sha256', cfg.supabaseKey).update(`aethel-demo-ip:${clientIp}`).digest('hex');
  try {
    const id = await database('rpc/aethel_issue_demo_key', {
      method: 'POST',
      body: JSON.stringify({
        p_key_hash: hash(key),
        p_ip_hash: ipHash,
        p_daily_limit: DEMO_DAILY_LIMIT,
        p_max_issues: MAX_ISSUES_PER_IP_PER_DAY,
        p_expires_at: expiresAt,
      }),
    });
    if (typeof id !== 'string') return fail(res, 503, 'key_creation_failed', 'The demo key could not be created. Apply the public demo key migration.');
    return send(res, 201, {
      api_key: key,
      daily_limit: DEMO_DAILY_LIMIT,
      expires_at: expiresAt,
      warning: 'This key is shown once, expires in seven days, and is limited to 20 requests per day.',
    });
  } catch (error) {
    if (error.detail?.includes('public_demo_limit_reached')) {
      return send(res, 429, {
        error: 'demo_key_rate_limited',
        message: 'The daily pilot-key request limit for this network has been reached. Try again tomorrow.',
        resets_at: quotaResetsAt(),
      });
    }
    if (error.detail?.includes('invalid_demo_key_configuration')) {
      return fail(res, 503, 'invalid_demo_key_configuration', 'The public demo key limits are misconfigured.');
    }
    if (error.detail?.includes('aethel_issue_demo_key')) {
      return fail(res, 503, 'setup_required', 'Apply the public demo key migration before issuing demo keys.');
    }
    return fail(res, 503, 'service_unavailable', 'The demo key service is temporarily unavailable.');
  }
};
