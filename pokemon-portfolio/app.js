/* PokéFolio — Pokémon card portfolio tracker
 * Card data + market prices: Pokémon TCG API (https://pokemontcg.io), which
 * carries TCGplayer (USD) and Cardmarket (EUR) pricing for every card.
 * Scanning: camera frame -> Tesseract.js OCR of the name and collector number.
 * Everything the user owns is stored locally in their browser.
 */
(() => {
  'use strict';

  const API = 'https://api.pokemontcg.io/v2/cards';
  const STORE_KEY = 'pokefolio.v1';
  const STALE_MS = 6 * 60 * 60 * 1000;
  const CARD_FIELDS = [
    'id', 'name', 'supertype', 'subtypes', 'hp', 'types', 'evolvesFrom', 'abilities', 'attacks',
    'weaknesses', 'resistances', 'retreatCost', 'number', 'artist', 'rarity', 'flavorText',
    'nationalPokedexNumbers', 'regulationMark', 'rules', 'set', 'images', 'tcgplayer', 'cardmarket',
  ].join(',');

  const VARIANT_LABELS = {
    normal: 'Normal',
    holofoil: 'Holofoil',
    reverseHolofoil: 'Reverse Holo',
    '1stEditionHolofoil': '1st Edition Holo',
    '1stEditionNormal': '1st Edition',
    unlimitedHolofoil: 'Unlimited Holo',
    '1stEdition': '1st Edition',
    unlimited: 'Unlimited',
  };
  const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const eur = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' });
  const money = (n) => (n == null || isNaN(n) ? '—' : usd.format(n));
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + usd.format(Math.abs(n));
  const pct = (n) => (isFinite(n) ? (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n * 100).toFixed(2) + '%' : '');
  const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  /* ---------------- State ---------------- */
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && Array.isArray(s.items)) return { history: {}, pricesUpdatedAt: 0, ...s };
    } catch (_) { /* storage unavailable or corrupt */ }
    return { items: [], history: {}, pricesUpdatedAt: 0 };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }

  /* ---------------- Pricing helpers ---------------- */
  function variantsOf(card) {
    const p = card?.tcgplayer?.prices || {};
    return Object.keys(p).filter((k) => p[k] && (p[k].market != null || p[k].mid != null));
  }
  function defaultVariant(card) {
    const v = variantsOf(card);
    const order = ['holofoil', 'normal', '1stEditionHolofoil', 'unlimitedHolofoil', 'reverseHolofoil', '1stEditionNormal'];
    return order.find((k) => v.includes(k)) || v[0] || null;
  }
  function marketPrice(card, variant) {
    const p = card?.tcgplayer?.prices?.[variant || defaultVariant(card)];
    if (!p) return null;
    return p.market ?? p.mid ?? null;
  }
  function itemPrice(item) { return marketPrice(item.card, item.variant); }
  function itemValue(item) { return (itemPrice(item) || 0) * item.qty; }
  function itemCost(item) { return (item.purchasePrice || 0) * item.qty; }
  function totals() {
    let value = 0, cost = 0, count = 0;
    for (const it of state.items) { value += itemValue(it); cost += itemCost(it); count += it.qty; }
    return { value, cost, count };
  }
  function recordSnapshot() {
    state.history[dayKey()] = Math.round(totals().value * 100) / 100;
    save();
  }

  /* ---------------- API ---------------- */
  async function apiSearch(q, { pageSize = 36, orderBy = '-set.releaseDate' } = {}) {
    const url = `${API}?q=${encodeURIComponent(q)}&pageSize=${pageSize}&orderBy=${encodeURIComponent(orderBy)}&select=${CARD_FIELDS}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Card lookup failed (${res.status})`);
    const json = await res.json();
    return json.data || [];
  }

  // Turns free text like "Charizard 4/102" or "pikachu swsh020" into API queries,
  // from most to least specific, so a good match is found even if a part is off.
  function buildQueries({ name, number, total }) {
    const clean = (name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const words = clean.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4);
    const nameQ = words.map((w) => `name:${w}`).join(' ');
    const phrase = clean.replace(/[^a-z0-9.'\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    const nameWild = words.length ? words.slice(0, -1).map((w) => `name:${w}`).concat(`name:${words.at(-1)}*`).join(' ') : '';
    const num = number ? `number:${number}` : '';
    const tot = total ? `set.printedTotal:${total}` : '';
    const qs = [];
    if (nameQ && num && tot) qs.push(`${nameQ} ${num} ${tot}`);
    if (nameQ && num) qs.push(`${nameQ} ${num}`);
    if (num && tot) qs.push(`${num} ${tot}`); // name misread, number is still distinctive
    if (nameQ) qs.push(nameQ);
    if (nameWild) qs.push(nameWild);
    if (phrase && /[.'\-]/.test(phrase)) qs.push(`name:"${phrase}"`);
    return [...new Set(qs)];
  }
  async function findCards(parsed) {
    for (const q of buildQueries(parsed)) {
      const cards = await apiSearch(q);
      if (cards.length) return { cards, query: q };
    }
    return { cards: [], query: null };
  }
  function parseSearchText(text) {
    let t = ` ${text.trim()} `;
    let number = null, total = null;
    const slash = t.match(/\s#?([a-z]{0,3}\d{1,3}[a-z]?)\s*\/\s*([a-z]{0,3}\d{1,3})\s/i);
    if (slash) { number = normNumber(slash[1]); total = /^\d+$/.test(slash[2]) ? String(+slash[2]) : null; t = t.replace(slash[0], ' '); }
    else {
      const promo = t.match(/\s(swsh|sm|xy|bw|svp?|hgss|dp|tg|gg|rc)\s?(\d{1,3})\s/i);
      const plain = t.match(/\s#?(\d{1,3})\s/);
      if (promo) { number = (promo[1] + promo[2].padStart(promo[1].toLowerCase().startsWith('sw') || promo[1].toLowerCase() === 'sv' ? 3 : 2, '0')).toUpperCase(); t = t.replace(promo[0], ' '); }
      else if (plain) { number = normNumber(plain[1]); t = t.replace(plain[0], ' '); }
    }
    return { name: t.trim(), number, total };
  }
  function normNumber(n) { return /^\d+$/.test(n) ? String(+n) : n.toUpperCase(); }

  async function refreshPrices({ silent = false } = {}) {
    if (!state.items.length) return;
    const btn = $('#refreshBtn');
    btn.classList.add('spinning');
    try {
      const ids = [...new Set(state.items.map((i) => i.cardId))];
      const fresh = {};
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40);
        const q = '(' + chunk.map((id) => `id:"${id}"`).join(' OR ') + ')';
        const cards = await apiSearch(q, { pageSize: 50, orderBy: 'id' });
        cards.forEach((c) => { fresh[c.id] = c; });
      }
      state.items.forEach((it) => { if (fresh[it.cardId]) it.card = fresh[it.cardId]; });
      state.pricesUpdatedAt = Date.now();
      recordSnapshot();
      renderPortfolio();
      if (!silent) toast('Market prices updated');
    } catch (e) {
      if (!silent) toast('Could not refresh prices — check your connection');
    } finally {
      btn.classList.remove('spinning');
    }
  }

  /* ---------------- Navigation ---------------- */
  function go(view, { focusSearch = false } = {}) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.goto === view && (('focusSearch' in t.dataset) === focusSearch)));
    if (view !== 'scan') stopCamera();
    else if (!focusSearch && !stream) startCamera();
    if (view === 'portfolio') renderPortfolio();
    if (focusSearch) setTimeout(() => $('#searchInput').focus(), 50);
    window.scrollTo({ top: 0 });
  }
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) go(g.dataset.goto, { focusSearch: 'focusSearch' in g.dataset });
  });

  /* ---------------- Portfolio rendering ---------------- */
  let chartRange = 30;
  function renderPortfolio() {
    const { value, cost, count } = totals();
    $('#totalValue').textContent = money(value);
    $('#statCards').textContent = count;
    $('#statCost').textContent = money(cost);
    const gain = value - cost;
    const statGain = $('#statGain');
    statGain.textContent = cost ? signed(gain) : '—';
    statGain.className = 'stat-value ' + (cost ? (gain > 0 ? 'up' : gain < 0 ? 'down' : 'flat') : '');
    $('#priceUpdated').textContent = state.pricesUpdatedAt
      ? `Prices from TCGplayer · updated ${timeAgo(state.pricesUpdatedAt)}`
      : (state.items.length ? 'Prices from TCGplayer' : '');

    renderChart();
    renderList();
    $('#emptyState').hidden = state.items.length > 0;
    $('.list-head').hidden = state.items.length === 0;
  }

  function seriesFor(range) {
    const entries = Object.entries(state.history).sort(([a], [b]) => a.localeCompare(b));
    const today = dayKey();
    if (state.items.length || entries.length) {
      const live = Math.round(totals().value * 100) / 100;
      const idx = entries.findIndex(([d]) => d === today);
      if (idx >= 0) entries[idx] = [today, live]; else entries.push([today, live]);
    }
    if (!range) return entries;
    const cutoff = dayKey(new Date(Date.now() - range * 864e5));
    return entries.filter(([d]) => d >= cutoff);
  }

  function renderChart() {
    const svg = $('#chartSvg');
    const wrap = $('#chart');
    const empty = $('#chartEmpty');
    const pts = seriesFor(chartRange);
    const W = wrap.clientWidth || 600, H = wrap.clientHeight || 180;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    // Range change readout next to the hero value
    const changeEl = $('#totalChange');
    const { value, cost } = totals();
    if (pts.length >= 2) {
      const start = pts[0][1], d = value - start;
      const label = { 7: 'past week', 30: 'past month', 90: 'past 3 months', 365: 'past year', 0: 'all time' }[chartRange];
      changeEl.className = 'hero-change ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
      changeEl.textContent = `${signed(d)} (${start ? pct(d / start) : '—'}) ${label}`;
    } else if (cost) {
      const d = value - cost;
      changeEl.className = 'hero-change ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
      changeEl.textContent = `${signed(d)} (${pct(d / cost)}) vs. what you paid`;
    } else {
      changeEl.textContent = '';
    }

    if (!state.items.length && pts.every(([, v]) => !v)) {
      empty.hidden = false;
      empty.textContent = 'Add cards to see your portfolio value over time.';
      return;
    }
    empty.hidden = pts.length >= 2;
    if (pts.length < 2) {
      empty.textContent = 'Your value history builds each day you check in — come back tomorrow to see the trend.';
    }

    const padT = 12, padB = 22, padX = 4;
    const vals = pts.map(([, v]) => v);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 1) { min -= 1; max += 1; }
    const span = max - min; min -= span * 0.1; max += span * 0.08;
    const times = pts.map(([d]) => Date.parse(d));
    const t0 = times[0], t1 = times.at(-1) === t0 ? t0 + 864e5 : times.at(-1);
    const x = (t) => padX + ((t - t0) / (t1 - t0)) * (W - padX * 2);
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
    const up = vals.at(-1) >= vals[0];
    const color = up ? 'var(--up)' : 'var(--down)';
    const ns = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

    // Recessive gridlines
    for (let i = 0; i < 3; i++) {
      const gy = padT + (i / 2) * (H - padT - padB);
      svg.appendChild(el('line', { x1: 0, x2: W, y1: gy, y2: gy, stroke: 'var(--line)', 'stroke-width': 1, 'stroke-dasharray': '2 4' }));
    }

    if (pts.length >= 2) {
      const defs = el('defs', {});
      const grad = el('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.appendChild(el('stop', { offset: '0%', 'stop-color': up ? '#2fd17c' : '#ff5a6a', 'stop-opacity': 0.28 }));
      grad.appendChild(el('stop', { offset: '100%', 'stop-color': up ? '#2fd17c' : '#ff5a6a', 'stop-opacity': 0 }));
      defs.appendChild(grad); svg.appendChild(defs);
      const line = pts.map(([, v], i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
      svg.appendChild(el('path', { d: `${line}L${x(times.at(-1))},${H - padB}L${x(t0)},${H - padB}Z`, fill: 'url(#areaGrad)' }));
      svg.appendChild(el('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }
    // Endpoint marker
    svg.appendChild(el('circle', { cx: x(times.at(-1)), cy: y(vals.at(-1)), r: 4.5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2 }));

    // Axis labels (first / last date)
    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const lbl = (txt, xx, anchor) => { const t = el('text', { x: xx, y: H - 4, fill: 'var(--text-3)', 'font-size': 11, 'text-anchor': anchor }); t.textContent = txt; svg.appendChild(t); };
    lbl(fmt(t0), padX, 'start');
    if (pts.length >= 2) lbl(fmt(times.at(-1)), W - padX, 'end');

    // Crosshair + tooltip
    const cross = el('line', { y1: padT - 6, y2: H - padB, stroke: 'var(--text-3)', 'stroke-width': 1, visibility: 'hidden' });
    const dot = el('circle', { r: 5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
    svg.append(cross, dot);
    const tip = $('#chartTip');
    const show = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      let best = 0;
      times.forEach((t, i) => { if (Math.abs(x(t) - px) < Math.abs(x(times[best]) - px)) best = i; });
      const cx = x(times[best]), cy = y(vals[best]);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '';
      const s = document.createElement('strong'); s.textContent = money(vals[best]);
      const sp = document.createElement('span'); sp.textContent = new Date(times[best]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      tip.append(s, sp);
      const left = Math.min(Math.max((cx / W) * r.width, tip.offsetWidth / 2), r.width - tip.offsetWidth / 2);
      tip.style.left = left + 'px';
      tip.style.top = '-8px';
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    svg.onpointermove = (e) => show(e.clientX);
    svg.onpointerdown = (e) => show(e.clientX);
    svg.onpointerleave = hide;
  }
  $$('.range-tabs button').forEach((b) => b.addEventListener('click', () => {
    chartRange = +b.dataset.range;
    $$('.range-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderChart();
  }));
  window.addEventListener('resize', () => { if ($('#view-portfolio').classList.contains('active')) renderChart(); });

  function renderList() {
    const filter = $('#filterInput').value.trim().toLowerCase();
    const sort = $('#sortSelect').value;
    let items = state.items.filter((it) => !filter || `${it.card.name} ${it.card.set?.name} ${it.card.number}`.toLowerCase().includes(filter));
    const cmp = {
      value: (a, b) => itemValue(b) - itemValue(a),
      recent: (a, b) => b.addedAt - a.addedAt,
      name: (a, b) => a.card.name.localeCompare(b.card.name),
      set: (a, b) => (b.card.set?.releaseDate || '').localeCompare(a.card.set?.releaseDate || '') || a.card.number.localeCompare(b.card.number, undefined, { numeric: true }),
      gain: (a, b) => (itemValue(b) - itemCost(b)) - (itemValue(a) - itemCost(a)),
    }[sort];
    items = items.sort(cmp);
    const list = $('#cardList');
    list.innerHTML = items.map((it) => {
      const c = it.card, price = itemPrice(it), gain = itemValue(it) - itemCost(it);
      const gainHtml = it.purchasePrice ? `<div class="g ${gain > 0 ? 'up' : gain < 0 ? 'down' : 'flat'}">${signed(gain)}</div>` : '';
      return `<button class="card-row" data-uid="${esc(it.uid)}">
        <img src="${esc(c.images?.small)}" alt="" loading="lazy">
        <div class="meta">
          <div class="name">${esc(c.name)}</div>
          <div class="sub">${esc(c.set?.name)} · #${esc(c.number)}${c.set?.printedTotal ? '/' + esc(c.set.printedTotal) : ''}</div>
          <div class="chips">
            ${it.qty > 1 ? `<span class="chip qty">×${it.qty}</span>` : ''}
            ${it.variant ? `<span class="chip">${esc(VARIANT_LABELS[it.variant] || it.variant)}</span>` : ''}
            ${c.rarity ? `<span class="chip">${esc(c.rarity)}</span>` : ''}
          </div>
        </div>
        <div class="price">
          <div class="v">${price == null ? '—' : money(price * it.qty)}</div>
          ${it.qty > 1 && price != null ? `<div class="muted">${money(price)} ea</div>` : ''}
          ${gainHtml}
        </div>
      </button>`;
    }).join('') || (state.items.length ? '<p class="muted" style="text-align:center;padding:16px">No cards match that filter.</p>' : '');
  }
  $('#filterInput').addEventListener('input', renderList);
  $('#sortSelect').addEventListener('change', renderList);
  $('#cardList').addEventListener('click', (e) => {
    const row = e.target.closest('.card-row');
    if (row) openSheet({ item: state.items.find((i) => i.uid === row.dataset.uid) });
  });
  $('#refreshBtn').addEventListener('click', () => {
    if (!state.items.length) return toast('Add some cards first');
    refreshPrices();
  });

  /* ---------------- Search results ---------------- */
  let lastResults = [];
  async function runSearch(parsed, label) {
    const head = $('#resultsHead'), grid = $('#results');
    head.hidden = false;
    head.textContent = label ? `Searching for ${label}…` : 'Searching…';
    grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
    try {
      const { cards } = await findCards(parsed);
      lastResults = cards;
      if (!cards.length) {
        head.textContent = `No cards found${label ? ` for ${label}` : ''}. Try the name plus number, e.g. “Pikachu 58/102”.`;
        grid.innerHTML = '';
        return cards;
      }
      head.textContent = `${cards.length}${cards.length >= 36 ? '+' : ''} match${cards.length === 1 ? '' : 'es'}${label ? ` for ${label}` : ''} — tap a card to add it`;
      grid.innerHTML = cards.map((c, i) => {
        const p = marketPrice(c);
        return `<button class="result" data-i="${i}">
          <img src="${esc(c.images?.small)}" alt="" loading="lazy">
          <div class="name">${esc(c.name)}</div>
          <div class="sub">${esc(c.set?.name)} · #${esc(c.number)}</div>
          <div class="p">${p == null ? '<span class="muted">No price</span>' : money(p)}</div>
        </button>`;
      }).join('');
      return cards;
    } catch (e) {
      head.textContent = 'Couldn’t reach the card database. Check your connection and try again.';
      grid.innerHTML = '';
      return [];
    }
  }
  $('#results').addEventListener('click', (e) => {
    const r = e.target.closest('.result');
    if (r) openSheet({ card: lastResults[+r.dataset.i] });
  });
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#searchInput').value.trim();
    if (!text) return;
    $('#searchInput').blur();
    runSearch(parseSearchText(text), `“${text}”`);
  });

  /* ---------------- Camera + OCR scanning ---------------- */
  let stream = null;
  const video = $('#video');
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#scannerMsg').textContent = 'Live camera isn’t available in this browser. Use “Photo” to snap or upload a picture of your card.';
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      $('#scannerOff').hidden = true;
      $('#shutterBtn').disabled = false;
      $('#stopCamBtn').disabled = false;
      getOcrWorker().catch(() => {}); // warm up OCR while the user lines up the card
    } catch (e) {
      $('#scannerMsg').textContent = e.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access, or use “Photo” instead.'
        : 'Couldn’t start the camera. Use “Photo” to snap or upload a picture instead.';
    }
  }
  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    $('#scannerOff').hidden = false;
    $('#shutterBtn').disabled = true;
    $('#stopCamBtn').disabled = true;
  }
  $('#startCamBtn').addEventListener('click', startCamera);
  $('#stopCamBtn').addEventListener('click', stopCamera);

  // Grab the region of the video under the on-screen card frame.
  function captureFrame() {
    const scanner = $('.scanner').getBoundingClientRect();
    const frame = $('.scan-frame').getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(scanner.width / vw, scanner.height / vh); // object-fit: cover
    const offX = (scanner.width - vw * s) / 2, offY = (scanner.height - vh * s) / 2;
    const sx = (frame.left - scanner.left - offX) / s, sy = (frame.top - scanner.top - offY) / s;
    const sw = frame.width / s, sh = frame.height / s;
    const c = $('#captureCanvas');
    c.width = Math.round(sw); c.height = Math.round(sh);
    c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  let workerPromise = null;
  function getOcrWorker() {
    if (!workerPromise) {
      workerPromise = (async () => {
        for (let i = 0; i < 50 && !window.Tesseract; i++) await new Promise((r) => setTimeout(r, 100));
        if (!window.Tesseract) throw new Error('OCR library failed to load');
        return window.Tesseract.createWorker('eng');
      })();
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  // Crop a band of the card (fractions of width/height), upscale + grayscale for OCR.
  function band(src, x0, y0, x1, y1, scale = 2.2) {
    const w = (x1 - x0) * src.width, h = (y1 - y0) * src.height;
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, x0 * src.width, y0 * src.height, w, h, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) { const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = g; sum += g; }
    // Normalise so dark text on light or light text on dark both become dark-on-light.
    const mean = sum / (d.length / 4);
    if (mean < 110) for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
    ctx.putImageData(img, 0, 0);
    return c;
  }

  const NAME_NOISE = new Set(['basic', 'stage', 'evolves', 'from', 'hp', 'pokemon', 'trainer', 'energy', 'item', 'supporter', 'stadium', 'tool', 'put', 'this', 'card', 'on', 'the', 'and', 'of', 'tera', 'restored', 'baby', 'level', 'lv', 'ability']);
  function parseName(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const words = line.replace(/[^A-Za-zÀ-ÿ'.\- ]/g, ' ').split(/\s+/)
        .filter((w) => w.replace(/[^A-Za-z]/g, '').length >= 3 && !NAME_NOISE.has(w.toLowerCase().replace(/[^a-z]/g, '')));
      if (words.length) return words.slice(0, 2).join(' ').replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    }
    return '';
  }
  function parseNumber(text) {
    const t = text.replace(/[|\\]/g, '/').replace(/[oO](?=\d)|(?<=\d)[oO]/g, '0');
    const m = t.match(/([A-Z]{0,3}\d{1,3}[a-z]?)\s*\/\s*([A-Z]{0,3}\d{1,3})/);
    if (m) return { number: normNumber(m[1]), total: /^\d+$/.test(m[2]) ? String(+m[2]) : null };
    const promo = t.match(/\b(SWSH|SM|XY|BW|SVP|SV|HGSS|DP)\s?(\d{1,3})\b/i);
    if (promo) return { number: (promo[1] + promo[2].padStart(promo[1].toUpperCase().startsWith('SW') || promo[1].toUpperCase() === 'SV' ? 3 : 2, '0')).toUpperCase(), total: null };
    return { number: null, total: null };
  }

  async function scanCanvas(card, { wholeImage = false } = {}) {
    const status = $('#scanStatus');
    const scanner = $('.scanner');
    status.hidden = false;
    status.textContent = 'Reading card…';
    scanner.classList.add('busy');
    $('#shutterBtn').disabled = true;
    try {
      const worker = await getOcrWorker();
      const read = async (canvas, psm) => {
        await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
        return (await worker.recognize(canvas)).data.text || '';
      };
      let name = '', number = null, total = null;
      if (!wholeImage) {
        // Name sits in the top band; collector number in the bottom band.
        name = parseName(await read(band(card, 0.04, 0.025, 0.74, 0.12), 7));
        ({ number, total } = parseNumber(await read(band(card, 0.02, 0.86, 0.98, 0.985, 2.6), 11)));
      }
      if (!name || !number) {
        const full = await read(band(card, 0, 0, 1, 1, 1.4), 3);
        if (!name) name = parseName(full);
        if (!number) ({ number, total } = parseNumber(full));
      }
      if (!name && !number) {
        status.textContent = 'Couldn’t read that card. Fill the frame, avoid glare, and hold steady — or search by name below.';
        return;
      }
      const label = [name, number && (total ? `${number}/${total}` : `#${number}`)].filter(Boolean).join(' ');
      status.textContent = `Detected: ${label}`;
      const cards = await runSearch({ name, number, total }, label);
      if (cards.length === 1) openSheet({ card: cards[0] });
      else if (cards.length) $('#resultsHead').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      status.textContent = 'Scanner couldn’t start (OCR failed to load). You can still search by name below.';
    } finally {
      scanner.classList.remove('busy');
      $('#shutterBtn').disabled = !stream;
    }
  }
  $('#shutterBtn').addEventListener('click', () => {
    if (!stream || !video.videoWidth) return;
    scanCanvas(captureFrame());
  });
  $('#photoInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const img = await createImageBitmap(file).catch(() => null);
    if (!img) return toast('Couldn’t open that image');
    const c = $('#captureCanvas');
    const max = 1600, s = Math.min(1, max / Math.max(img.width, img.height));
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    // A tight card photo has card proportions; anything else gets a whole-image read.
    const ratio = c.width / c.height;
    scanCanvas(c, { wholeImage: Math.abs(ratio - 63 / 88) > 0.06 });
  });

  /* ---------------- Detail / add sheet ---------------- */
  let sheetCtx = null;
  function openSheet({ card, item }) {
    const isOwned = !!item;
    const c = isOwned ? item.card : card;
    const variants = variantsOf(c);
    sheetCtx = {
      card: c, item,
      variant: isOwned ? item.variant : defaultVariant(c),
      qty: isOwned ? item.qty : 1,
      condition: isOwned ? item.condition : CONDITIONS[0],
      purchasePrice: isOwned ? item.purchasePrice : null,
    };
    if (!isOwned) sheetCtx.purchasePrice = marketPrice(c, sheetCtx.variant);
    const owned = state.items.filter((i) => i.cardId === c.id).reduce((n, i) => n + i.qty, 0);

    const set = c.set || {};
    const tcg = c.tcgplayer || {}, cm = c.cardmarket || {};
    const info = [
      ['Set', set.name], ['Series', set.series],
      ['Number', c.number + (set.printedTotal ? ` / ${set.printedTotal}` : '')], ['Rarity', c.rarity],
      ['Released', set.releaseDate && new Date(set.releaseDate.replace(/\//g, '-')).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })],
      ['Artist', c.artist],
      ['Type', [c.supertype, ...(c.subtypes || [])].filter(Boolean).join(' · ')],
      ['HP', c.hp], ['Energy type', (c.types || []).join(', ')],
      ['Evolves from', c.evolvesFrom],
      ['Weakness', (c.weaknesses || []).map((w) => `${w.type} ${w.value}`).join(', ')],
      ['Resistance', (c.resistances || []).map((w) => `${w.type} ${w.value}`).join(', ')],
      ['Retreat', c.retreatCost?.length], ['Pokédex #', (c.nationalPokedexNumbers || []).join(', ')],
      ['Regulation', c.regulationMark],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');

    const cmRows = [['Trend', cm.prices?.trendPrice], ['Avg sell', cm.prices?.averageSellPrice], ['30-day avg', cm.prices?.avg30], ['Low', cm.prices?.lowPrice]]
      .filter(([, v]) => v != null);

    $('#sheetBody').innerHTML = `
      <div class="detail-top">
        <img class="detail-img" src="${esc(c.images?.large || c.images?.small)}" alt="${esc(c.name)} card">
        <h2 class="detail-name" id="sheetTitle">${esc(c.name)}</h2>
        <div class="detail-set">
          ${set.images?.symbol ? `<img src="${esc(set.images.symbol)}" alt="">` : ''}
          <span>${esc(set.name)} · #${esc(c.number)}${set.printedTotal ? '/' + esc(set.printedTotal) : ''}</span>
        </div>
        <div class="detail-price" id="sheetPrice"></div>
        <div class="detail-price-label" id="sheetPriceLabel"></div>
        ${owned && !isOwned ? `<div class="chip qty" style="margin-top:8px">You own ${owned}</div>` : ''}
      </div>

      ${variants.length > 1 ? `<div class="section"><h4>Printing</h4><div class="seg" id="variantSeg">
        ${variants.map((v) => `<button type="button" data-v="${esc(v)}">${esc(VARIANT_LABELS[v] || v)}</button>`).join('')}
      </div></div>` : ''}

      <div class="section">
        <h4>${isOwned ? 'In your portfolio' : 'Add to portfolio'}</h4>
        <div class="form-row">
          <div class="field"><label for="qtyInput">Quantity</label>
            <div class="stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button><input id="qtyInput" type="number" min="1" inputmode="numeric" value="${sheetCtx.qty}"><button type="button" data-step="1" aria-label="Increase">+</button></div>
          </div>
          <div class="field"><label for="condSelect">Condition</label>
            <select id="condSelect">${CONDITIONS.map((x) => `<option ${x === sheetCtx.condition ? 'selected' : ''}>${x}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field" style="margin-top:10px"><label for="paidInput">Price paid (each, USD)</label>
          <input id="paidInput" type="number" min="0" step="0.01" inputmode="decimal" placeholder="Optional" value="${sheetCtx.purchasePrice != null ? sheetCtx.purchasePrice.toFixed(2) : ''}">
        </div>
        <div class="actions">
          ${isOwned
            ? `<button class="btn primary block" id="saveBtn">Save changes</button><button class="btn danger block" id="removeBtn">Remove from portfolio</button>`
            : `<button class="btn primary block" id="addBtn">Add to portfolio</button>`}
        </div>
      </div>

      <div class="section"><h4>Market prices · TCGplayer (USD)</h4>
        ${variants.length ? `<table class="price-table" id="priceTable">
          <thead><tr><th>Printing</th><th>Market</th><th>Low</th><th>Mid</th><th>High</th></tr></thead>
          <tbody>${variants.map((v) => { const p = tcg.prices[v]; return `<tr data-v="${esc(v)}"><td>${esc(VARIANT_LABELS[v] || v)}</td><td class="mk">${money(p.market)}</td><td>${money(p.low)}</td><td>${money(p.mid)}</td><td>${money(p.high)}</td></tr>`; }).join('')}</tbody>
        </table>
        <p class="muted">Updated ${esc(tcg.updatedAt || '—')}</p>` : '<p class="muted">No TCGplayer price data for this card yet.</p>'}
      </div>

      ${cmRows.length ? `<div class="section"><h4>Cardmarket (EUR)</h4>
        <table class="price-table"><tbody>${cmRows.map(([k, v]) => `<tr><td>${k}</td><td class="mk">${eur.format(v)}</td></tr>`).join('')}</tbody></table>
        <p class="muted">Updated ${esc(cm.updatedAt || '—')}</p></div>` : ''}

      <div class="section"><h4>Card details</h4>
        <div class="info-grid">${info.map(([k, v]) => `<div class="info"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
      </div>

      ${(c.abilities?.length || c.attacks?.length) ? `<div class="section"><h4>Abilities & attacks</h4>
        ${(c.abilities || []).map((a) => `<div class="attack"><div class="attack-head"><span><span class="ability-tag">${esc(a.type || 'Ability')}</span>${esc(a.name)}</span></div><p>${esc(a.text)}</p></div>`).join('')}
        ${(c.attacks || []).map((a) => `<div class="attack"><div class="attack-head"><span>${esc(a.name)}</span><span>${esc(a.damage || '')}</span></div>${a.cost?.length ? `<p class="muted" style="margin-top:2px">Cost: ${esc(a.cost.join(', '))}</p>` : ''}${a.text ? `<p>${esc(a.text)}</p>` : ''}</div>`).join('')}
      </div>` : ''}

      ${c.rules?.length ? `<div class="section"><h4>Rules</h4>${c.rules.map((r) => `<p class="flavor" style="font-style:normal">${esc(r)}</p>`).join('')}</div>` : ''}
      ${c.flavorText ? `<div class="section"><h4>Flavor text</h4><p class="flavor">${esc(c.flavorText)}</p></div>` : ''}

      <div class="section links">
        ${tcg.url ? `<a href="${esc(tcg.url)}" target="_blank" rel="noopener">View on TCGplayer ↗</a>` : ''}
        ${cm.url ? `<a href="${esc(cm.url)}" target="_blank" rel="noopener">View on Cardmarket ↗</a>` : ''}
      </div>
    `;
    updateSheetPrice();

    const body = $('#sheetBody');
    $('.detail-img', body).addEventListener('click', (e) => e.currentTarget.classList.toggle('zoom'));
    $$('#variantSeg button', body).forEach((b) => b.addEventListener('click', () => {
      const prevMarket = marketPrice(c, sheetCtx.variant);
      sheetCtx.variant = b.dataset.v;
      // When adding, keep "price paid" tracking market unless the user typed their own.
      const paid = $('#paidInput');
      if (!isOwned && (paid.value === '' || +paid.value === +(prevMarket ?? NaN).toFixed(2))) {
        const m = marketPrice(c, sheetCtx.variant);
        paid.value = m != null ? m.toFixed(2) : '';
      }
      updateSheetPrice();
    }));
    $$('[data-step]', body).forEach((b) => b.addEventListener('click', () => {
      const q = $('#qtyInput');
      q.value = Math.max(1, (parseInt(q.value, 10) || 1) + +b.dataset.step);
      updateSheetPrice();
    }));
    $('#qtyInput').addEventListener('input', updateSheetPrice);

    const readForm = () => ({
      qty: Math.max(1, parseInt($('#qtyInput').value, 10) || 1),
      condition: $('#condSelect').value,
      purchasePrice: $('#paidInput').value === '' ? null : Math.max(0, +$('#paidInput').value),
      variant: sheetCtx.variant,
    });
    $('#addBtn')?.addEventListener('click', () => {
      const f = readForm();
      state.items.push({ uid: uid(), cardId: c.id, card: c, addedAt: Date.now(), ...f });
      if (!state.pricesUpdatedAt) state.pricesUpdatedAt = Date.now();
      recordSnapshot();
      closeSheet();
      toast(`Added ${c.name} · ${money((marketPrice(c, f.variant) || 0) * f.qty)}`);
    });
    $('#saveBtn')?.addEventListener('click', () => {
      Object.assign(item, readForm());
      recordSnapshot();
      closeSheet();
      renderPortfolio();
      toast('Saved');
    });
    $('#removeBtn')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.confirm !== '1') {
        btn.dataset.confirm = '1';
        btn.textContent = `Tap again to remove ${item.qty > 1 ? `all ${item.qty}` : 'this card'}`;
        return;
      }
      state.items = state.items.filter((i) => i.uid !== item.uid);
      recordSnapshot();
      closeSheet();
      renderPortfolio();
      toast(`Removed ${c.name}`);
    });

    $('#sheetBackdrop').hidden = false;
    $('#sheet').hidden = false;
    $('#sheet').scrollTop = 0;
    document.body.style.overflow = 'hidden';
    $('#sheetClose').focus();
  }
  function updateSheetPrice() {
    const { card, variant } = sheetCtx;
    const p = marketPrice(card, variant);
    const qty = Math.max(1, parseInt($('#qtyInput')?.value, 10) || 1);
    $('#sheetPrice').textContent = p == null ? 'No price yet' : money(p * qty);
    $('#sheetPriceLabel').textContent = p == null ? '' : `Market price${variant ? ` · ${VARIANT_LABELS[variant] || variant}` : ''}${qty > 1 ? ` · ${qty} × ${money(p)}` : ''}`;
    $$('#variantSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === variant));
    $$('#priceTable tbody tr').forEach((r) => r.classList.toggle('sel', r.dataset.v === variant));
  }
  function closeSheet() {
    $('#sheet').hidden = true;
    $('#sheetBackdrop').hidden = true;
    document.body.style.overflow = '';
    sheetCtx = null;
  }
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheetBackdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  /* ---------------- Misc ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  function timeAgo(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  renderPortfolio();
  if (state.items.length && Date.now() - state.pricesUpdatedAt > STALE_MS) refreshPrices({ silent: true });
  else if (state.items.length) recordSnapshot();
})();
