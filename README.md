# Aethel AI — Autonomous Compute Infrastructure

> Decentralized GPU routing and low-latency inference on Robinhood Chain.  
> Token: **$AETHEL** · Pair: **NVDA Token** · Launchpad: **Pons**

---

## Project Structure

```
AethelAI/
├── index.html        # Landing page
├── style.css         # Custom styles (scanlines, scrollbar, animations)
├── script.js         # Live terminal engine (telemetry, logs, counters)
├── vercel.json       # Vercel deployment config
├── netlify.toml      # Netlify deployment config
├── package.json      # Minimal manifest
└── README.md         # This file
```

## Local Development

```bash
# Option 1: Python
python3 -m http.server 8000

# Option 2: Node
npx serve .
```

Then open [http://localhost:8000](http://localhost:8000).

## Deploy to Vercel

1. Push this repo to GitHub.
2. Go to [vercel.com](https://vercel.com) → **New Project** → Import the repo.
3. Framework Preset: **Other** (auto-detected via `vercel.json`).
4. Click **Deploy**. Done.

## Deploy to Netlify

1. Push this repo to GitHub.
2. Go to [netlify.com](https://app.netlify.com) → **Add new site** → Import from Git.
3. Build command: *(leave blank)*  
   Publish directory: `.`
4. Click **Deploy site**. Done.

## Connect Namecheap Domain

### For Vercel:
1. In Vercel dashboard → **Settings** → **Domains** → Add your domain.
2. In Namecheap → **Advanced DNS** → Add:
   - **Type:** CNAME | **Host:** @ | **Value:** `cname.vercel-dns.com`
   - **Type:** CNAME | **Host:** www | **Value:** `cname.vercel-dns.com`
3. Wait for DNS propagation (up to 48h, usually minutes).

### For Netlify:
1. In Netlify dashboard → **Domain settings** → **Add custom domain**.
2. In Namecheap → **Advanced DNS** → Add:
   - **Type:** CNAME | **Host:** @ | **Value:** `<your-site>.netlify.app`
   - **Type:** CNAME | **Host:** www | **Value:** `<your-site>.netlify.app`
3. Enable **HTTPS** in Netlify (auto via Let's Encrypt).

## Tech Stack

- **HTML5** — Semantic, accessible markup
- **Tailwind CSS** — Utility-first styling (CDN)
- **JetBrains Mono** — Monospace terminal font (Google Fonts)
- **Vanilla JS** — Zero dependencies, live telemetry simulation

## License

MIT
