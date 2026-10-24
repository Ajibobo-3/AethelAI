const { configuration, send } = require('./_lib/gateway');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }
  const cfg = configuration();
  let databaseReady = false;
  if (cfg.supabaseUrl && cfg.supabaseKey) {
    try {
      await require('./_lib/gateway').database('aethel_api_keys?select=id&limit=1');
      databaseReady = true;
    } catch (_) {
      databaseReady = false;
    }
  }
  const providerReady = Boolean(cfg.groqKey);
  const ready = databaseReady && providerReady;
  res.status(ready ? 200 : 503);
  send(res, ready ? 200 : 503, {
    status: ready ? 'ready' : 'setup_required',
    service: 'Aethel AI Gateway',
    components: {
      usage_store: databaseReady ? 'connected' : 'not_configured',
      inference_provider: providerReady ? 'groq' : 'not_configured',
    },
    default_model: cfg.models[0] || null,
    inference_provider: 'groq',
    checked_at: new Date().toISOString(),
  });
};
