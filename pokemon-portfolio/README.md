# PokéFolio — Pokémon card portfolio tracker

A Collectr-style app for tracking what your Pokémon TCG collection is worth.

- **Accounts** — sign up / sign in with email + password; your collection syncs to the server and
  follows you across devices. "Continue without an account" keeps cards in the browser, and they're
  imported automatically when you later create an account.
- **Scan a card** with your camera (or a photo). On-device OCR (Tesseract.js) reads the name and
  collector number (e.g. `4/102`) to gather candidates — including same-name cards in case the number
  was misread — then **image recognition** compares your photo with each candidate's artwork and puts
  the closest visual match first (with a match %). Confident matches open automatically. Uncropped
  photos work too: the card is located in the picture first. (`public/vision.js`, no model download.)
  The scanner also reads the card's **set code** (e.g. `PAL EN`), **HP**, **illustrator** and
  **attack/ability names**, and checks each candidate against them — shown as ✓ chips on the
  results. Artwork similarity leads the ranking; printed details refine it and tell apart reprints
  that share the same artwork.
- **Search** by name, optionally with a number: `Charizard`, `Pikachu 58/102`, `Pikachu SWSH020`.
- **Raw prices drive your portfolio total.** Each card's ungraded market price comes from, in order:
  1. TCGplayer market price for the chosen printing (via the Pokémon TCG API)
  2. TCGplayer market price via [TCGdex](https://tcgdex.dev) for the same card (same set, number and printing)
  3. PriceCharting "Ungraded" price (strict match: name, number, set and printing must all agree)

  Unlimited printings are the default over 1st Edition. Card search falls back to TCGdex when the Pokémon TCG API is slow or down.
- **Graded values** on every card: PSA 10, Grade 9.5, PSA 9 … 1, plus BGS/CGC/SGC 10 where
  available, each with its multiple of the raw price — from [PriceCharting](https://www.pricecharting.com).
- **Leaderboard** — collectors ranked by collection value, with a podium for the top 3. Tap anyone
  to see their 5 most valuable cards. Values are recalculated on the server from current market
  prices (saved prices can't be faked), and only display names, totals and top cards are public —
  never emails. Anyone can hide themselves under **Account → Show me on the leaderboard**.
- **Groups** — create a group, name it and invite friends with an 8-character code or link.
  Each group has a chat (text, photos, and cards shared from your collection with their live
  price), its own members-only leaderboard (same server-side values as the global one), and a
  members page. The owner can rename the group, reset the invite code, remove members or delete
  it; members can delete their own messages and leave. Only members can read a group or load its
  photos. Messages and photos are stored in the database, so they survive site updates too.
- **Pre-grading** — upload photos of the front and back for a PSA-style estimate with sub-grades:
  - *Centering*: border widths measured in mm on every side → ratios like `55/45` (L/R and T/B),
    front and back, checked against PSA's centering standards
  - *Edges*: whitening/chipping along each edge
  - *Corners*: wear and dings (compared with the card's die-cut corner shape)
  - *Surface*: creases (long, straight, thin lines on the back), spots/stains in the borders, glare
  Holo foil, glossy finishes and glare are told apart from wear: whitening must be a sharp
  step confined to the outer ~1 mm (reflections fade in gradually), everything is compared with
  the border colour at that spot, single-pixel foil glints are ignored, and only marks darker than
  the border count as dirt (reflections are always brighter). Detected shine is reported as info,
  not counted against the grade.
  The report shows what was measured on the straightened photos and, if you link a card from your
  collection, its value at the estimated grade. (`public/grader.js`; runs entirely in the browser.)
- Works on phones, tablets and desktops: on large screens you get a sidebar, a dashboard layout,
  a card-grid collection and a side-by-side card view.
- Card details: set, number, rarity, artist, release date, HP, types, attacks, flavor text,
  TCGplayer prices by printing and Cardmarket (EUR) prices.

## Keeping accounts when you update the site

Accounts and collections are stored in **PostgreSQL** whenever `DATABASE_URL` is set. The database
lives outside the web server, so redeploys, restarts and host changes never touch it. Without
`DATABASE_URL` the app falls back to a file on the server's disk — fine on your own computer, but
most hosts (e.g. Render's free tier) wipe that disk on every deploy.

One-time setup with a free [Neon](https://neon.tech) database (Supabase or any Postgres works too):

1. Create a Neon account → **New project** → copy the connection string
   (looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`).
2. In your host's dashboard (Render: your service → **Environment**), add
   `DATABASE_URL` = that connection string, and save. The site redeploys.
3. Check it worked: open `https://<your-site>/api/health` — it should say `"storage":"postgres"`
   and `"persistent":true`. (The deploy log also prints `accounts stored in: postgres`.)

Paste the connection string exactly as Neon shows it — a leading `psql '…'`, quotes and extra
parameters are cleaned up automatically. If the database is asleep when the site starts, the server
waits and retries. Until a database is connected, the hosted site shows a red warning on the sign-in
screen saying accounts will be erased on the next update.

Tables are created automatically. If the server still has a `data/db.json` from an earlier
version when it first connects, those accounts and portfolios are imported into Postgres.
(Avoid Render's *free* Postgres for this — it's deleted after 30 days.)

## Run it

Needs **Node.js 18+**.

```sh
cd pokemon-portfolio
npm install          # only dependency: pg (PostgreSQL driver)
npm start            # or: node server.js
# open http://localhost:3000
```

Camera scanning requires a secure context: `http://localhost` works for testing; deploy behind
HTTPS for phones.

### Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `3000`). |
| `DATABASE_URL` | **Recommended for any hosted site.** PostgreSQL connection string; accounts and portfolios are stored there and survive redeploys. |
| `DATA_DIR` | Where accounts are stored when there's no `DATABASE_URL` (default `./data`). |
| `PRICECHARTING_TOKEN` | Recommended. Your [PriceCharting API](https://www.pricecharting.com/api-documentation) token (paid subscription). When set, graded prices come from the official API. Without it, the server reads PriceCharting's public product pages, which is slower and can break if their page layout changes. |
| `POKEMONTCG_API_KEY` | Optional free key from [pokemontcg.io](https://dev.pokemontcg.io) for higher rate limits. |
| `TRUST_PROXY` | Set to `1` when running behind a reverse proxy so rate limiting uses `X-Forwarded-For`. |

### Deploying

Any host that runs a Node process works (Render, Railway, Fly.io, a VPS). Set `DATABASE_URL`
(see above) so accounts survive redeploys. Build command: `npm install`, start command: `npm start`. The app can no longer be
hosted as static files only (e.g. GitHub Pages), because sign-in and PriceCharting lookups need the server.

## How it's built

```
server.js        HTTP server: static files, /api/auth/*, /api/portfolio, /api/cards, /api/prices/*
lib/auth.js      scrypt password hashing, 30-day HttpOnly session cookies
lib/store.js     storage: PostgreSQL (DATABASE_URL) or a JSON file
lib/prices.js    Pokémon TCG API, TCGdex and PriceCharting lookups with caching + rate limiting
lib/leaderboard.js  server-side collection values and rankings (global + per group)
lib/groups.js    groups API: invites, chat, photos, card shares, permissions
public/          the web app (vanilla HTML/CSS/JS); vision.js = image matching, grader.js = pre-grading
```

Prices are cached on the server (card data 6 h, prices 12 h) and the app refreshes your
portfolio's prices automatically when they're more than 6 hours old, or on demand with the refresh button.
The value chart records one point per day, so the trend fills in as you use the app.
