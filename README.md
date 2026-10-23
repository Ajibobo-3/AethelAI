# Aethel AI — Inference Gateway

Aethel is an OpenAI-compatible chat completion gateway deployed as Vercel Functions. It authenticates customer API keys, enforces an atomic per-key daily request quota, forwards requests to a configured OpenAI-compatible primary (with an optional, model-mapped Groq fallback on HTTP 429), and records provider-reported token usage in Supabase Postgres.

The gateway can optionally retry a primary-provider HTTP 429 through a model-mapped Groq backup. The feature is opt-in by environment flag and is currently enabled in Vercel Production. Requests routed to Groq are billed to the configured provider account. This reduces reliance on a single provider but does not guarantee limit-free service. Distributed GPU routing and customer billing are not implemented. Treat the current V1 as a private API pilot; provider usage is paid from the operator’s provider accounts.

## Configure the service

1. Create a Supabase project.
2. Apply `supabase/migrations/202610230001_aethel_gateway.sql` in the Supabase SQL Editor.
3. Add the variables from `.env.example` under Vercel Project Settings → Environment Variables. Use a Supabase project URL, its server-only secret key (`SUPABASE_SECRET_KEY`; the legacy `SUPABASE_SERVICE_ROLE_KEY` is also supported), a provider API key, and a strong random `AETHEL_ADMIN_KEY`. Store these as server-side secrets only.
4. Set the `AETHEL_ALLOWED_MODELS` list to the model IDs available to your provider account. The default is `gpt-4o-mini`.
5. Deploy the project and check `/api/health`.

Set `AETHEL_DAILY_REQUEST_LIMIT` to change the default of 100 attempted requests per key per UTC day. Requests that fail at the provider still count against the limit. `AETHEL_MAX_OUTPUT_TOKENS` caps generated output (default 2,048). `OPENAI_BASE_URL` can point to another OpenAI-compatible primary. Production currently has Groq fallback enabled. For other deployments, configure `GROQ_API_KEY`, set `AETHEL_ENABLE_GROQ_FALLBACK=true`, and map each public model to a supported Groq model in `AETHEL_GROQ_MODEL_MAP`. The default mapping sends `gpt-4o-mini` fallback requests to Groq’s `openai/gpt-oss-20b`.

## Issue and disable customer keys

Create a key from a trusted terminal:

```sh
curl -X POST https://aethelai.online/api/v1/keys \
  -H "X-Aethel-Admin-Key: $AETHEL_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app"}'
```

The generated customer key is returned once. Store it in your application’s server-side secret manager. The database stores only the SHA-256 hash. Disable an active key using its returned `id`:

```sh
curl -X DELETE "https://aethelai.online/api/v1/keys/KEY_ID" \
  -H "X-Aethel-Admin-Key: $AETHEL_ADMIN_KEY"
```

## Send a chat completion

```sh
curl https://aethelai.online/api/v1/chat/completions \
  -H "Authorization: Bearer $AETHEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

Supported routes:

- `GET /api/health` — checks database reachability and provider configuration.
- `POST /api/v1/keys` — creates a customer key with the admin secret.
- `DELETE /api/v1/keys/:id` — disables a customer key with the admin secret.
- `POST /api/v1/chat/completions` — authenticated non-streaming chat completion.

This API currently requires the Vercel deployment because the functions live under `api/`. For local API development, use `npm run dev` (or `npx vercel dev`) so those functions are served. Put `AETHEL_ADMIN_KEY` in the ignored local `.env.local` file or the local terminal environment, then run `npm run smoke` to create a temporary customer key, make one small inference request, and revoke the key. The script never prints the key. Copy `.env.example` to a local environment file and fill it with development credentials. Never commit real credentials.

## Project structure

- `index.html` — product landing page and live service readiness display
- `docs/api.html` — API setup and request quickstart
- `api/` — Vercel serverless functions and gateway helpers
- `supabase/migrations/` — tables, access controls, and atomic daily quota RPC
- `.env.example` — required server configuration names
- `style.css`, `script.js` — responsive design and service health display
