const crypto = require('node:crypto');
const { configuration, send, fail, database, hash, safeEqual } = require('../_lib/gateway');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'method_not_allowed', 'Use POST to create an API key.');
  }
  const adminKey = process.env.AETHEL_ADMIN_KEY;
  if (!adminKey || !safeEqual(req.headers['x-aethel-admin-key'], adminKey)) {
    return fail(res, 401, 'unauthorized', 'A valid admin key is required.');
  }
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return fail(res, 400, 'invalid_name', 'Provide a key name up to 80 characters.');
  const cfg = configuration();
  if (cfg.dailyLimit > cfg.maxDailyLimit) return fail(res, 503, 'invalid_limit_configuration', 'The configured default daily limit exceeds the configured maximum.');

  const key = `aethel_live_${crypto.randomBytes(32).toString('base64url')}`;
  try {
    let rows;
    try {
      rows = await database('aethel_api_keys', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ key_hash: hash(key), name, daily_limit: cfg.dailyLimit }),
      });
    } catch (error) {
      // Preserve key creation during deployment before the beta migration lands.
      if (!error.detail?.includes('daily_limit')) throw error;
      rows = await database('aethel_api_keys', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ key_hash: hash(key), name }),
      });
    }
    const id = Array.isArray(rows) ? rows[0]?.id : undefined;
    if (!id) return fail(res, 503, 'key_creation_failed', 'The key could not be created. Check the database migration.');
    return send(res, 201, { id, name, api_key: key, warning: 'Copy this key now. It cannot be shown again.' });
  } catch (_) {
    return fail(res, 503, 'service_unavailable', 'The key service is not ready. Check the database configuration.');
  }
};
