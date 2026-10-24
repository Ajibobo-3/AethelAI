const { configuration, send, fail, database, safeEqual } = require('../../_lib/gateway');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'method_not_allowed', 'Use POST to increase or reset a key daily limit.');
  }
  const adminKey = process.env.AETHEL_ADMIN_KEY;
  if (!adminKey || !safeEqual(req.headers['x-aethel-admin-key'], adminKey)) {
    return fail(res, 401, 'unauthorized', 'A valid admin key is required.');
  }
  const { id, increase_by: increaseBy, reset } = req.body || {};
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return fail(res, 400, 'invalid_id', 'Provide a valid API key ID.');
  }
  if (reset !== true && (!Number.isInteger(increaseBy) || increaseBy < 1)) {
    return fail(res, 400, 'invalid_topup', 'Provide a positive increase_by value or set reset to true.');
  }
  if (reset === true && increaseBy !== undefined) {
    return fail(res, 400, 'invalid_topup', 'Choose either increase_by or reset, not both.');
  }

  const cfg = configuration();
  if (cfg.maxDailyLimit < cfg.dailyLimit) return fail(res, 503, 'invalid_limit_configuration', 'The configured maximum daily limit is below the default limit.');
  try {
    const nextLimit = await database('rpc/aethel_topup_key', {
      method: 'POST',
      body: JSON.stringify({
        p_key_id: id,
        p_increase_by: increaseBy || 0,
        p_reset: reset === true,
        p_default_limit: cfg.dailyLimit,
        p_max_limit: cfg.maxDailyLimit,
      }),
    });
    if (!Number.isInteger(nextLimit)) return fail(res, 503, 'topup_failed', 'The daily limit could not be updated. Apply the beta migration.');
    return send(res, 200, { id, daily_limit: nextLimit, status: reset ? 'reset' : 'increased' });
  } catch (error) {
    if (error.detail?.includes('key_not_found')) return fail(res, 404, 'key_not_found', 'No active key matched that ID.');
    if (error.detail?.includes('daily_limit_ceiling_exceeded')) return fail(res, 400, 'daily_limit_ceiling_exceeded', `The daily limit cannot exceed ${cfg.maxDailyLimit}.`);
    if (error.detail?.includes('invalid_topup')) return fail(res, 400, 'invalid_topup', 'The requested daily limit change is invalid.');
    return fail(res, 503, 'service_unavailable', 'The key limit service is temporarily unavailable.');
  }
};
