# PokéFolio — Pokémon card portfolio tracker

A Collectr-style app for tracking what your Pokémon TCG collection is worth.

- **Accounts** — sign up / sign in with email + password; your collection syncs to the server and
  follows you across devices. "Continue without an account" keeps cards in the browser, and they're
  imported automatically when you later create an account.
- **Scan a card** with your camera (or a photo). On-device OCR (Tesseract.js) reads the name and
  collector number (e.g. `4/102`) and looks the card up.
- **Search** by name, optionally with a number: `Charizard`, `Pikachu 58/102`, `Pikachu SWSH020`.
- **Raw prices drive your portfolio total.** Each card's ungraded market price comes from, in order:
  1. TCGplayer market price for the chosen printing (via the Pokémon TCG API)
  2. TCGplayer market price via [TCGdex](https://tcgdex.dev) for the same card (same set, number and printing)
  3. PriceCharting "Ungraded" price (strict match: name, number, set and printing must all agree)

  Unlimited printings are the default over 1st Edition. Card search falls back to TCGdex when the Pokémon TCG API is slow or down.
- **Graded values** on every card: PSA 10, Grade 9.5, PSA 9 … 1, plus BGS/CGC/SGC 10 where
  available, each with its multiple of the raw price — from [PriceCharting](https://www.pricecharting.com).
- Card details: set, number, rarity, artist, release date, HP, types, attacks, flavor text,
  TCGplayer prices by printing and Cardmarket (EUR) prices.

## Run it

Needs **Node.js 18+**. No dependencies to install.

```sh
cd pokemon-portfolio
npm start            # or: node server.js
# open http://localhost:3000
```

Camera scanning requires a secure context: `http://localhost` works for testing; deploy behind
HTTPS for phones.

### Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`). |
| `DATA_DIR` | Where accounts and portfolios are stored (default `./data`). Use a persistent disk in production. |
| `PRICECHARTING_TOKEN` | Recommended. Your [PriceCharting API](https://www.pricecharting.com/api-documentation) token (paid subscription). When set, graded prices come from the official API. Without it, the server reads PriceCharting's public product pages, which is slower and can break if their page layout changes. |
| `POKEMONTCG_API_KEY` | Optional free key from [pokemontcg.io](https://dev.pokemontcg.io) for higher rate limits. |
| `TRUST_PROXY` | Set to `1` when running behind a reverse proxy so rate limiting uses `X-Forwarded-For`. |

### Deploying

Any host that runs a Node process works (Render, Railway, Fly.io, a VPS). Give it a persistent
volume and point `DATA_DIR` at it, otherwise accounts are lost on redeploy. The app can no longer be
hosted as static files only (e.g. GitHub Pages), because sign-in and PriceCharting lookups need the server.

## How it's built

```
server.js        HTTP server: static files, /api/auth/*, /api/portfolio, /api/cards, /api/prices/*
lib/auth.js      scrypt password hashing, 30-day HttpOnly session cookies
lib/store.js     JSON-file database (atomic writes)
lib/prices.js    Pokémon TCG API, TCGdex and PriceCharting lookups with caching + rate limiting
public/          the web app (vanilla HTML/CSS/JS)
```

Prices are cached on the server (card data 6 h, prices 12 h) and the app refreshes your
portfolio's prices automatically when they're more than 6 hours old, or on demand with the refresh button.
The value chart records one point per day, so the trend fills in as you use the app.
