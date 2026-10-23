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
  const providerReady = Boolean(cfg.providerKey);
  const ready = databaseReady && providerReady;
  res.status(ready ? 200 : 503);
  send(res, ready ? 200 : 503, {
    status: ready ? 'ready' : 'setup_required',
    service: 'Aethel AI Gateway',
    components: {
      usage_store: databaseReady ? 'connected' : 'not_configured',
      inference_provider: providerReady ? 'configured' : 'not_configured',
      fallback_provider: !cfg.groqKey ? 'not_configured' : cfg.groqFallbackEnabled ? 'enabled' : 'available_disabled',
    },
    default_model: cfg.models[0] || null,
    checked_at: new Date().toISOString(),
  });
};
