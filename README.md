# Aethel AI — Decentralized Inference Gateway

Aethel AI is a static landing page for a proposed pay-per-use inference gateway and distributed GPU network. The page describes the product direction and includes an explicitly simulated telemetry interface; it does not connect to a production inference API or live network feed.

## Project structure

- `index.html` — landing page content and layout
- `style.css` — responsive visual system
- `script.js` — illustrative telemetry animation and mobile navigation
- `vercel.json` / `netlify.toml` — static hosting configuration

## Local preview

Run `python3 -m http.server 8000` in this directory, then visit `http://localhost:8000`.

## Deployment

The repository is connected to Vercel for static deployment. Pushing to the production branch can trigger the configured deployment. Netlify configuration is also included.

Gateway API access and documentation links are placeholders for a future release. The request snippet on the landing page is illustrative and does not imply that the endpoint is currently available.
