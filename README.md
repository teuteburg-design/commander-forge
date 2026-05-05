# Commander Forge

A browser-based MTG Commander deck builder. Bring your own AI key (Groq or Gemini — both have free tiers); no install, no backend, no telemetry.

## Use it

👉 **https://commander-forge.rafaelteuteburg.workers.dev** *(or your deployed URL)*

## What you'll need

1. A free **Gemini** API key from <https://aistudio.google.com> (recommended — its free tier easily covers normal use)
   — or a **Groq** key from <https://console.groq.com> (small daily token cap on the free tier)
2. Your card collection exported as CSV from [Manabox](https://manabox.app)

With both keys saved, the app automatically falls back to the secondary provider if the primary is rate-limited.

## How it works

1. ⚙ **Settings** → paste your AI key(s) → save
2. **Import** → paste your Manabox CSV
3. **Load Commanders** → app scans Scryfall for legendary creatures in your collection
4. **AI Suggest Commanders** → top 3 picks based on your bracket, archetype, and budget preferences
5. **Build Deck** → 99-card legal deck constructed from your collection, ranked by EDHRec synergy and Commander Spellbook combo data
6. **Export** → `.txt` for Archidekt, save to local Library, or open the deck directly

## Privacy

- Your AI keys live only in your browser's localStorage
- Your collection is parsed entirely client-side and never leaves your browser
- The host (Cloudflare Pages) only sees that you fetched the HTML — they don't see your keys, cards, or decks
- The app fetches public card data from Scryfall, EDHRec, and Commander Spellbook (no authentication, no tracking)

## Self-hosting

This repo is set up for **Cloudflare Workers** deployment via Cloudflare's git integration:

1. Fork or clone this repo
2. Connect it as a Workers project at <https://dash.cloudflare.com>
3. Cloudflare reads `wrangler.toml` and deploys automatically on every push

The Worker (`worker/index.js`) serves the static files from `./public/` and exposes a `POST /api/ai` endpoint that calls Workers AI for the built-in option.

For static-only hosting (no built-in AI), drop `public/index.html` and `public/commander-forge.html` onto any host (GitHub Pages, Netlify, S3, etc.). The app still works — friends just need to bring their own Groq / Gemini key.

## Local development

```sh
# Static-only (no built-in AI; bring your own key)
cd public
python3 -m http.server 5173
# open http://localhost:5173

# Full local Worker (built-in AI works locally too)
npm i -g wrangler
wrangler dev
# open the URL it prints
```

## Tech notes

- Single self-contained HTML file at `public/commander-forge.html` (~4000 lines)
- Preact 10 + htm 3 (no JSX compiler, no bundler)
- Worker entry at `worker/index.js` (~70 lines)
- Card data: [Scryfall](https://scryfall.com/docs/api) `/cards/collection` (cached locally, 7-day TTL)
- Synergy ranking: [EDHRec](https://edhrec.com) public JSON endpoints (with CORS proxy fallback)
- Combo discovery: [Commander Spellbook](https://commanderspellbook.com) `/find-my-combos/` API
- AI providers (BYO key, with automatic fallback if both configured):
  - **Groq** — Llama 3.3 70B
  - **Gemini** — Gemini 2.5 Flash
