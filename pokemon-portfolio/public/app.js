/* PokéFolio — Pokémon card portfolio tracker (frontend)
 * Talks to the PokéFolio server (server.js) for accounts, portfolio sync, card search
 * and prices. Raw (ungraded) prices drive the portfolio total; graded prices
 * (PSA 10, Grade 9 … 1, BGS/CGC/SGC 10) come from PriceCharting and show on each card.
 */
(() => {
  'use strict';

  const GUEST_KEY = 'pokefolio.v1';
  const GUEST_FLAG = 'pokefolio.guest';
  const STALE_MS = 6 * 60 * 60 * 1000;
  const PRICE_VERSION = 2; // bump when price matching changes so saved prices get recomputed

  const VARIANT_LABELS = {
    normal: 'Normal', holofoil: 'Holofoil', reverseHolofoil: 'Reverse Holo',
    '1stEditionHolofoil': '1st Edition Holo', '1stEditionNormal': '1st Edition', unlimitedHolofoil: 'Unlimited Holo',
    '1stEdition': '1st Edition', unlimited: 'Unlimited',
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
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const e = new Error(json?.error || `Request failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  /* ================= Session & storage ================= */
  let user = null; // null = guest
  const emptyState = () => ({ items: [], history: {}, pricesUpdatedAt: 0, updatedAt: 0 });
  let state = emptyState();
  const storeKey = () => (user ? `pokefolio.u.${user.id}` : GUEST_KEY);

  function loadLocal(key = storeKey()) {
    try {
      const s = JSON.parse(lsGet(key));
      if (s && Array.isArray(s.items)) return { ...emptyState(), ...s };
    } catch { /* corrupt */ }
    return emptyState();
  }

  let syncTimer = null;
  function save() {
    state.updatedAt = Date.now();
    lsSet(storeKey(), JSON.stringify(state));
    if (user) {
      setSync('busy', 'Syncing…');
      clearTimeout(syncTimer);
      syncTimer = setTimeout(pushRemote, 700);
    }
  }
  async function pushRemote() {
    if (!user) return;
    try {
      await api('/api/portfolio', { method: 'PUT', body: { items: state.items, history: state.history, pricesUpdatedAt: state.pricesUpdatedAt, priceVersion: state.priceVersion } });
      setSync('ok', 'Synced');
    } catch (e) {
      if (e.status === 401) return signedOut('Your session expired — please sign in again.');
      setSync('err', 'Offline — will retry');
      clearTimeout(syncTimer);
      syncTimer = setTimeout(pushRemote, 15000);
    }
  }
  function setSync(cls, text) {
    const el = $('#syncState');
    el.className = `sync ${cls}`;
    el.textContent = text;
  }

  async function loadForUser() {
    const local = loadLocal();
    let remote = null;
    try { remote = await api('/api/portfolio'); } catch (e) { if (e.status === 401) return signedOut(); }
    state = remote && (remote.updatedAt || 0) >= (local.updatedAt || 0) ? { ...emptyState(), ...remote } : local;

    // Bring over cards collected while signed out.
    const guest = loadLocal(GUEST_KEY);
    if (guest.items.length) {
      const have = new Set(state.items.map((i) => i.uid));
      const add = guest.items.filter((i) => !have.has(i.uid));
      state.items.push(...add);
      for (const [d, v] of Object.entries(guest.history)) if (state.history[d] == null) state.history[d] = v;
      lsDel(GUEST_KEY);
      if (add.length) setTimeout(() => toast(`Imported ${add.length} card${add.length === 1 ? '' : 's'} into your account`), 400);
    }
    lsSet(storeKey(), JSON.stringify(state));
    if (!remote || guest.items.length || (local.updatedAt || 0) > (remote.updatedAt || 0)) pushRemote();
    else setSync('ok', 'Synced');
  }

  /* ================= Auth UI ================= */
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    $$('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('.auth-tabs').classList.toggle('signup', mode === 'signup');
    $('#nameField').hidden = mode !== 'signup';
    $('#authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    $('#authPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('#authError').hidden = true;
  }
  $$('.auth-tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#authError');
    const btn = $('#authSubmit');
    const body = { email: $('#authEmail').value, password: $('#authPassword').value, name: $('#authName').value };
    err.hidden = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) { err.textContent = 'Enter a valid email address.'; err.hidden = false; return; }
    if (body.password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; err.hidden = false; return; }
    btn.disabled = true;
    btn.textContent = authMode === 'signup' ? 'Creating account…' : 'Signing in…';
    try {
      const res = await api(`/api/auth/${authMode === 'signup' ? 'signup' : 'login'}`, { method: 'POST', body });
      user = res.user;
      lsDel(GUEST_FLAG);
      $('#authPassword').value = '';
      await enterApp();
      toast(authMode === 'signup' ? `Welcome, ${user.name}!` : `Welcome back, ${user.name}`);
    } catch (ex) {
      err.textContent = ex.status ? ex.message : 'Can’t reach the PokéFolio server.';
      err.hidden = false;
    } finally {
      btn.disabled = false;
      setAuthMode(authMode);
    }
  });
  $('#guestBtn').addEventListener('click', () => {
    lsSet(GUEST_FLAG, '1');
    user = null;
    enterApp();
  });

  function showAuth(message) {
    stopCamera();
    closeSheet();
    $('#app').hidden = true;
    $('#auth').hidden = false;
    setAuthMode('login');
    if (message) { $('#authError').textContent = message; $('#authError').hidden = false; }
  }
  function signedOut(message) {
    user = null;
    state = emptyState();
    showAuth(message);
  }

  async function enterApp() {
    if (user) await loadForUser();
    else { state = loadLocal(GUEST_KEY); setSync('', 'Saved on this device'); }
    renderAvatar();
    $('#auth').hidden = true;
    $('#app').hidden = false;
    go('portfolio');
    if (state.items.length && (Date.now() - state.pricesUpdatedAt > STALE_MS || state.priceVersion !== PRICE_VERSION)) refreshPrices({ silent: true });
    else if (state.items.length) recordSnapshot();
  }

  function initials() {
    return user ? (user.name || user.email).trim().charAt(0).toUpperCase() : '';
  }
  function renderAvatar() {
    const a = $('#accountBtn');
    a.classList.toggle('guest', !user);
    a.innerHTML = user ? esc(initials()) : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
  }
  $('#accountBtn').addEventListener('click', openAccount);

  function openAccount() {
    const t = totals();
    $('#sheetBody').innerHTML = user ? `
      <div class="acct">
        <div class="avatar">${esc(initials())}</div>
        <h3 id="sheetTitle">${esc(user.name)}</h3>
        <p>${esc(user.email)}</p>
        <div class="acct-grid">
          <div class="info"><div class="k">Cards</div><div class="v num">${t.count}</div></div>
          <div class="info"><div class="k">Raw value</div><div class="v num">${money(t.value)}</div></div>
          <div class="info"><div class="k">Member since</div><div class="v">${new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div></div>
          <div class="info"><div class="k">Sync</div><div class="v">${esc($('#syncState').textContent || '—')}</div></div>
        </div>
        <div class="actions"><button class="btn danger block" id="logoutBtn">Sign out</button></div>
      </div>` : `
      <div class="acct">
        <div class="avatar guest">?</div>
        <h3 id="sheetTitle">Guest mode</h3>
        <p>Your cards are only saved in this browser.</p>
        <p class="note">Create a free account to back up your collection and use it on any device — the cards you've added so far come with you.</p>
        <div class="actions">
          <button class="btn primary glow block" id="toSignup">Create account</button>
          <button class="btn block" id="toLogin">Sign in</button>
        </div>
      </div>`;
    openSheetShell();
    $('#logoutBtn')?.addEventListener('click', async () => {
      clearTimeout(syncTimer);
      await pushRemote().catch(() => {});
      await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
      lsDel(storeKey());
      signedOut();
      toast('Signed out');
    });
    $('#toSignup')?.addEventListener('click', () => { showAuth(); setAuthMode('signup'); });
    $('#toLogin')?.addEventListener('click', () => { showAuth(); setAuthMode('login'); });
  }

  /* ================= Pricing ================= */
  const rawCache = new Map(); // `${id}|${variant}` -> { price, source }

  function variantsOf(card) {
    const p = card?.tcgplayer?.prices || {};
    return Object.keys(p).filter((k) => p[k] && (p[k].market != null || p[k].mid != null || p[k].low != null));
  }
  // Same order as the server: unlimited before 1st Edition, since 1st Edition copies are rare
  // and priced far higher.
  const VARIANT_ORDER = ['holofoil', 'normal', 'unlimitedHolofoil', 'unlimited', 'reverseHolofoil', '1stEditionHolofoil', '1stEditionNormal', '1stEdition'];
  function defaultVariant(card) {
    const p = card?.tcgplayer?.prices || {};
    const priced = Object.keys(p).filter((k) => p[k]?.market != null);
    const v = priced.length ? priced : variantsOf(card);
    return VARIANT_ORDER.find((k) => v.includes(k)) || v[0] || null;
  }
  // TCGplayer market price for exactly this printing. ("mid" is the middle of current listings,
  // which can be far above what cards actually sell for, so it's never used as a value.)
  function tcgPrice(card, variant) {
    const p = card?.tcgplayer?.prices?.[variant || defaultVariant(card)];
    return p?.market ?? null;
  }
  // Best known raw price for a card (search result / sheet): TCGplayer in the card, else server lookup.
  function knownRaw(card, variant) {
    const t = tcgPrice(card, variant);
    if (t != null) return { price: t, source: 'TCGplayer' };
    return rawCache.get(`${card.id}|${variant || ''}`) || null;
  }
  function itemPrice(item) {
    if (item.rawPrice != null) return item.rawPrice;
    return knownRaw(item.card, item.variant)?.price ?? null;
  }
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

  async function fetchRaw(list) {
    const res = await api('/api/prices/raw', { method: 'POST', body: { cards: list.map(({ id, variant }) => ({ id, variant: variant || null })) } });
    for (const [k, v] of Object.entries(res.prices || {})) if (v && v.price != null) rawCache.set(k, v);
    return res.prices || {};
  }

  async function refreshPrices({ silent = false } = {}) {
    if (!state.items.length) return;
    const btn = $('#refreshBtn');
    btn.classList.add('spinning');
    try {
      const prices = await fetchRaw(state.items.map((i) => ({ id: i.cardId, variant: i.variant })));
      let found = 0;
      for (const it of state.items) {
        const p = prices[`${it.cardId}|${it.variant || ''}`];
        if (p && p.price != null) { it.rawPrice = p.price; it.priceSource = p.source; found++; }
      }
      state.pricesUpdatedAt = Date.now();
      state.priceVersion = PRICE_VERSION;
      recordSnapshot();
      renderPortfolio();
      if (!silent) toast(`Prices updated · ${found}/${state.items.length} cards priced`);
    } catch (e) {
      if (!silent) toast('Couldn’t refresh prices — try again shortly');
    } finally {
      btn.classList.remove('spinning');
    }
  }

  /* ================= Card search ================= */
  async function findCards({ name, number, total }) {
    const params = new URLSearchParams();
    if (name) params.set('name', name);
    if (number) params.set('number', number);
    if (total) params.set('total', total);
    return (await api(`/api/search?${params}`)).data || [];
  }
  function normNumber(n) { return /^\d+$/.test(n) ? String(+n) : n.toUpperCase(); }
  function promoNumber(prefix, digits) {
    const p = prefix.toUpperCase();
    return p + digits.padStart(p.startsWith('SW') || p === 'SV' ? 3 : 2, '0');
  }
  function parseSearchText(text) {
    let t = ` ${text.trim()} `;
    let number = null, total = null;
    const slash = t.match(/\s#?([a-z]{0,3}\d{1,3}[a-z]?)\s*\/\s*([a-z]{0,3}\d{1,3})\s/i);
    if (slash) { number = normNumber(slash[1]); total = /^\d+$/.test(slash[2]) ? String(+slash[2]) : null; t = t.replace(slash[0], ' '); }
    else {
      const promo = t.match(/\s(swsh|sm|xy|bw|svp?|hgss|dp|tg|gg|rc)\s?(\d{1,3})\s/i);
      const plain = t.match(/\s#?(\d{1,3})\s/);
      if (promo) { number = promoNumber(promo[1], promo[2]); t = t.replace(promo[0], ' '); }
      else if (plain) { number = normNumber(plain[1]); t = t.replace(plain[0], ' '); }
    }
    return { name: t.trim(), number, total };
  }

  /* ================= Navigation ================= */
  function go(view, { focusSearch = false } = {}) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.goto === view && ('focusSearch' in t.dataset) === focusSearch));
    $('#view-scan').classList.toggle('search-mode', view === 'scan' && focusSearch);
    if (view !== 'scan' || focusSearch) stopCamera();
    else if (!stream) startCamera();
    if (view === 'portfolio') renderPortfolio();
    if (focusSearch) setTimeout(() => $('#searchInput').focus(), 50);
    window.scrollTo({ top: 0 });
  }
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) go(g.dataset.goto, { focusSearch: 'focusSearch' in g.dataset });
  });

  /* ================= Portfolio ================= */
  let chartRange = 30;
  function renderPortfolio() {
    const { value, cost, count } = totals();
    $('#totalValue').textContent = money(value);
    $('#statCards').textContent = count;
    $('#statCost').textContent = money(cost);
    const gain = value - cost;
    const statGain = $('#statGain');
    statGain.textContent = cost ? signed(gain) : '—';
    statGain.className = 'stat-value num ' + (cost ? (gain > 0 ? 'up' : gain < 0 ? 'down' : 'flat') : '');
    const unpriced = state.items.filter((i) => itemPrice(i) == null).length;
    $('#priceUpdated').textContent = state.items.length
      ? `Raw market prices · TCGplayer / PriceCharting${state.pricesUpdatedAt ? ` · updated ${timeAgo(state.pricesUpdatedAt)}` : ''}${unpriced ? ` · ${unpriced} unpriced` : ''}`
      : '';
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
    const W = wrap.clientWidth || 600, H = wrap.clientHeight || 190;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    const changeEl = $('#totalChange');
    const { value, cost } = totals();
    if (pts.length >= 2) {
      const start = pts[0][1], d = value - start;
      const label = { 7: 'past week', 30: 'past month', 90: 'past 3 months', 365: 'past year', 0: 'all time' }[chartRange];
      changeEl.className = 'hero-change num ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
      changeEl.textContent = `${d >= 0 ? '▲' : '▼'} ${signed(d)} (${start ? pct(d / start) : '—'}) ${label}`;
    } else if (cost) {
      const d = value - cost;
      changeEl.className = 'hero-change num ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat');
      changeEl.textContent = `${d >= 0 ? '▲' : '▼'} ${signed(d)} (${pct(d / cost)}) vs. cost`;
    } else {
      changeEl.textContent = '';
    }

    if (!state.items.length && pts.every(([, v]) => !v)) {
      empty.hidden = false;
      empty.textContent = 'Add cards to see your portfolio value over time.';
      return;
    }
    empty.hidden = pts.length >= 2;
    if (pts.length < 2) empty.textContent = 'Your value history builds each day you check in — come back tomorrow to see the trend.';

    const padT = 14, padB = 22, padX = 6;
    const vals = pts.map(([, v]) => v);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 1) { min -= 1; max += 1; }
    const span = max - min; min -= span * 0.12; max += span * 0.1;
    const times = pts.map(([d]) => Date.parse(d));
    const t0 = times[0], t1 = times.at(-1) === t0 ? t0 + 864e5 : times.at(-1);
    const x = (t) => padX + ((t - t0) / (t1 - t0)) * (W - padX * 2);
    const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
    const up = vals.at(-1) >= vals[0];
    const hex = up ? '#34f5a6' : '#ff4d6d';
    const ns = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

    const defs = el('defs', {});
    const grad = el('linearGradient', { id: 'areaGrad', x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(el('stop', { offset: '0%', 'stop-color': hex, 'stop-opacity': 0.32 }), el('stop', { offset: '100%', 'stop-color': hex, 'stop-opacity': 0 }));
    const glow = el('filter', { id: 'glow', x: '-20%', y: '-50%', width: '140%', height: '200%' });
    glow.append(el('feGaussianBlur', { stdDeviation: 4, result: 'b' }));
    const merge = el('feMerge', {});
    merge.append(el('feMergeNode', { in: 'b' }), el('feMergeNode', { in: 'SourceGraphic' }));
    glow.append(merge);
    defs.append(grad, glow);
    svg.appendChild(defs);

    for (let i = 0; i < 3; i++) {
      const gy = padT + (i / 2) * (H - padT - padB);
      svg.appendChild(el('line', { x1: 0, x2: W, y1: gy, y2: gy, stroke: 'rgba(255,255,255,.06)', 'stroke-width': 1, 'stroke-dasharray': '2 5' }));
    }
    if (pts.length >= 2) {
      const line = pts.map(([, v], i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
      svg.appendChild(el('path', { d: `${line}L${x(times.at(-1))},${H - padB}L${x(t0)},${H - padB}Z`, fill: 'url(#areaGrad)' }));
      svg.appendChild(el('path', { d: line, fill: 'none', stroke: hex, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', filter: 'url(#glow)' }));
    }
    svg.appendChild(el('circle', { cx: x(times.at(-1)), cy: y(vals.at(-1)), r: 4.5, fill: hex, stroke: '#05060b', 'stroke-width': 2, filter: 'url(#glow)' }));

    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const lbl = (txt, xx, anchor) => { const t = el('text', { x: xx, y: H - 4, fill: '#5f6884', 'font-size': 10.5, 'font-family': 'JetBrains Mono, monospace', 'text-anchor': anchor }); t.textContent = txt; svg.appendChild(t); };
    lbl(fmt(t0), padX, 'start');
    if (pts.length >= 2) lbl(fmt(times.at(-1)), W - padX, 'end');

    const cross = el('line', { y1: padT - 6, y2: H - padB, stroke: 'rgba(255,255,255,.25)', 'stroke-width': 1, visibility: 'hidden' });
    const dot = el('circle', { r: 5, fill: hex, stroke: '#05060b', 'stroke-width': 2, visibility: 'hidden' });
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
      tip.style.left = Math.min(Math.max((cx / W) * r.width, tip.offsetWidth / 2), r.width - tip.offsetWidth / 2) + 'px';
      tip.style.top = '-10px';
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
  window.addEventListener('resize', () => { if ($('#view-portfolio').classList.contains('active') && !$('#app').hidden) renderChart(); });

  function renderList() {
    const filter = $('#filterInput').value.trim().toLowerCase();
    const sort = $('#sortSelect').value;
    const items = state.items.filter((it) => !filter || `${it.card.name} ${it.card.set?.name} ${it.card.number}`.toLowerCase().includes(filter));
    const cmp = {
      value: (a, b) => itemValue(b) - itemValue(a),
      recent: (a, b) => b.addedAt - a.addedAt,
      name: (a, b) => a.card.name.localeCompare(b.card.name),
      set: (a, b) => (b.card.set?.releaseDate || '').localeCompare(a.card.set?.releaseDate || '') || a.card.number.localeCompare(b.card.number, undefined, { numeric: true }),
      gain: (a, b) => (itemValue(b) - itemCost(b)) - (itemValue(a) - itemCost(a)),
    }[sort];
    items.sort(cmp);
    $('#cardList').innerHTML = items.map((it) => {
      const c = it.card, price = itemPrice(it), gain = itemValue(it) - itemCost(it);
      const gainHtml = it.purchasePrice && price != null ? `<div class="g num ${gain > 0 ? 'up' : gain < 0 ? 'down' : 'flat'}">${signed(gain)}</div>` : '';
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
          <div class="v num">${price == null ? '<span class="muted">No price</span>' : money(price * it.qty)}</div>
          ${it.qty > 1 && price != null ? `<div class="muted num">${money(price)} ea</div>` : ''}
          ${gainHtml}
        </div>
      </button>`;
    }).join('') || (state.items.length ? '<p class="muted" style="text-align:center;padding:16px">No cards match that filter.</p>' : '');
  }
  $('#filterInput').addEventListener('input', renderList);
  $('#sortSelect').addEventListener('change', renderList);
  $('#cardList').addEventListener('click', (e) => {
    const row = e.target.closest('.card-row');
    if (row) openCard({ item: state.items.find((i) => i.uid === row.dataset.uid) });
  });
  $('#refreshBtn').addEventListener('click', () => {
    if (!state.items.length) return toast('Add some cards first');
    refreshPrices();
  });

  /* ================= Search results ================= */
  let lastResults = [];
  const proxied = (u) => (u ? `/api/img?u=${encodeURIComponent(u)}` : '');
  function resultPriceHtml(c) {
    const r = knownRaw(c, defaultVariant(c));
    return r ? `<small>RAW</small>${money(r.price)}` : '<span class="skeleton-line"></span>';
  }

  // Render a result grid. `scores` (Map id -> 0…1) adds visual-match badges.
  function renderResults(cards, headText, { scores = null, best = null } = {}) {
    lastResults = cards;
    const head = $('#resultsHead'), grid = $('#results');
    head.hidden = false;
    head.textContent = headText;
    grid.innerHTML = cards.map((c, i) => {
      const sc = scores?.get(c.id);
      const badge = sc != null
        ? `<span class="match ${c.id === best ? 'best' : ''}">${c.id === best ? 'Best match · ' : ''}${Math.round(sc * 100)}%</span>`
        : (scores ? '<span class="match pending">matching…</span>' : '');
      return `<button class="result ${c.id === best ? 'is-best' : ''}" data-i="${i}">
          ${badge}
          <img src="${esc(proxied(c.images?.small))}" alt="" loading="lazy">
          <div class="name">${esc(c.name)}</div>
          <div class="sub">${esc(c.set?.name)} · #${esc(c.number)}</div>
          <div class="p num" data-price="${i}">${resultPriceHtml(c)}</div>
        </button>`;
    }).join('');
    fillMissingPrices(cards);
  }

  function fillMissingPrices(cards) {
    const missing = cards.map((c, i) => ({ c, i })).filter(({ c }) => !knownRaw(c, defaultVariant(c)));
    if (!missing.length) return;
    fetchRaw(missing.map(({ c }) => ({ id: c.id, variant: defaultVariant(c) })))
      .catch(() => {})
      .finally(() => {
        if (lastResults !== cards) return;
        for (const { c, i } of missing) {
          const el = $(`[data-price="${i}"]`);
          if (el) el.innerHTML = knownRaw(c, defaultVariant(c)) ? resultPriceHtml(c) : '<span class="muted">No price</span>';
        }
      });
  }

  function showSearching(label) {
    const head = $('#resultsHead');
    head.hidden = false;
    head.textContent = label ? `Searching for ${label}…` : 'Searching…';
    $('#results').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
  }
  function showSearchError(e) {
    $('#resultsHead').textContent = e.status === 429 ? e.message : 'Couldn’t reach the card database. Check your connection and try again.';
    $('#results').innerHTML = '';
  }

  async function runSearch(parsed, label) {
    showSearching(label);
    try {
      const cards = await findCards(parsed);
      if (!cards.length) {
        renderResults([], `No cards found${label ? ` for ${label}` : ''}. Try the name plus number, e.g. “Pikachu 58/102”.`);
        return cards;
      }
      renderResults(cards, `${cards.length}${cards.length >= 36 ? '+' : ''} match${cards.length === 1 ? '' : 'es'}${label ? ` for ${label}` : ''} — tap a card to add it`);
      return cards;
    } catch (e) {
      showSearchError(e);
      return [];
    }
  }
  $('#results').addEventListener('click', (e) => {
    const r = e.target.closest('.result');
    if (r) openCard({ card: lastResults[+r.dataset.i] });
  });
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#searchInput').value.trim();
    if (!text) return;
    $('#searchInput').blur();
    runSearch(parseSearchText(text), `“${text}”`);
  });

  /* ================= Camera + OCR ================= */
  let stream = null;
  const video = $('#video');
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#scannerMsg').textContent = 'Live camera isn’t available here. Use “Photo” to snap or upload a picture of your card.';
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
      getOcrWorker().catch(() => {});
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

  function captureFrame() {
    const scanner = $('.scanner').getBoundingClientRect();
    const frame = $('.scan-frame').getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(scanner.width / vw, scanner.height / vh);
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
    if (sum / (d.length / 4) < 110) for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 255 - d[i];
    ctx.putImageData(img, 0, 0);
    return c;
  }

  const NAME_NOISE = new Set(['basic', 'stage', 'evolves', 'from', 'hp', 'pokemon', 'trainer', 'energy', 'item', 'supporter', 'stadium', 'tool', 'put', 'this', 'card', 'on', 'the', 'and', 'of', 'tera', 'restored', 'baby', 'level', 'lv', 'ability']);
  function parseName(text) {
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
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
    if (promo) return { number: promoNumber(promo[1], promo[2]), total: null };
    return { number: null, total: null };
  }

  // Cards that might be the scanned one: exact text match plus same-name cards (in case the
  // number was misread) and same-number cards (in case the name was).
  async function gatherCandidates({ name, number, total }) {
    const tries = [];
    if (name) tries.push({ name, number, total });
    if (name && number) tries.push({ name });
    if (number && total) tries.push({ number, total });
    if (!name && number) tries.push({ number });
    const results = await Promise.allSettled(tries.map((t) => findCards(t)));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    const seen = new Map();
    for (const r of results) if (r.status === 'fulfilled') for (const c of r.value) if (!seen.has(c.id)) seen.set(c.id, c);
    return [...seen.values()].slice(0, 60);
  }

  // Visual similarity blended with what the text said.
  function blendedScore(card, visual, { name, number, total }) {
    let s = visual;
    const norm = (x) => String(x || '').toLowerCase().replace(/^0+(?=\d)/, '');
    // Text is only a tie-breaker: OCR misreads numbers often, artwork doesn't lie.
    if (number && norm(card.number) === norm(number)) s += 0.025;
    if (total && +card.set?.printedTotal === +total) s += 0.01;
    if (name && card.name.toLowerCase().startsWith(name.toLowerCase())) s += 0.01;
    return s;
  }

  async function scanCanvas(card, { wholeImage = false } = {}) {
    const status = $('#scanStatus');
    const scanner = $('.scanner');
    status.hidden = false;
    status.textContent = '› reading card…';
    scanner.classList.add('busy');
    $('#shutterBtn').disabled = true;
    // Keep a private copy: the capture canvas is reused by the next scan.
    const photo = document.createElement('canvas');
    photo.width = card.width; photo.height = card.height;
    photo.getContext('2d').drawImage(card, 0, 0);
    try {
      let name = '', number = null, total = null;
      try {
        const worker = await getOcrWorker();
        const read = async (canvas, psm) => {
          await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
          return (await worker.recognize(canvas)).data.text || '';
        };
        if (!wholeImage) {
          name = parseName(await read(band(photo, 0.04, 0.025, 0.74, 0.12), 7));
          ({ number, total } = parseNumber(await read(band(photo, 0.02, 0.86, 0.98, 0.985, 2.6), 11)));
        }
        if (!name || !number) {
          const full = await read(band(photo, 0, 0, 1, 1, 1.4), 3);
          if (!name) name = parseName(full);
          if (!number) ({ number, total } = parseNumber(full));
        }
      } catch (e) {
        status.textContent = 'Text reader failed to load — search by name below.';
        return;
      }
      if (!name && !number) {
        status.textContent = 'Couldn’t read that card. Fill the frame, avoid glare, hold steady — or search below.';
        return;
      }
      const parsed = { name, number, total };
      const label = [name, number && (total ? `${number}/${total}` : `#${number}`)].filter(Boolean).join(' ');
      status.textContent = `› read “${label}” · finding candidates…`;
      showSearching(label);
      let cards;
      try { cards = await gatherCandidates(parsed); } catch (e) { showSearchError(e); status.textContent = ''; return; }
      if (!cards.length) {
        renderResults([], `No cards found for ${label}. Try again, or search by name below.`);
        status.textContent = `› read “${label}”`;
        return;
      }

      // Image recognition: compare the photo with every candidate's artwork.
      const scores = new Map();
      renderResults(cards, `Comparing your photo with ${cards.length} card${cards.length === 1 ? '' : 's'}…`, { scores });
      status.textContent = '› matching artwork…';
      let visual = new Map();
      if (window.CardVision) {
        visual = await window.CardVision.rank(photo, cards.map((c) => ({ key: c.id, url: proxied(c.images?.small) })), {
          isCard: !wholeImage,
          onProgress: (d, n) => { status.textContent = `› matching artwork ${d}/${n}`; },
        }).catch(() => new Map());
      }
      const ranked = cards
        .map((c) => ({ c, v: visual.get(c.id), s: blendedScore(c, visual.get(c.id) ?? 0, parsed) }))
        .sort((a, b) => b.s - a.s);
      for (const r of ranked) if (r.v != null) scores.set(r.c.id, r.v);
      const top = ranked[0], second = ranked[1];
      const best = visual.size ? top.c.id : null;
      renderResults(ranked.map((r) => r.c),
        visual.size
          ? `${cards.length} candidate${cards.length === 1 ? '' : 's'} for “${label}”, ranked by how closely the artwork matches your photo`
          : `${cards.length} match${cards.length === 1 ? '' : 'es'} for “${label}” — tap a card to add it`,
        { scores: visual.size ? scores : null, best });
      status.textContent = visual.size ? `› best match: ${top.c.name} · ${top.c.set?.name} #${top.c.number}` : `› read “${label}”`;

      // Confident? Jump straight to the card.
      const confident = cards.length === 1 || (top.v != null && top.v >= 0.62 && (!second || top.s - second.s >= 0.06));
      if (confident) openCard({ card: top.c });
      else $('#resultsHead').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const s = Math.min(1, 1600 / Math.max(img.width, img.height));
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    scanCanvas(c, { wholeImage: Math.abs(c.width / c.height - 63 / 88) > 0.06 });
  });

  /* ================= Card detail sheet ================= */
  let sheetCtx = null;
  let priceReq = 0;

  function gradeLabel(k) {
    const m = k.match(/^Grade (\d+(?:\.5)?)$/);
    if (!m) return k;
    return m[1] === '9.5' ? 'Grade 9.5' : `PSA ${m[1]}`;
  }

  function renderPriceHero() {
    const { card, variant, raw, graded, loading } = sheetCtx;
    const qty = Math.max(1, parseInt($('#qtyInput')?.value, 10) || 1);
    const r = raw || knownRaw(card, variant);
    const psa10 = graded?.prices?.['PSA 10'];
    $('#rawValue').innerHTML = r?.price != null ? money(r.price) : (loading ? '<span class="skeleton-line"></span>' : '—');
    $('#rawFoot').textContent = r?.price != null
      ? `${variant ? (VARIANT_LABELS[variant] || variant) + ' · ' : ''}${qty > 1 ? `${qty}× = ${money(r.price * qty)}` : 'market price'}`
      : (loading ? 'Fetching market price…' : 'No sales data yet');
    $('#rawSrc').textContent = r?.source || '';
    $('#psaValue').innerHTML = psa10 != null ? money(psa10) : (loading ? '<span class="skeleton-line"></span>' : '—');
    const base = graded?.prices?.Ungraded ?? r?.price;
    $('#psaFoot').textContent = psa10 != null && base ? `${(psa10 / base).toFixed(1)}× ungraded` : (loading ? 'Fetching graded sales…' : 'No graded sales found');
    $$('#variantSeg button').forEach((b) => b.classList.toggle('active', b.dataset.v === variant));
    $$('#priceTable tbody tr').forEach((row) => row.classList.toggle('sel', row.dataset.v === variant));
  }

  function renderGraded() {
    const box = $('#gradedBox');
    if (!box) return;
    const { graded, gradedError, loading, raw } = sheetCtx;
    if (loading && !graded) {
      box.innerHTML = '<div class="ladder">' + Array.from({ length: 5 }, () => '<div class="rung"><span class="skeleton-line"></span><div class="bar"></div><span class="skeleton-line"></span></div>').join('') + '</div>';
      return;
    }
    const p = graded?.prices || {};
    const ladderKeys = ['PSA 10', 'Grade 9.5', 'Grade 9', 'Grade 8', 'Grade 7', 'Grade 6', 'Grade 5', 'Grade 4', 'Grade 3', 'Grade 2', 'Grade 1'].filter((k) => p[k] != null);
    // Compare grades against PriceCharting's own ungraded price so the ladder is one consistent source.
    const rawPrice = p.Ungraded ?? raw?.price ?? null;
    if (!ladderKeys.length) {
      box.innerHTML = `<p class="note">${gradedError ? 'Graded prices are temporarily unavailable.' : 'No graded sales found for this card yet.'}${graded?.url ? ` <a href="${esc(graded.url)}" target="_blank" rel="noopener">Check PriceCharting ↗</a>` : ''}</p>`;
      return;
    }
    const max = Math.max(...ladderKeys.map((k) => p[k]), rawPrice || 0);
    const rung = (label, val, cls = '') => `<div class="rung ${cls}">
        <span class="lbl">${esc(label)}</span>
        <div class="bar"><i style="width:${Math.max(2, (val / max) * 100).toFixed(1)}%"></i></div>
        <span class="val"><b>${money(val)}</b>${rawPrice && cls !== 'raw' ? `<small>${(val / rawPrice).toFixed(1)}× ungraded</small>` : ''}</span>
      </div>`;
    const others = Object.keys(p).filter((k) => k !== 'Ungraded' && !ladderKeys.includes(k));
    box.innerHTML = `
      <div class="ladder">
        ${ladderKeys.map((k) => rung(gradeLabel(k), p[k])).join('')}
        ${rawPrice != null ? rung('Ungraded', rawPrice, 'raw') : ''}
      </div>
      ${others.length ? `<div class="ladder-other">${others.map((k) => `<div class="mini glass"><div class="k">${esc(k)}</div><div class="v">${money(p[k])}</div></div>`).join('')}</div>` : ''}
      ${(graded.warnings || []).map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
      <p class="note">Matched to <a href="${esc(graded.url)}" target="_blank" rel="noopener">${esc(graded.title || 'PriceCharting product')} ↗</a> — tap to check it's your card.
      Values are recent sold listings. Low grades (PSA 1–6) usually sell for less than a near-mint raw copy; that's normal.
      Grades 9 and below are PriceCharting's “Grade N” averages, made up mostly of PSA sales; 9.5 is mostly BGS/CGC.</p>`;
  }

  async function loadCardPrices() {
    const ctx = sheetCtx;
    const req = ++priceReq;
    ctx.loading = true;
    renderPriceHero();
    renderGraded();
    try {
      const res = await api(`/api/prices/${encodeURIComponent(ctx.card.id)}?variant=${encodeURIComponent(ctx.variant || '')}`);
      if (req !== priceReq || sheetCtx !== ctx) return;
      ctx.raw = res.raw?.price != null ? res.raw : null;
      ctx.graded = res.graded;
      ctx.gradedError = res.gradedError;
      if (ctx.raw) rawCache.set(`${ctx.card.id}|${ctx.variant || ''}`, ctx.raw);
      // Keep the owned item's raw price fresh too.
      if (ctx.item && ctx.raw && ctx.item.variant === ctx.variant && ctx.item.rawPrice !== ctx.raw.price) {
        ctx.item.rawPrice = ctx.raw.price;
        ctx.item.priceSource = ctx.raw.source;
        save();
        renderPortfolio();
      }
    } catch (e) {
      if (req !== priceReq || sheetCtx !== ctx) return;
      ctx.gradedError = e.message;
    }
    ctx.loading = false;
    renderPriceHero();
    renderGraded();
  }

  function openCard({ card, item }) {
    const isOwned = !!item;
    const c = isOwned ? item.card : card;
    const variants = variantsOf(c);
    sheetCtx = {
      card: c, item,
      variant: isOwned ? item.variant : defaultVariant(c),
      raw: null, graded: null, gradedError: null, loading: true,
    };
    const startPaid = isOwned ? (item.purchasePrice || 0) : 0;
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
    const cmRows = [['Trend', cm.prices?.trendPrice], ['Avg sell', cm.prices?.averageSellPrice], ['30-day avg', cm.prices?.avg30], ['Low', cm.prices?.lowPrice]].filter(([, v]) => v != null);

    $('#sheetBody').innerHTML = `
      <div class="detail-top">
        <div class="holo" id="holo"><div class="holo-inner"><img src="${esc(c.images?.large || c.images?.small)}" alt="${esc(c.name)} card"><div class="holo-shine"></div></div></div>
        <h2 class="detail-name" id="sheetTitle">${esc(c.name)}</h2>
        <div class="detail-set">
          ${set.images?.symbol ? `<img src="${esc(set.images.symbol)}" alt="">` : ''}
          <span>${esc(set.name)} · #${esc(c.number)}${set.printedTotal ? '/' + esc(set.printedTotal) : ''}</span>
        </div>
        ${owned && !isOwned ? `<div class="chip qty" style="margin-top:8px">In your vault ×${owned}</div>` : ''}
        <div class="price-hero">
          <div class="ph raw glass"><div class="ph-label">Raw · ungraded</div><div class="ph-value num" id="rawValue"></div><div class="ph-foot" id="rawFoot"></div><span class="src" id="rawSrc"></span></div>
          <div class="ph psa glass"><div class="ph-label">PSA 10</div><div class="ph-value num" id="psaValue"></div><div class="ph-foot" id="psaFoot"></div><span class="src">PriceCharting</span></div>
        </div>
      </div>

      ${variants.length > 1 ? `<div class="section"><h4>Printing</h4><div class="seg" id="variantSeg">
        ${variants.map((v) => `<button type="button" data-v="${esc(v)}">${esc(VARIANT_LABELS[v] || v)}</button>`).join('')}
      </div></div>` : ''}

      <div class="section">
        <h4>${isOwned ? 'In your portfolio' : 'Add to portfolio'}</h4>
        <div class="form-row">
          <div class="field"><label for="qtyInput">Quantity</label>
            <div class="stepper"><button type="button" data-step="-1" aria-label="Decrease">−</button><input id="qtyInput" type="number" min="1" inputmode="numeric" value="${isOwned ? item.qty : 1}"><button type="button" data-step="1" aria-label="Increase">+</button></div>
          </div>
          <div class="field"><label for="condSelect">Condition</label>
            <select id="condSelect">${CONDITIONS.map((x) => `<option ${x === (isOwned ? item.condition : CONDITIONS[0]) ? 'selected' : ''}>${x}</option>`).join('')}</select>
          </div>
        </div>
        <div class="field" style="margin-top:10px"><label for="paidInput">Price paid (each, USD)</label>
          <input id="paidInput" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${startPaid.toFixed(2)}">
        </div>
        <div class="actions">
          ${isOwned
            ? '<button class="btn primary glow block" id="saveBtn">Save changes</button><button class="btn danger block" id="removeBtn">Remove from portfolio</button>'
            : '<button class="btn primary glow block" id="addBtn">Add to portfolio</button>'}
        </div>
      </div>

      <div class="section"><h4>Graded values</h4><div id="gradedBox"></div></div>

      ${variants.length ? `<div class="section"><h4>TCGplayer · raw by printing</h4>
        <table class="price-table" id="priceTable">
          <thead><tr><th>Printing</th><th>Market</th><th>Low</th><th>Mid</th><th>High</th></tr></thead>
          <tbody>${variants.map((v) => { const p = tcg.prices[v]; return `<tr data-v="${esc(v)}"><td>${esc(VARIANT_LABELS[v] || v)}</td><td class="mk">${money(p.market)}</td><td>${money(p.low)}</td><td>${money(p.mid)}</td><td>${money(p.high)}</td></tr>`; }).join('')}</tbody>
        </table>
        <p class="note">Updated ${esc(tcg.updatedAt || '—')}</p></div>` : ''}

      ${cmRows.length ? `<div class="section"><h4>Cardmarket · EUR</h4>
        <table class="price-table"><tbody>${cmRows.map(([k, v]) => `<tr><td>${k}</td><td class="mk">${eur.format(v)}</td></tr>`).join('')}</tbody></table>
        <p class="note">Updated ${esc(cm.updatedAt || '—')}</p></div>` : ''}

      <div class="section"><h4>Card details</h4>
        <div class="info-grid">${info.map(([k, v]) => `<div class="info"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
      </div>

      ${(c.abilities?.length || c.attacks?.length) ? `<div class="section"><h4>Abilities & attacks</h4>
        ${(c.abilities || []).map((a) => `<div class="attack"><div class="attack-head"><span><span class="ability-tag">${esc(a.type || 'Ability')}</span>${esc(a.name)}</span></div><p>${esc(a.text)}</p></div>`).join('')}
        ${(c.attacks || []).map((a) => `<div class="attack"><div class="attack-head"><span>${esc(a.name)}</span><span class="dmg">${esc(a.damage || '')}</span></div>${a.cost?.length ? `<p class="muted" style="margin-top:2px">Cost: ${esc(a.cost.join(', '))}</p>` : ''}${a.text ? `<p>${esc(a.text)}</p>` : ''}</div>`).join('')}
      </div>` : ''}

      ${c.rules?.length ? `<div class="section"><h4>Rules</h4>${c.rules.map((r) => `<p class="flavor" style="font-style:normal">${esc(r)}</p>`).join('')}</div>` : ''}
      ${c.flavorText ? `<div class="section"><h4>Flavor text</h4><p class="flavor">${esc(c.flavorText)}</p></div>` : ''}

      <div class="section links">
        ${tcg.url ? `<a href="${esc(tcg.url)}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ''}
        ${cm.url ? `<a href="${esc(cm.url)}" target="_blank" rel="noopener">Cardmarket ↗</a>` : ''}
        <a href="https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(`${c.name} ${set.name || ''} ${c.number}`)}" target="_blank" rel="noopener">PriceCharting ↗</a>
      </div>
    `;
    openSheetShell();
    bindHolo($('#holo'));
    loadCardPrices();

    const body = $('#sheetBody');
    $$('#variantSeg button', body).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.v === sheetCtx.variant) return;
      sheetCtx.variant = b.dataset.v;
      sheetCtx.raw = null;
      sheetCtx.graded = null;
      loadCardPrices();
    }));
    $$('[data-step]', body).forEach((b) => b.addEventListener('click', () => {
      const q = $('#qtyInput');
      q.value = Math.max(1, (parseInt(q.value, 10) || 1) + +b.dataset.step);
      renderPriceHero();
    }));
    $('#qtyInput').addEventListener('input', renderPriceHero);

    const readForm = () => ({
      qty: Math.max(1, parseInt($('#qtyInput').value, 10) || 1),
      condition: $('#condSelect').value,
      purchasePrice: Math.max(0, +$('#paidInput').value || 0),
      variant: sheetCtx.variant,
    });
    const currentRaw = () => sheetCtx.raw || knownRaw(c, sheetCtx.variant);
    $('#addBtn')?.addEventListener('click', () => {
      const f = readForm();
      const r = currentRaw();
      state.items.push({ uid: uid(), cardId: c.id, card: c, addedAt: Date.now(), rawPrice: r?.price ?? null, priceSource: r?.source || null, ...f });
      if (!state.pricesUpdatedAt) state.pricesUpdatedAt = Date.now();
      recordSnapshot();
      closeSheet();
      toast(`Added ${c.name}${r?.price != null ? ` · ${money(r.price * f.qty)}` : ''}`);
    });
    $('#saveBtn')?.addEventListener('click', () => {
      const f = readForm();
      if (f.variant !== item.variant) { const r = currentRaw(); item.rawPrice = r?.price ?? null; item.priceSource = r?.source || null; }
      Object.assign(item, f);
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
  }

  // Holographic tilt + shine that follows the pointer.
  function bindHolo(el) {
    const inner = $('.holo-inner', el), shine = $('.holo-shine', el);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      if (!reduce) inner.style.transform = `rotateY(${(px - 0.5) * 18}deg) rotateX(${(0.5 - py) * 18}deg)`;
      shine.style.setProperty('--mx', `${px * 100}%`);
      shine.style.setProperty('--my', `${py * 100}%`);
      shine.style.setProperty('--bx', `${px * 100}%`);
      shine.style.setProperty('--by', `${py * 100}%`);
      el.classList.add('active');
    });
    el.addEventListener('pointerleave', () => { inner.style.transform = ''; el.classList.remove('active'); });
    el.addEventListener('click', () => el.classList.toggle('zoom'));
  }

  function openSheetShell() {
    $('#sheetBackdrop').hidden = false;
    $('#sheet').hidden = false;
    $('#sheet').scrollTop = 0;
    document.body.style.overflow = 'hidden';
    $('#sheetClose').focus({ preventScroll: true });
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

  /* ================= Misc ================= */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  function timeAgo(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  /* ================= Boot ================= */
  (async () => {
    try {
      user = (await api('/api/auth/me')).user;
    } catch {
      user = null;
    }
    if (user || lsGet(GUEST_FLAG) === '1') enterApp();
    else showAuth();
  })();
})();
