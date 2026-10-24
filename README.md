# Aethel AI — Inference Gateway

Aethel is an OpenAI-compatible chat completion gateway deployed as Vercel Functions. It authenticates customer API keys, enforces an atomic per-key daily request quota, routes inference through Groq, and records provider-reported token usage in Supabase Postgres.

Groq is the only inference provider currently configured in the gateway. Before each agent run, the gateway discovers the account’s available Llama 3 text models. It defaults to `llama-3.1-8b-instant` and retries with `llama-3.3-70b-versatile` if the primary is unavailable. Requests are billed to the configured Groq account. Distributed GPU routing and customer billing are not implemented. Treat the current V1 as a private API pilot; provider usage is paid from the operator’s provider account.

## Configure the service

1. Create a Supabase project.
2. Apply both SQL migrations in order: `supabase/migrations/202610230001_aethel_gateway.sql`, then `supabase/migrations/202610240001_aethel_agent_beta.sql`.
3. Add the variables from `.env.example` under Vercel Project Settings → Environment Variables. Use a Supabase project URL, its server-only secret key (`SUPABASE_SECRET_KEY`; the legacy `SUPABASE_SERVICE_ROLE_KEY` is also supported), a provider API key, and a strong random `AETHEL_ADMIN_KEY`. Store these as server-side secrets only.
4. Set `GROQ_API_KEY` and set the `AETHEL_ALLOWED_MODELS` list to the public model IDs accepted by your clients. The default inference model is `llama-3.1-8b-instant`; `gpt-4o` and `gpt-4o-mini` map to that model for compatibility. Unknown model IDs also route to the primary model. Agent requests first check `/openai/v1/models`, prefer an available Llama 3 text model, and use another active text chat model if the account has no active Llama 3 model.
5. Deploy the project and check `/api/health`.

`AETHEL_DAILY_REQUEST_LIMIT` sets the default of 100 attempted requests per key per UTC day; each key stores its own cap. Requests that fail at the provider still count against the limit. `AETHEL_MAX_DAILY_REQUEST_LIMIT` sets the admin top-up ceiling (default 10,000). `AETHEL_MAX_OUTPUT_TOKENS` caps generated output (default 2,048). The agent fallback is fixed to `llama-3.3-70b-versatile`. Optional custom public model mappings can be supplied with `AETHEL_GROQ_MODEL_MAP`; standard compatibility aliases are pinned to active Groq model IDs in code.

## Issue and disable customer keys

Create a key from a trusted terminal:

```sh
curl -X POST https://www.aethelai.online/api/v1/keys \
  -H "X-Aethel-Admin-Key: $AETHEL_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-app"}'
```

The generated customer key is returned once. Store it in your application’s server-side secret manager. The database stores only the SHA-256 hash. Disable an active key using its returned `id`:

```sh
curl -X POST https://www.aethelai.online/api/v1/keys/revoke \
  -H "X-Aethel-Admin-Key: $AETHEL_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"KEY_ID"}'
```

## Send a chat completion

```sh
curl https://www.aethelai.online/api/v1/chat/completions \
  -H "Authorization: Bearer $AETHEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

Supported routes:

- `GET /api/health` — checks database reachability and provider configuration.
- `POST /api/v1/keys` — creates a customer key with the admin secret.
- `POST /api/v1/keys/revoke` — disables a customer key with the admin secret; send the key `id` in the JSON body.
- `POST /api/v1/keys/topup` — increase a key's daily cap with `{"id":"KEY_ID","increase_by":50}` or restore the configured default with `{"id":"KEY_ID","reset":true}`. Admin secret required. The cap cannot exceed `AETHEL_MAX_DAILY_REQUEST_LIMIT`; usage records are retained.
- `POST /api/v1/chat/completions` — authenticated non-streaming chat completion.
- `POST /api/v1/agent/run` — authenticated, metered agent run with up to five model/tool iterations and a Supabase-backed session.

## Run an agent task

The agent stores conversation history and tool-step outputs in `agent_sessions`, scoped to the authenticated API key. For safety, only the server-side `calculator` and `get_utc_time` tools are executable in this beta; arbitrary tools or caller-provided code are rejected. Requests without tools can still run as a single-turn agent.

```sh
curl -X POST https://www.aethelai.online/api/v1/agent/run \
  -H "Authorization: Bearer $AETHEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task":"What is 19 times 23?","session_id":"pilot-session-1","tools":[{"type":"function","function":{"name":"calculator","parameters":{"type":"object"}}}]}'
```

The server uses its configured default allowed model, executes no more than five completion/tool rounds, and returns `session_id`, `status`, `output`, and the current run's `steps`. A daily limit response is HTTP 429 with a UTC `resets_at` value. The beta migration must be applied in Supabase before using agent sessions, per-key caps, or top-ups.

This API currently requires the Vercel deployment because the functions live under `api/`. For local API development, use `npm run dev` (or `npx vercel dev`) so those functions are served. Put `AETHEL_ADMIN_KEY` in the ignored local `.env.local` file or the local terminal environment, then run `npm run smoke` to create a temporary customer key, make one small inference request, and revoke the key. The script never prints the key. Copy `.env.example` to a local environment file and fill it with development credentials. Never commit real credentials.

## Project structure

- `index.html` — product landing page and live service readiness display
- `docs/api.html` — API setup and request quickstart
- `api/` — Vercel serverless functions and gateway helpers
- `supabase/migrations/` — tables, access controls, and atomic daily quota RPC
- `.env.example` — required server configuration names
- `style.css`, `script.js` — responsive design and service health display
