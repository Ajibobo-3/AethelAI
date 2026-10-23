const { send, fail, database, safeEqual } = require('../../_lib/gateway');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return fail(res, 405, 'method_not_allowed', 'Use POST to disable an API key.');
  }
  const adminKey = process.env.AETHEL_ADMIN_KEY;
  if (!adminKey || !safeEqual(req.headers['x-aethel-admin-key'], adminKey)) {
    return fail(res, 401, 'unauthorized', 'A valid admin key is required.');
  }
  const id = req.body?.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return fail(res, 400, 'invalid_id', 'Provide a valid API key ID.');
  }
  try {
    const rows = await database(`aethel_api_keys?id=eq.${id}&disabled_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ disabled_at: new Date().toISOString() }),
    });
    if (!rows?.length) return fail(res, 404, 'key_not_found', 'No active key matched that ID.');
    return send(res, 200, { id, status: 'disabled' });
  } catch (_) {
    return fail(res, 503, 'service_unavailable', 'The key service is temporarily unavailable.');
  }
};
