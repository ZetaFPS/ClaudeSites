# PokéFolio — Pokémon card portfolio tracker

A Collectr-style web app for tracking the value of a Pokémon TCG collection.

- **Scan a card** with your phone camera (or upload a photo). The app reads the card name and
  collector number (e.g. `4/102`) with on-device OCR (Tesseract.js) and looks the card up.
- **Search** by name, optionally with a number: `Charizard`, `Pikachu 58/102`, `Pikachu SWSH020`.
- **Portfolio**: total market value, gain vs. what you paid, a value-over-time chart (1W/1M/3M/1Y/All),
  and a sortable/filterable list of your cards.
- **Card details**: large image, set + symbol, number, rarity, artist, release date, HP, types,
  abilities/attacks, flavor text, TCGplayer (USD) prices per printing and Cardmarket (EUR) prices.
  Edit quantity, condition, printing and price paid — or remove the card.

Card data and market prices come from the free [Pokémon TCG API](https://pokemontcg.io), which
publishes TCGplayer and Cardmarket pricing. Prices refresh automatically when older than 6 hours, or
on demand with the refresh button. Your collection is stored in your browser (`localStorage`).
The value chart records one point per day you open the app, so the trend fills in over time.

## Run it

It's a static site — no build step. Serve the folder over HTTP(S) (camera access requires a secure
context, i.e. `https://` or `localhost`):

```sh
cd pokemon-portfolio
python3 -m http.server 8000
# open http://localhost:8000
```

It also works as-is on GitHub Pages, Netlify, Vercel, etc.

## Scanning tips

Fill the on-screen frame with the card, avoid glare on holos, and keep the bottom edge (where the
collector number is printed) sharp. If several printings match, pick the right one from the results.
