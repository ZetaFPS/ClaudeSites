# PokéFolio — Pokémon card portfolio tracker

A Collectr-style app for tracking what your Pokémon TCG collection is worth.

- **Accounts** — sign up / sign in with email + password; your collection syncs to the server and
  follows you across devices. "Continue without an account" keeps cards in the browser, and they're
  imported automatically when you later create an account.
- **Scan a card** with your camera (or a photo) — **English or Japanese**. Image recognition leads:
  the server keeps a **visual index** with a compact picture fingerprint of every card (English cards
  from the Pokémon TCG API, Japanese cards from TCGdex), and your photo is compared with all of them,
  so a card is found even when none of its text can be read (glare, blur, Japanese text). The best
  matches are then compared close-up at full resolution with your photo. Confident matches open
  automatically. Uncropped photos work too: the card is located in the picture first.
  (`lib/visualIndex.js`, `public/descriptor.js`, `public/vision.js` — no model download.)
  At the same time, on-device OCR (Tesseract.js) reads the **name**, **collector number** (`4/102`,
  `025/165`), **set code** (`PAL EN`, or Japanese codes like `SV2a`), **HP**, **illustrator** and
  **attack names**. These add candidates and refine the ranking (shown as ✓ chips) — mainly to
  tell apart reprints that share the same artwork. Pick **Auto / English / Japanese** under the
  scanner to narrow the search.
- **Japanese cards** — scan them, or search with Japanese text (`ピカチュウ`), `jp` (`Pikachu jp`), or a
  number with a set code (`025/165 SV2a jp`). Japanese cards are marked **JP**. Their prices come from
  PriceCharting's Japanese listings (looked up by the Pokémon's English name), when it has them.
- **Card pictures never go missing**: if an image fails to load, the app asks the server, which tries
  every other source for that card — the other size, the Pokémon TCG API's image server, TCGdex (webp,
  png or jpg) — and shows a neat placeholder only if none has it.
- **Search** by name, optionally with a number: `Charizard`, `Pikachu 58/102`, `Pikachu SWSH020`.
- **Raw prices drive your portfolio total.** Each card's ungraded market price comes from, in order:
  1. TCGplayer market price for the chosen printing (via the Pokémon TCG API)
  2. TCGplayer market price via [TCGdex](https://tcgdex.dev) for the same card (same set, number and printing)
  3. PriceCharting "Ungraded" price (strict match: name, number, set and printing must all agree)
  4. Cardmarket (EU) trend price converted from € to $ at the ECB daily rate — marked "≈"
  5. TCGplayer's lowest current listing, as a last resort — marked "≈"

  Unlimited printings are the default over 1st Edition. Card search falls back to TCGdex when the Pokémon TCG API is slow or down.
- **Graded values** on every card: PSA 10, Grade 9.5, PSA 9 … 1, plus BGS/CGC/SGC 10 where
  available, each with its multiple of the raw price — from [PriceCharting](https://www.pricecharting.com).
  If a match can't be made on set name (common for promos), a product that is the *only* one with
  that exact name, number and printing is accepted. Grades with no recent sales (PSA 10/9/8/7) are
  **estimated** — scaled from the card's real graded sales when it has some, otherwise from its raw
  price using typical PSA premiums — and always shown as "≈ … est." with a striped bar.
- **Profile pictures** — tap your avatar → **Add a profile picture**. Photos are cropped to a square
  and shrunk on your device before upload, stored in the database, and shown in the top bar, on the
  leaderboard and profiles, and in group chats and member lists.
- **Card index** — the Index tab lists every card, English and Japanese, newest set first with a
  heading per set. It loads four rows at a time (more with **Load more**) and nothing is fetched
  until you open it. Sort by newest/oldest set, name, rarity (rarest first), set name, or *my
  collection first*; filter by set, language, a name/number search, or *only cards I own* (owned
  cards are marked ✓). The catalogue is fetched once, saved in the database, and refreshed daily.
- **Pack simulator** — pick any English booster set (the Packs tab), rip the pack and flip through it card by card: commons first, the rare last and face-down,
  with a burst and holo shine for hits. Packs follow each era's real structure — WotC 11 cards
  (7C/3U/1 rare, holo ~1 in 3), EX 9 cards (5C/2U/reverse/rare), DP–Sword & Shield 10 cards
  (5C/3U/reverse/rare+), Scarlet & Violet 10 cards (4C/3U/2 holo slots incl. Illustration Rare
  chances/rare+), e-Card 9 cards (with a reverse holo) — at published pull rates where known
  (e.g. Scarlet & Violet: Double Rare ~1/4, IR ~1/12, SIR ~1/86, Hyper Rare ~1/150). A pack always
  has exactly its stated number of cards. Packs are only built from real rarity data: when a new
  set's cards arrive without rarities, they're fetched card by card from TCGdex (and saved) before
  the set can be opened. Subsets the card database lists separately are merged into their parent
  set at their real rate (Hidden/Shining Fates Shiny Vault ~1/3, Crown Zenith Galarian Gallery
  ~3/8, Trainer Gallery ~1/7). *What's in this pack* shows each set's actual rarity counts.
  Special sets follow their own real structure — **Celebrations**: 4 holo cards with a Classic
  Collection or V/VMAX in ~1 in 3 packs;
  **30th Celebration** packs are 5 foil cards with exactly one of the 30 anniversary Pikachu, a
  Rare Holo or Double Rare slot, and at most one hit per pack at the published odds (Double Rare
  1/4, Illustration Rare 1/6, Classic Collection 1/11, SIR 1/20, Futuristic Rare 1/103, RGB 1/4000).
  The pack shown is the set's real booster pack: the official pack artwork from TCGdex (a random
  one of the set's pack designs each time), else a photo from PriceCharting (background cut away),
  else a drawn pack. Hits arrive face-down with a glow and flip on their own, slower than the rest. The summary shows what the pack would be worth.
  Just for fun: opened cards are never added to the collection.
- **Highest PSA potential** — a collection sort that ranks cards by how much more a PSA 10 is worth
  than the raw card (PSA 10 prices are looked up only when you choose this sort, then cached).
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
- **Pre-grading** — upload photos of the front and back for a PSA-style estimate with sub-grades.
  Photos taken at an angle are perspective-corrected first (the card's four edges are fitted as
  straight lines and the card is un-skewed onto a flat 63×88 mm canvas), so ordinary phone shots
  don't produce fake corner dings or off-centering:
  - *Centering*: border widths measured in mm on every side → ratios like `55/45` (L/R and T/B),
    front and back, checked against PSA's centering standards. The border's inner edge is found as
    a sharp colour step between two flat colours, so subtle edges (silver border next to a light
    frame) are measured and glare gradients are not mistaken for an edge. With the card selected,
    the official image's artwork is lined up with the photo's to cross-check each border. If the
    front can't be measured, centering is shown as "—" and left out of the grade (never assumed 10)
  - *Edges*: whitening/chipping along each edge
  - *Corners*: wear and dings (compared with the card's die-cut corner shape)
  - *Crinkles*: short, jagged white crack lines where bending has cracked the ink and the paper
    shows through — thin, sharp, near-colourless lines that are much brighter than the print right
    next to them. Checked in the plain border band of both sides (where any such line is damage),
    and in the front's artwork when the card is selected (lines not in the official image). Graded
    by their total length; a single short line is noted as a light crinkle or scratch
  - *Surface*: creases (long, straight, continuous thin lines on the back — curved or broken design
    lines are rejected, and so are outlines of printed shapes such as the POKéMON logo, which have
    different colours on each side while a crease cuts through the design; 18–30 mm lines are only
    flagged to check), spots/stains in the borders, glare
  Holo foil, glossy finishes and glare are told apart from wear: whitening must be a sharp
  step confined to the outer ~1 mm (reflections fade in gradually), everything is compared with
  the border colour at that spot, single-pixel foil glints are ignored, and only marks darker than
  the border count as dirt (reflections are always brighter). Detected shine is reported as info,
  not counted against the grade.
  **Which card is this?** After you add the front photo, the grader recognises the card (same
  image recognition as the scanner) and suggests it — or search and select it. Its official picture
  is then lined up with your photo and colour-matched, so the card's own artwork, printed lines and
  logos are ignored: creases and marks are found on the *front* too (lines and spots that aren't on
  the official image), and you see the card's value at the estimated grade. If the photo doesn't
  match the selected card, you're told and it's ignored. On the back, the POKéMON logos and their
  swirl outlines line up in long straight lines, so a line lying mostly inside the logo areas isn't
  counted as a crease, and a crease must be continuous along at least 80% of its length.
  The report shows what was measured on the straightened photos. (`public/grader.js`; runs entirely in the browser.)
- Works on phones, tablets and desktops: on large screens you get a sidebar, a dashboard layout,
  a card-grid collection and a side-by-side card view.
- Card details: set, number, rarity, artist, release date, HP, types, attacks, flavor text,
  TCGplayer prices by printing and Cardmarket (EUR) prices.

## Keeping accounts when you update the site

Accounts, collections and the scanner's visual index are stored in **PostgreSQL** whenever `DATABASE_URL` is set. The database
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

Needs **Node.js 20+**.

```sh
cd pokemon-portfolio
npm install          # dependencies: pg (PostgreSQL driver), sharp (image decoding for the visual index)
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
| `VISUAL_INDEX` | Set to `off` to disable the scanner's visual index (the scanner then relies on reading the card's text). |
| `VISUAL_INDEX_LANGS` | Which catalogues to index: `en,ja` (default), `en` or `ja`. |

### The visual index

On first start the server downloads each card's small picture once (newest sets first, a few at a
time) and stores a 336-byte fingerprint per card — about 35 MB for the ~35,000 English and Japanese
cards. The first full build takes roughly an hour; scanning already uses whatever is indexed so far
and falls back to reading the card's text until then (the scan page shows progress). Fingerprints
are saved in the database (or `DATA_DIR/card-index.jsonl` without one), so restarts and redeploys
only fetch cards from newly released sets, checked once a day.

### Deploying

Any host that runs a Node process works (Render, Railway, Fly.io, a VPS). Set `DATABASE_URL`
(see above) so accounts survive redeploys. Build command: `npm install`, start command: `npm start`. The app can no longer be
hosted as static files only (e.g. GitHub Pages), because sign-in and PriceCharting lookups need the server.

## How it's built

```
server.js        HTTP server: static files, /api/auth/*, /api/portfolio, /api/search, /api/prices/*,
                 /api/visual-search, /api/card-image/* (picture with fallbacks)
lib/auth.js      scrypt password hashing, 30-day HttpOnly session cookies
lib/store.js     storage: PostgreSQL (DATABASE_URL) or a JSON file
lib/prices.js    Pokémon TCG API, TCGdex and PriceCharting lookups with caching + rate limiting
lib/leaderboard.js  server-side collection values and rankings (global + per group)
lib/groups.js    groups API: invites, chat, photos, card shares, permissions
lib/visualIndex.js  picture fingerprints of every card (English + Japanese) and the photo search
public/          the web app (vanilla HTML/CSS/JS); vision.js = image matching, descriptor.js = shared
                 card fingerprint (browser + server), grader.js = pre-grading
```

Script and stylesheet URLs in the page carry a version (`app.js?v=…`) computed from the files, so
after every deploy browsers load the new code immediately — never an old cached script with a new page.

Prices are cached on the server (card data 6 h, prices 12 h) and the app refreshes your
portfolio's prices automatically when they're more than 6 hours old, or on demand with the refresh button.
The value chart records one point per day, so the trend fills in as you use the app.
