'use strict';

const base = (process.env.AETHEL_API_BASE_URL || 'https://aethelai.online').replace(/\/$/, '');
const adminKey = process.env.AETHEL_ADMIN_KEY || localAdminKey();
const model = process.env.AETHEL_SMOKE_MODEL || 'gpt-4o-mini';

function localAdminKey() {
  let contents;
  try { contents = require('node:fs').readFileSync('.env.local', 'utf8'); } catch { return undefined; }
  for (const raw of contents.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7);
    const separator = line.indexOf('=');
    if (separator < 0 || line.slice(0, separator).trim() !== 'AETHEL_ADMIN_KEY') continue;
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, value.endsWith('"') ? -1 : undefined); }
    } else if (value.startsWith("'")) {
      value = value.slice(1, value.endsWith("'") ? -1 : undefined);
    }
    return value || undefined;
  }
  return undefined;
}

async function jsonRequest(url, options, timeoutMs = 20000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

async function main() {
  if (!adminKey) throw new Error('Set AETHEL_ADMIN_KEY in this terminal environment first.');

  const healthResponse = await jsonRequest(`${base}/api/health`, { cache: 'no-store' });
  const health = await readJson(healthResponse);
  console.log(`health=${healthResponse.status} status=${health.status || 'unknown'}`);
  if (!healthResponse.ok || health.status !== 'ready') throw new Error('The gateway is not ready.');

  const createResponse = await jsonRequest(`${base}/api/v1/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aethel-Admin-Key': adminKey },
    body: JSON.stringify({ name: `v1-smoke-${Date.now()}` }),
  });
  const created = await readJson(createResponse);
  if (!createResponse.ok || !created.id || !created.api_key) {
    throw new Error(`Temporary key creation failed (HTTP ${createResponse.status}, ${created.error?.code || 'unknown_error'}).`);
  }

  let inferenceError;
  let revoked = false;
  try {
    const inferenceResponse = await jsonRequest(`${base}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.api_key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly AETHEL_V1_OK and no other text.' }],
        max_completion_tokens: 32,
      }),
    }, 65000);
    const result = await readJson(inferenceResponse);
    const reply = result.choices?.[0]?.message?.content?.trim();
    const passed = inferenceResponse.ok && reply === 'AETHEL_V1_OK';
    console.log(`inference=${inferenceResponse.status} model=${result.model || model} provider=${inferenceResponse.headers.get('X-Aethel-Provider') || 'unknown'} total_tokens=${result.usage?.total_tokens ?? 'unknown'} exact_reply=${passed}`);
    if (!passed) inferenceError = new Error(`Inference check failed (HTTP ${inferenceResponse.status}, ${result.error?.code || 'unexpected_response'}).`);
  } catch {
    inferenceError = new Error('The inference request failed or timed out.');
  } finally {
    try {
      const revokeResponse = await jsonRequest(`${base}/api/v1/keys/${created.id}`, {
        method: 'DELETE', headers: { 'X-Aethel-Admin-Key': adminKey },
      });
      const revokeBody = await readJson(revokeResponse);
      revoked = revokeResponse.ok && revokeBody.status === 'disabled';
      console.log(`temporary_key=${revoked ? 'revoked' : `revoke_failed_http_${revokeResponse.status}`}`);
      if (!revoked) console.log(`temporary_key_id=${created.id}`);
    } catch {
      console.log(`temporary_key=revoke_failed id=${created.id}`);
    }
  }

  if (inferenceError) throw inferenceError;
  if (!revoked) throw new Error('The temporary key could not be revoked. Disable it with the admin endpoint.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
