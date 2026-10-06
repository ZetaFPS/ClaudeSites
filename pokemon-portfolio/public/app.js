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
  const PRICE_VERSION = 3; // bump when price matching changes so saved prices get recomputed

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

  // Fade out the loading screen once the first real screen (sign-in or the app) is ready.
  function hideSplash() {
    const sp = $('#splash');
    if (!sp || sp.classList.contains('done')) return;
    requestAnimationFrame(() => sp.classList.add('done'));
    setTimeout(() => sp.remove(), 600);
  }
  function showAuth(message) {
    hideSplash();
    stopCamera();
    closeSheet();
    $('#app').hidden = true;
    $('#auth').hidden = false;
    setAuthMode('login');
    if (message) { $('#authError').textContent = message; $('#authError').hidden = false; }
  }
  function signedOut(message) {
    clearInterval(listTimer);
    stopChatPolling();
    groups = [];
    openGroup = null;
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
    hideSplash();
    startListPolling();
    handleInviteLink();
    if (state.items.length && (Date.now() - state.pricesUpdatedAt > STALE_MS || state.priceVersion !== PRICE_VERSION)) refreshPrices({ silent: true });
    else if (state.items.length) recordSnapshot();
  }

  function initials() {
    return user ? (user.name || user.email).trim().charAt(0).toUpperCase() : '';
  }
  // A profile picture, or the name's initial when there isn't one.
  const faceHtml = (name, url) => (url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async">` : esc(String(name || '?').trim().charAt(0).toUpperCase() || '?'));
  function renderAvatar() {
    const a = $('#accountBtn');
    a.classList.toggle('guest', !user);
    a.innerHTML = user ? faceHtml(user.name || user.email, user.avatar) : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>';
  }
  $('#accountBtn').addEventListener('click', openAccount);

  function openAccount() {
    const t = totals();
    $('#sheetBody').innerHTML = user ? `
      <div class="acct">
        <label class="avatar acct-face" for="avatarInput" title="Change profile picture">${faceHtml(user.name || user.email, user.avatar)}<span class="cam" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span></label>
        <input type="file" id="avatarInput" accept="image/*" hidden>
        <div class="acct-photo-actions">
          <label class="link-btn" for="avatarInput">${user.avatar ? 'Change photo' : 'Add a profile picture'}</label>
          ${user.avatar ? '<button type="button" class="link-btn muted" id="avatarRemove">Remove</button>' : ''}
        </div>
        <h3 id="sheetTitle">${esc(user.name)}</h3>
        <p>${esc(user.email)}</p>
        <div class="acct-grid">
          <div class="info"><div class="k">Cards</div><div class="v num">${t.count}</div></div>
          <div class="info"><div class="k">Raw value</div><div class="v num">${money(t.value)}</div></div>
          <div class="info"><div class="k">Member since</div><div class="v">${new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div></div>
          <div class="info"><div class="k">Sync</div><div class="v">${esc($('#syncState').textContent || '—')}</div></div>
          <div class="info" style="grid-column:1/-1"><div class="k">Account storage</div><div class="v">${storageInfo?.persistent === false ? '<span class="down">⚠ Temporary — erased when the site updates</span>' : storageInfo?.storage === 'postgres' ? '<span class="up">✓ Database — kept across updates</span>' : 'Saved on this server'}</div></div>
        </div>
        <label class="switch-row glass">
          <span><b>Show me on the leaderboard</b><small>Shows your display name, total value and top 5 cards. Never your email.</small></span>
          <input type="checkbox" id="lbToggle" ${user.showOnLeaderboard !== false ? 'checked' : ''}><i aria-hidden="true"></i>
        </label>
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
    $('#lbToggle')?.addEventListener('change', async (e) => {
      const on = e.currentTarget.checked;
      try {
        user = (await api('/api/account', { method: 'PUT', body: { showOnLeaderboard: on } })).user;
        toast(on ? 'You’re on the leaderboard' : 'Hidden from the leaderboard');
        lbData = null;
      } catch {
        e.currentTarget.checked = !on;
        toast('Couldn’t save — try again');
      }
    });
    $('#avatarInput')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const image = await squarePhoto(file, 256);
        toast('Uploading…');
        user = (await api('/api/account/avatar', { method: 'PUT', body: { image } })).user;
        afterAvatarChange('Profile picture updated');
      } catch (err) {
        toast(err?.status ? err.message : 'Couldn’t use that picture — try a JPEG or PNG');
      }
    });
    $('#avatarRemove')?.addEventListener('click', async () => {
      try {
        user = (await api('/api/account/avatar', { method: 'PUT', body: { image: null } })).user;
        afterAvatarChange('Profile picture removed');
      } catch {
        toast('Couldn’t remove it — try again');
      }
    });
    $('#toSignup')?.addEventListener('click', () => { showAuth(); setAuthMode('signup'); });
    $('#toLogin')?.addEventListener('click', () => { showAuth(); setAuthMode('login'); });
  }

  function afterAvatarChange(msg) {
    renderAvatar();
    lbData = null; // leaderboard shows the new picture next time
    openAccount();
    toast(msg);
  }
  // Centre-crop a photo to a square and shrink it (JPEG data URL) — keeps uploads small.
  async function squarePhoto(file, size) {
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
    bmp.close?.();
    return c.toDataURL('image/jpeg', 0.86);
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
  const APPROX_SOURCES = new Set(['Cardmarket', 'TCGplayer listing']);
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

  /* ================= Card images (with fallback sources) ================= */
  // Every card <img> carries data-cid. If its picture fails to load, it's re-requested from
  // /api/card-image, which tries every other source for that card (other size, the Pokémon TCG
  // API, TCGdex in webp/png/jpg); if that fails too, a neat placeholder is shown.
  const cardImgUrl = (id, size = 'small') => `/api/card-image/${encodeURIComponent(id)}?size=${size}`;
  const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 63 88"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b2033"/><stop offset="1" stop-color="#10131f"/></linearGradient></defs><rect x=".5" y=".5" width="62" height="87" rx="3.5" fill="url(#g)" stroke="#2c3550"/><circle cx="31.5" cy="40" r="11" fill="none" stroke="#3b4668" stroke-width="2"/><path d="M20.5 40h22" stroke="#3b4668" stroke-width="2"/><circle cx="31.5" cy="40" r="3.2" fill="#10131f" stroke="#3b4668" stroke-width="2"/><text x="31.5" y="66" font-family="sans-serif" font-size="5" fill="#5d6a90" text-anchor="middle">No image</text></svg>');
  function imgAttrs(c, size = 'small', { proxy = false } = {}) {
    const u = size === 'large' ? (c.images?.large || c.images?.small) : c.images?.small;
    const src = u ? (proxy ? proxied(u) : u) : (c.id ? cardImgUrl(c.id, size) : PLACEHOLDER);
    return `src="${esc(src)}" data-cid="${esc(c.id || '')}" data-size="${size}"${u ? '' : ' data-fb="1"'}`;
  }
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !('cid' in img.dataset)) return;
    if (!img.dataset.fb && img.dataset.cid) {
      img.dataset.fb = '1';
      img.src = cardImgUrl(img.dataset.cid, img.dataset.size || 'small');
    } else if (img.dataset.fb !== '2') {
      img.dataset.fb = '2';
      img.classList.add('img-missing');
      img.src = PLACEHOLDER;
    }
  }, true);

  /* ================= Card search ================= */
  async function findCards({ name, number, total, setCode, lang }) {
    const params = new URLSearchParams();
    if (name) params.set('name', name);
    if (number) params.set('number', number);
    if (total) params.set('total', total);
    if (setCode) params.set('setCode', setCode);
    if (lang === 'ja') params.set('lang', 'ja');
    return (await api(`/api/search?${params}`)).data || [];
  }
  const hasJapanese = (t) => /[\u3040-\u30ff\u3400-\u9fff]/.test(t);
  // Japanese set codes printed bottom-left: "SV2a", "S12a", "SM11b", "SV4K", "SVHK"…
  const JP_SET = /\b((?:SV|SM|S)\d{1,2}[a-zA-Z+]?|SV-P|S-P|SM-P|SVHK|SVHM|SVLN|SVLS|SVOD|SVOM)\b/;
  function normNumber(n) { return /^\d+$/.test(n) ? String(+n) : n.toUpperCase(); }
  function promoNumber(prefix, digits) {
    const p = prefix.toUpperCase();
    return p + digits.padStart(p.startsWith('SW') || p === 'SV' ? 3 : 2, '0');
  }
  function parseSearchText(text) {
    let t = ` ${text.trim()} `;
    let number = null, total = null, lang = null, setCode = null;
    // "jp", "japanese" or Japanese characters → search Japanese cards.
    const jpWord = t.match(/\s(jp|jpn|japanese|日本語)\s/i);
    if (jpWord) { lang = 'ja'; t = t.replace(jpWord[0], ' '); }
    if (hasJapanese(t)) lang = 'ja';
    const jpSet = lang === 'ja' && t.match(new RegExp(`\\s${JP_SET.source}\\s`));
    if (jpSet) { setCode = jpSet[1]; t = t.replace(jpSet[0], ' '); }
    const slash = t.match(/\s#?([a-z]{0,3}\d{1,3}[a-z]?)\s*\/\s*([a-z]{0,3}\d{1,3})\s/i);
    if (slash) { number = normNumber(slash[1]); total = /^\d+$/.test(slash[2]) ? String(+slash[2]) : null; t = t.replace(slash[0], ' '); }
    else {
      const promo = t.match(/\s(swsh|sm|xy|bw|svp?|hgss|dp|tg|gg|rc)\s?(\d{1,3})\s/i);
      const plain = t.match(/\s#?(\d{1,3})\s/);
      if (promo) { number = promoNumber(promo[1], promo[2]); t = t.replace(promo[0], ' '); }
      else if (plain) { number = normNumber(plain[1]); t = t.replace(plain[0], ' '); }
    }
    return { name: t.trim(), number, total, lang, setCode };
  }

  /* ================= Navigation ================= */
  function go(view, { focusSearch = false } = {}) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.goto === view && ('focusSearch' in t.dataset) === focusSearch));
    $('#view-scan').classList.toggle('search-mode', view === 'scan' && focusSearch);
    if (view !== 'scan' || focusSearch) stopCamera();
    else if (!stream) startCamera();
    if (view === 'scan' && !focusSearch) refreshIndexNote();
    if (view === 'index') openIndex();
    else clearTimeout(idx.retry);
    if (view === 'packs') openPacksView();
    else clearTimeout(packs.retry);
    if (view === 'portfolio') renderPortfolio();
    if (view === 'leaders') loadLeaderboard();
    if (view === 'grade') prepareGrader();
    if (view === 'groups') loadGroups();
    else stopChatPolling();
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

  /* ---------- "Highest PSA potential": what a card could gain if it graded PSA 10 ---------- */
  const PSA_TTL = 12 * 3600e3;
  const PSA_RETRY_TTL = 10 * 60e3; // a stand-in estimate (price source unreachable) is retried soon
  const psaCache = new Map((() => { try { return JSON.parse(lsGet('pokefolio.psa') || '[]'); } catch { return []; } })());
  let psaLoading = false;
  const psaKey = (it) => `${it.cardId}|${it.variant || ''}`;
  const psaOf = (it) => { const v = psaCache.get(psaKey(it)); return v && Date.now() - v.at < (v.retry ? PSA_RETRY_TTL : PSA_TTL) ? v : null; };
  // The card view's full price lookup is the reference: whenever it loads, it updates the sort's
  // cached PSA 10 value too, so the two always agree.
  function rememberPsa(cardId, variant, res) {
    if (res.gradedError) return;
    const psa10 = res.graded?.prices?.['PSA 10'] ?? null;
    psaCache.set(`${cardId}|${variant || ''}`, { psa10, estimated: !!res.graded?.estimated?.includes('PSA 10'), raw: res.raw?.price ?? null, at: Date.now() });
    lsSet('pokefolio.psa', JSON.stringify([...psaCache].slice(-1500)));
  }
  function psaPotential(it) {
    const p = psaOf(it);
    if (!p || p.psa10 == null) return null;
    return p.psa10 - (itemPrice(it) ?? p.raw ?? 0);
  }
  async function loadPsa(items) {
    if (psaLoading) return;
    const missing = [...new Map(items.filter((it) => !psaOf(it)).map((it) => [psaKey(it), it])).values()];
    if (!missing.length) return;
    psaLoading = true;
    const note = $('#psaNote');
    let done = 0;
    try {
      for (let i = 0; i < missing.length; i += 8) {
        note.hidden = false;
        note.textContent = `Looking up PSA 10 prices… ${done}/${missing.length}`;
        const chunk = missing.slice(i, i + 8);
        const r = await api('/api/prices/psa', { method: 'POST', body: { cards: chunk.map((it) => ({ id: it.cardId, variant: it.variant || null })) } }).catch(() => null);
        for (const it of chunk) {
          const v = r?.prices?.[psaKey(it)];
          psaCache.set(psaKey(it), { psa10: v?.psa10 ?? null, estimated: !!v?.estimated, raw: v?.raw ?? null, retry: !v || !!v.retry, at: Date.now() });
        }
        done += chunk.length;
        lsSet('pokefolio.psa', JSON.stringify([...psaCache].slice(-1500)));
        if ($('#sortSelect').value === 'psa') renderList();
      }
    } finally {
      psaLoading = false;
      note.hidden = true;
    }
  }

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
      // Most to gain from grading first (PSA 10 value minus raw value); unknown last.
      psa: (a, b) => {
        const pa = psaPotential(a), pb = psaPotential(b);
        if (pa == null && pb == null) return itemValue(b) - itemValue(a);
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pb - pa;
      },
    }[sort];
    if (sort === 'psa') loadPsa(state.items);
    items.sort(cmp);
    $('#cardList').innerHTML = items.map((it) => {
      const c = it.card, price = itemPrice(it), gain = itemValue(it) - itemCost(it);
      const gainHtml = it.purchasePrice && price != null ? `<div class="g num ${gain > 0 ? 'up' : gain < 0 ? 'down' : 'flat'}">${signed(gain)}</div>` : '';
      return `<button class="card-row" data-uid="${esc(it.uid)}">
        <img ${imgAttrs(c)} alt="" loading="lazy">
        <div class="meta">
          <div class="name">${esc(c.name)}</div>
          <div class="sub">${esc(c.set?.name)} · #${esc(c.number)}${c.set?.printedTotal ? '/' + esc(c.set.printedTotal) : ''}</div>
          <div class="chips">
            ${it.qty > 1 ? `<span class="chip qty">×${it.qty}</span>` : ''}
            ${c.lang === 'ja' ? '<span class="chip jp">Japanese</span>' : ''}
            ${it.variant ? `<span class="chip">${esc(VARIANT_LABELS[it.variant] || it.variant)}</span>` : ''}
            ${c.rarity ? `<span class="chip">${esc(c.rarity)}</span>` : ''}
            ${sort === 'psa' ? psaChip(it) : ''}
          </div>
        </div>
        <div class="price">
          <div class="v num">${price == null ? '<span class="muted">No price</span>' : `${APPROX_SOURCES.has(it.priceSource) ? '<span class="approx" title="Converted EU price or lowest listing">≈</span>' : ''}${money(price * it.qty)}`}</div>
          ${it.qty > 1 && price != null ? `<div class="muted num">${money(price)} ea</div>` : ''}
          ${gainHtml}
        </div>
      </button>`;
    }).join('') || (state.items.length ? '<p class="muted" style="text-align:center;padding:16px">No cards match that filter.</p>' : '');
  }
  function psaChip(it) {
    const p = psaOf(it);
    if (!p) return '<span class="chip psa pending">PSA 10 …</span>';
    if (p.psa10 == null) return '<span class="chip">No PSA 10 data</span>';
    const gain = psaPotential(it);
    const note = p.retry ? 'rough estimate — price source busy, retrying shortly' : p.estimated ? 'estimate — no recent PSA 10 sales' : 'recent PSA 10 sales';
    return `<span class="chip psa${p.retry ? ' pending' : ''}" title="PSA 10 value (${note}) and how much more than raw">PSA 10 ${p.estimated || p.retry ? '≈' : ''}${money(p.psa10)}${p.estimated || p.retry ? ' est.' : ''} · ${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))}</span>`;
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
    return r ? `<small>RAW</small>${r.approx ? '<span class="approx" title="Converted EU price or lowest listing — no recent US sales">≈</span>' : ''}${money(r.price)}` : '<span class="skeleton-line"></span>';
  }

  // Render a result grid. `scores` (Map id -> 0…1) adds visual-match badges.
  function renderResults(cards, headText, { scores = null, best = null, hits = null } = {}) {
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
          <img ${imgAttrs(c, 'small', { proxy: true })} alt="" loading="lazy">
          <div class="name">${esc(c.name)}</div>
          <div class="sub">${c.lang === 'ja' ? '<span class="chip jp" title="Japanese card">JP</span> ' : ''}${esc(c.set?.name)} · #${esc(c.number)}</div>
          ${hits?.get(c.id)?.length ? `<div class="hits">${hits.get(c.id).map((h) => `<span>✓ ${esc(h)}</span>`).join('')}</div>` : ''}
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
    if (r) openResult(+r.dataset.i);
  });
  // Image-recognition results arrive as lightweight cards; load the full details on open.
  async function openResult(i) {
    const c = lastResults[i];
    if (!c) return;
    if (!c.lite) return openCard({ card: c });
    try {
      const { card } = await api(`/api/card/${encodeURIComponent(c.id)}`);
      if (lastResults[i]?.id === c.id) lastResults[i] = card;
      openCard({ card });
    } catch {
      toast('Couldn’t load that card — try again');
    }
  }
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
  }  // HP printed top-right: "HP 60", "60 HP", "HP60".
  function parseHP(text) {
    const m = text.match(/\bHP\s*([1-9]\d{1,2})\b/i) || text.match(/\b([1-9]\d{1,2})\s*HP\b/i);
    return m && +m[1] >= 10 && +m[1] <= 400 ? m[1] : null;
  }
  // Set code printed bottom-left on modern cards: "PAL EN", "SVI EN", "G OBF EN".
  const NOT_SET_CODES = new Set(['HP', 'EN', 'ILLUS', 'THE', 'AND', 'GX', 'EX', 'VMAX', 'VSTAR']);
  function parseSetCode(text) {
    for (const m of text.toUpperCase().matchAll(/\b([A-Z][A-Z0-9]{1,3})\s*[•·.\-]?\s*EN\b/g)) {
      if (!NOT_SET_CODES.has(m[1])) return m[1];
    }
    return null;
  }
  // Illustrator credit: "Illus. Mitsuhiro Arita".
  function parseArtist(text) {
    const m = text.match(/[Il1|]llus(?:trator)?\.?\s*:?\s*([A-Za-z0-9][A-Za-z0-9.'\-]*(?:\s+[A-Za-z][A-Za-z.'\-]*){0,3})/);
    if (!m) return null;
    const words = m[1].split(/\s+/).filter((w) => /[a-z]/i.test(w) && !/^(EN|HP)$/i.test(w));
    return words.length ? words.slice(0, 3).join(' ') : null;
  }

  // Loose text matching that tolerates one wrong letter per word (typical OCR slips).
  const textWords = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  function nearWord(w, set) {
    if (set.has(w)) return true;
    if (w.length < 5) return false;
    for (const o of set) {
      if (Math.abs(o.length - w.length) > 1) continue;
      let i = 0, j = 0, edits = 0;
      while (i < w.length && j < o.length && edits <= 1) {
        if (w[i] === o[j]) { i++; j++; continue; }
        edits++;
        if (w.length > o.length) i++; else if (o.length > w.length) j++; else { i++; j++; }
      }
      if (edits + (w.length - i) + (o.length - j) <= 1) return true;
    }
    return false;
  }
  // Does `phrase` appear in the OCR'd text? Returns the fraction of its words found.
  function phraseFound(phrase, ocrSet) {
    const ws = textWords(phrase).filter((w) => w.length >= 3);
    if (!ws.length) return 0;
    return ws.filter((w) => nearWord(w, ocrSet)).length / ws.length;
  }


  // Cards that might be the scanned one: exact text match plus looser searches, in case the
  // number, name or set code was misread.
  async function gatherCandidates({ name, number, total, setCode }) {
    const tries = [];
    if (setCode && number) tries.push({ name, number, setCode }, { number, setCode });
    if (name) tries.push({ name, number, total });
    if (name && number) tries.push({ name });
    if (number && total) tries.push({ number, total });
    if (!name && number && !setCode) tries.push({ number });
    const results = await Promise.allSettled(tries.map((t) => findCards(t)));
    if (results.every((r) => r.status === 'rejected')) throw results[0].reason;
    const seen = new Map();
    for (const r of results) if (r.status === 'fulfilled') for (const c of r.value) if (!seen.has(c.id)) seen.set(c.id, c);
    return [...seen.values()].slice(0, 60);
  }

  // How well a card's printed details agree with what the scanner read. Returns
  // { score: 0…1 | null, hits: [labels] } — null when nothing comparable was read.
  function traitMatch(card, t) {
    let got = 0, max = 0;
    const hits = [];
    const norm = (x) => String(x || '').toLowerCase().replace(/^0+(?=\d)/, '');
    const add = (weight, fraction, label) => {
      max += weight;
      got += weight * fraction;
      if (fraction >= 0.5 && label) hits.push(label);
    };
    if (t.number) add(0.28, norm(card.number) === norm(t.number) ? 1 : 0, `#${card.number}`);
    if (t.total) add(0.10, +card.set?.printedTotal === +t.total ? 1 : 0, `/${card.set?.printedTotal}`);
    if (t.setCode && card.lang !== 'ja') add(0.20, String(card.set?.ptcgoCode || '').toUpperCase() === t.setCode ? 1 : 0, card.set?.ptcgoCode);
    if (t.jpSetCode && card.lang === 'ja') add(0.20, String(card.set?.id || '').toLowerCase() === t.jpSetCode.toLowerCase() ? 1 : 0, card.set?.id);
    if (t.hp && card.hp) add(0.10, String(card.hp) === t.hp ? 1 : 0, `HP ${card.hp}`);
    if (t.ocrSet && card.artist) {
      const f = Math.max(phraseFound(card.artist, t.ocrSet), t.artist ? phraseFound(t.artist, new Set(textWords(card.artist))) : 0);
      add(0.12, f, card.artist);
    }
    const moves = [...(card.abilities || []), ...(card.attacks || [])].map((a) => a.name).filter(Boolean);
    if (t.ocrSet && moves.length) {
      const found = moves.map((m) => phraseFound(m, t.ocrSet));
      add(0.20, found.reduce((a, b) => a + b, 0) / moves.length, found.some((f) => f >= 0.5) ? moves[found.indexOf(Math.max(...found))] : null);
    }
    return { score: max ? got / max : null, hits };
  }

  // Final ranking score: image recognition leads; printed details refine it (and decide
  // between reprints that share the same artwork).
  function combinedScore(visual, trait) {
    if (visual == null) return trait ?? 0;
    if (trait == null) return visual;
    return 0.85 * visual + 0.15 * trait;
  }

  /* ---------- scan language + visual index status ---------- */
  let scanLang = ['en', 'ja'].includes(lsGet('pokefolio.scanLang')) ? lsGet('pokefolio.scanLang') : 'any';
  function paintLang() {
    $$('#langSeg button').forEach((b) => {
      const on = b.dataset.lang === scanLang;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
  }
  paintLang();
  $('#langSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (!b) return;
    scanLang = b.dataset.lang;
    lsSet('pokefolio.scanLang', scanLang);
    paintLang();
  });
  let indexInfo = null;
  async function refreshIndexNote() {
    const el = $('#indexNote');
    try { indexInfo = await api('/api/visual-index/status'); } catch { return; }
    const fmt = (n) => n.toLocaleString();
    if (!indexInfo.enabled) { el.hidden = true; return; }
    el.hidden = false;
    if (!indexInfo.size) {
      el.textContent = indexInfo.building
        ? 'Image recognition is warming up (indexing card pictures) — the scanner reads the card’s text until it’s ready.'
        : 'Image recognition index isn’t ready yet — the scanner reads the card’s text for now.';
      return;
    }
    const parts = [`${fmt(indexInfo.english)} English`, indexInfo.japanese ? `${fmt(indexInfo.japanese)} Japanese` : null].filter(Boolean).join(' + ');
    el.textContent = `Image recognition across ${parts} cards${indexInfo.building && indexInfo.progress != null && indexInfo.progress < 1 ? ` · adding more (${Math.round(indexInfo.progress * 100)}%)` : ''}`;
  }

  /* ---------- text reading (helper signals) ---------- */
  function parseJpSetCode(text) {
    const m = text.replace(/[|]/g, 'I').match(JP_SET);
    return m ? m[1] : null;
  }
  async function readText(photo, wholeImage, status) {
    const t = { name: '', number: null, total: null, hp: null, setCode: null, jpSetCode: null, artist: null, ocrSet: null };
    const worker = await getOcrWorker();
    const read = async (canvas, psm) => {
      await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
      return (await worker.recognize(canvas)).data.text || '';
    };
    let bottom = '';
    if (!wholeImage) {
      t.name = parseName(await read(band(photo, 0.04, 0.025, 0.74, 0.12), 7));
      status('› reading HP & set details…');
      t.hp = parseHP(await read(band(photo, 0.55, 0.02, 0.98, 0.12), 7));
      bottom = await read(band(photo, 0.02, 0.86, 0.98, 0.985, 2.6), 11);
      ({ number: t.number, total: t.total } = parseNumber(bottom));
    }
    status('› reading attacks & illustrator…');
    const full = await read(band(photo, 0, 0, 1, 1, 1.4), 3);
    const all = `${bottom}\n${full}`;
    if (!t.name) t.name = parseName(full);
    if (!t.number) ({ number: t.number, total: t.total } = parseNumber(full));
    t.hp = t.hp || parseHP(full);
    t.setCode = parseSetCode(all);
    t.jpSetCode = parseJpSetCode(bottom) || parseJpSetCode(full);
    t.artist = parseArtist(all);
    t.ocrSet = new Set(textWords(all));
    return t;
  }

  // Compare the photo with the picture of every card in the server's index.
  async function visualSearch(photo, { isCard, lang }) {
    if (!window.CardVision?.descriptors || indexInfo?.enabled === false) return null;
    const q = window.CardVision.descriptors(photo, { isCard });
    if (!q.length) return null;
    return api('/api/visual-search', { method: 'POST', body: { q, lang, limit: 24 } });
  }

  async function scanCanvas(card, { wholeImage = false } = {}) {
    const statusEl = $('#scanStatus');
    const status = (msg) => { statusEl.textContent = msg; };
    const scanner = $('.scanner');
    statusEl.hidden = false;
    status('› looking at your card…');
    scanner.classList.add('busy');
    $('#shutterBtn').disabled = true;
    // Keep a private copy: the capture canvas is reused by the next scan. For an uncropped
    // photo, crop to the card first so the name/number/HP regions line up.
    let photo = document.createElement('canvas');
    photo.width = card.width; photo.height = card.height;
    photo.getContext('2d').drawImage(card, 0, 0);
    if (wholeImage && window.CardVision?.detectCard) {
      const box = window.CardVision.detectCard(photo);
      if (box) {
        const cropped = document.createElement('canvas');
        cropped.width = Math.round(box.w); cropped.height = Math.round(box.h);
        cropped.getContext('2d').drawImage(photo, box.x, box.y, box.w, box.h, 0, 0, cropped.width, cropped.height);
        photo = cropped;
        wholeImage = false;
      }
    }
    const lang = scanLang;
    try {
      // 1. Image recognition against every card, while 2. the text is read as a helper.
      const visualP = visualSearch(photo, { isCard: !wholeImage, lang }).catch(() => null);
      let t = null;
      try {
        t = await readText(photo, wholeImage, status);
      } catch { /* text reader unavailable: image recognition alone */ }
      status('› matching your photo against the card index…');
      const vis = await visualP;
      if (vis?.index) indexInfo = vis.index;
      const visHits = vis?.results || [];
      const serverScore = new Map(visHits.map((h) => [h.card.id, h.score]));
      const jaLikely = lang === 'ja' || (lang === 'any' && (visHits.slice(0, 3).filter((h) => h.card.lang === 'ja').length >= 2 || (!visHits.length && !!t?.jpSetCode && !t?.setCode)));

      // Candidates from the printed text (name, number, set code).
      const textReq = [];
      if (t && (t.name || t.number)) {
        if (lang !== 'ja' && !jaLikely) textReq.push(gatherCandidates(t));
        if (lang !== 'en' && t.number && (jaLikely || t.jpSetCode)) {
          textReq.push(findCards({ number: t.number, total: t.total, setCode: t.jpSetCode, lang: 'ja' }));
        }
      }
      const textCards = (await Promise.allSettled(textReq)).flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const pool = new Map();
      for (const h of visHits.slice(0, 16)) pool.set(h.card.id, h.card);
      for (const c of textCards) {
        // Prefer the full card from the text search over a lightweight index entry.
        if (!pool.has(c.id) || pool.get(c.id).lite) pool.set(c.id, c);
        if (pool.size >= 56) break;
      }
      const cards = [...pool.values()];
      const label = t ? [t.name && !jaLikely ? t.name : '', t.number && (t.total ? `${t.number}/${t.total}` : `#${t.number}`)].filter(Boolean).join(' ') : '';
      const readout = t ? [label, t.setCode || t.jpSetCode, t.hp && `HP ${t.hp}`, t.artist && `Illus. ${t.artist}`].filter(Boolean).join(' · ') : '';
      if (!cards.length) {
        if (textReq.length && !textCards.length && !vis) {
          showSearchError({});
        } else {
          renderResults([], `No match found${label ? ` for ${label}` : ''}. Fill the frame, avoid glare and hold steady — or search by name below.`);
        }
        status(readout ? `› read: ${readout}` : (vis ? '› no match' : 'Couldn’t read that card — try again or search below.'));
        return;
      }

      // Close-up comparison of the shortlist (full resolution, many alignments).
      const scores = new Map();
      renderResults(cards, `Comparing your photo with ${cards.length} likely card${cards.length === 1 ? '' : 's'}…`, { scores });
      let local = new Map();
      if (window.CardVision) {
        local = await window.CardVision.rank(photo, cards.map((c) => ({ key: c.id, url: proxied(c.images?.small) || cardImgUrl(c.id), fallback: cardImgUrl(c.id) })), {
          isCard: !wholeImage,
          onProgress: (d, n) => status(`› matching artwork ${d}/${n}`),
        }).catch(() => new Map());
      }
      const ranked = cards.map((c) => {
        const a = serverScore.get(c.id), b = local.get(c.id);
        const v = a != null && b != null ? 0.5 * a + 0.5 * b : (a ?? b ?? null);
        const tm = t ? traitMatch(c, t) : { score: null, hits: [] };
        return { c, v, hits: tm.hits, s: combinedScore(v, tm.score) };
      }).sort((x, y) => y.s - x.s);
      for (const r of ranked) scores.set(r.c.id, r.s);
      const top = ranked[0], second = ranked[1];
      const sameArt = second && top.v != null && second.v != null && Math.abs(top.v - second.v) < 0.03 && top.s - second.s < 0.05;
      const how = visHits.length ? 'image recognition' : (local.size ? 'artwork match' : 'printed details');
      renderResults(ranked.map((r) => r.c),
        sameArt
          ? 'Several cards share this artwork (reprints) — check the set number at the bottom of your card and pick the one that matches'
          : `${cards.length} candidate${cards.length === 1 ? '' : 's'}, ranked by ${how}${t ? ' and printed details' : ''}`,
        { scores, best: top.c.id, hits: new Map(ranked.map((r) => [r.c.id, r.hits])) });
      status(`› best match: ${top.c.name} · ${top.c.set?.name} #${top.c.number}${readout ? ` · read: ${readout}` : ''}`);

      // Confident? Jump straight to the card.
      const confident = (cards.length === 1 && (top.v == null || top.v >= 0.6)) || (top.s >= 0.62 && (!second || top.s - second.s >= 0.04));
      if (confident) openResult(0);
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

  /* ================= Card index ================= */
  // Every card, newest set first. Nothing is fetched until the Index is opened; then four rows at
  // a time, and more only when "Load more" is pressed.
  const idx = { items: [], total: 0, offset: 0, req: 0, started: false, retry: null, setsFor: null };
  const idxOpts = () => ({
    sort: $('#idxSort').value, lang: $('#idxLang').value, set: $('#idxSet').value,
    q: $('#idxSearch').value.trim(), ownedOnly: $('#idxOwned').checked,
  });
  function idxPageSize() {
    const cols = getComputedStyle($('#idxGrid')).gridTemplateColumns.split(' ').filter(Boolean).length || 2;
    return Math.min(96, Math.max(2, cols) * 4);
  }
  function ownedCounts() {
    const m = new Map();
    for (const it of state.items) m.set(it.cardId, (m.get(it.cardId) || 0) + it.qty);
    return m;
  }
  function openIndex() {
    if (!idx.started) { idx.started = true; loadIndex(true); }
    else renderIndex(); // refresh "owned" badges
  }
  async function loadIndex(reset = false) {
    clearTimeout(idx.retry);
    const o = idxOpts();
    if (reset) {
      idx.items = []; idx.offset = 0; idx.total = 0;
      $('#idxGrid').innerHTML = Array.from({ length: Math.min(12, idxPageSize()) }, () => '<div class="skeleton"></div>').join('');
      $('#idxCount').textContent = '';
    }
    const req = ++idx.req;
    const more = $('#idxMore');
    more.disabled = true;
    more.textContent = 'Loading…';
    const needOwned = o.sort === 'collection' || o.ownedOnly;
    try {
      const r = await api('/api/card-index', {
        method: 'POST',
        body: { ...o, owned: needOwned ? [...new Set(state.items.map((i) => i.cardId))] : [], offset: idx.offset, limit: idxPageSize() },
      });
      if (req !== idx.req) return;
      if (r.loading) {
        const st = Object.values(r.status || {}).find((x) => x.loading && x.progress);
        const pct = st?.progress?.total ? ` (${Math.round(100 * st.progress.done / st.progress.total)}%)` : '';
        $('#idxGrid').innerHTML = `<div class="idx-empty glass"><div class="reticle small busy" aria-hidden="true"></div><h3>Building the card index${pct}…</h3><p>Fetching every set for the first time — this takes a minute and only happens once.</p></div>`;
        more.hidden = true;
        if ($('#view-index').classList.contains('active')) idx.retry = setTimeout(() => loadIndex(true), 3000);
        return;
      }
      if (r.sets && idx.setsFor !== o.lang) fillIndexSets(r.sets, o.lang);
      idx.items.push(...r.items);
      idx.total = r.total;
      idx.offset += r.items.length;
      renderIndex();
    } catch (e) {
      if (req !== idx.req) return;
      if (reset) $('#idxGrid').innerHTML = `<div class="idx-empty glass"><h3>Couldn’t load the card index</h3><p>${esc(e.status === 429 ? e.message : 'Check your connection and try again.')}</p></div>`;
      else toast('Couldn’t load more cards — try again');
    } finally {
      if (req === idx.req) { more.disabled = false; more.textContent = 'Load more'; }
    }
  }
  function fillIndexSets(sets, lang) {
    idx.setsFor = lang;
    const sel = $('#idxSet');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All sets</option>' + sets.map((st) => `<option value="${esc(st.id)}">${esc(st.name)}${st.lang === 'ja' ? ' (JP)' : ''}${st.released ? ` · ${esc(String(st.released).slice(0, 4))}` : ''}</option>`).join('');
    sel.value = sets.some((st) => st.id === cur) ? cur : '';
  }
  function renderIndex() {
    const grid = $('#idxGrid');
    const o = idxOpts();
    const owned = ownedCounts();
    const grouped = ['newest', 'oldest', 'set'].includes(o.sort) && !o.set;
    let last = null, html = '';
    idx.items.forEach((c, i) => {
      if (grouped && c.set?.id !== last) {
        last = c.set?.id;
        const yr = c.set?.releaseDate ? String(c.set.releaseDate).slice(0, 4) : '';
        html += `<h3 class="idx-set">${esc(c.set?.name || 'Unknown set')}${c.lang === 'ja' ? ' <span class="chip jp">JP</span>' : ''}<small>${esc([c.set?.series, yr].filter(Boolean).join(' · '))}</small></h3>`;
      }
      const n = owned.get(c.id);
      html += `<button class="result idx-card ${n ? 'is-owned' : ''}" data-ii="${i}">
          ${n ? `<span class="owned-tag">✓ ${n > 1 ? `×${n}` : 'Owned'}</span>` : ''}
          <img ${imgAttrs(c, 'small')} alt="" loading="lazy" decoding="async">
          <div class="name">${esc(c.name)}</div>
          <div class="sub">${c.lang === 'ja' ? '<span class="chip jp">JP</span> ' : ''}${esc(c.set?.name)} · #${esc(c.number)}</div>
          ${c.rarity ? `<div class="sub rar">${esc(c.rarity)}</div>` : ''}
        </button>`;
    });
    grid.innerHTML = html || '<div class="idx-empty glass"><h3>No cards match</h3><p>Try a different search or filter.</p></div>';
    $('#idxCount').textContent = idx.total ? `Showing ${idx.items.length.toLocaleString()} of ${idx.total.toLocaleString()} cards` : '';
    $('#idxMore').hidden = idx.items.length >= idx.total;
  }
  $('#idxMore').addEventListener('click', () => loadIndex(false));
  $('#idxGrid').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-ii]');
    if (!t) return;
    const c = idx.items[+t.dataset.ii];
    try {
      const { card } = await api(`/api/card/${encodeURIComponent(c.id)}`);
      openCard({ card });
    } catch {
      toast('Couldn’t load that card — try again');
    }
  });
  let idxTyping = null;
  $('#idxSearch').addEventListener('input', () => { clearTimeout(idxTyping); idxTyping = setTimeout(() => loadIndex(true), 350); });
  $('#idxForm').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(idxTyping); loadIndex(true); });
  for (const id of ['#idxSort', '#idxSet', '#idxLang', '#idxOwned']) $(id).addEventListener('change', () => loadIndex(true));

  /* ================= Pack simulator ================= */
  // Pick any set, rip a booster and flip through it card by card. Just for fun: nothing is added
  // to the collection. Packs are built on the server with each era's real slot structure.
  const packs = { sets: null, set: null, cards: [], i: 0, busy: false, retry: null };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const TIER_NAMES = { H: 'Holo Rare', X: 'Hit!', I: 'Illustration hit!', S: 'Secret rare!' };
  function openPacksView() {
    if (!packs.sets) loadPackSets();
  }
  async function loadPackSets() {
    clearTimeout(packs.retry);
    if (!packs.sets) $('#packSets').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton" style="height:120px"></div>').join('');
    try {
      const r = await api('/api/packs');
      if (r.loading) {
        $('#packSets').innerHTML = '<div class="idx-empty glass"><div class="reticle small busy" aria-hidden="true"></div><h3>Loading every set…</h3><p>Fetching the card list for the first time — this takes a minute and only happens once.</p></div>';
        if ($('#view-packs').classList.contains('active')) packs.retry = setTimeout(loadPackSets, 3000);
        return;
      }
      packs.sets = r.sets;
      renderPackSets();
    } catch (e) {
      $('#packSets').innerHTML = `<div class="idx-empty glass"><h3>Couldn’t load the sets</h3><p>${esc(e.status === 429 ? e.message : 'Check your connection and try again.')}</p></div>`;
    }
  }
  function renderPackSets() {
    const q = $('#packSearch').value.trim().toLowerCase();
    const list = (packs.sets || []).filter((st) => !q || st.name.toLowerCase().includes(q) || String(st.series || '').toLowerCase().includes(q));
    let series = null, html = '';
    for (const st of list) {
      if (st.series !== series) { series = st.series; html += `<h3 class="pack-series">${esc(series || 'Other')}</h3>`; }
      html += `<button class="pack-set" data-set="${esc(st.id)}">
          <span class="logo"><img class="set-logo" src="${esc(st.logo)}" alt="${esc(st.name)}" loading="lazy"></span>
          <b>${esc(st.name)}</b><small>${esc(String(st.released || '').slice(0, 4))} · ${st.size} cards per pack</small>
        </button>`;
    }
    $('#packSets').innerHTML = html || '<div class="idx-empty glass"><h3>No sets match</h3></div>';
  }
  // Set logos that fail to load are replaced by the set's name.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.classList.contains('set-logo')) img.replaceWith(Object.assign(document.createElement('span'), { className: 'fallback', textContent: img.alt }));
  }, true);
  $('#packSearch').addEventListener('input', renderPackSets);
  $('#packSets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-set]');
    if (b) showPack(packs.sets.find((st) => st.id === b.dataset.set));
  });
  $('#packBack').addEventListener('click', () => showPicker());
  function showPicker() {
    $('#packPicker').hidden = false;
    $('#packStage').hidden = true;
    $('#packSummary').hidden = true;
  }

  // Zig-zag crimp edges and a slightly ragged tear line, as clip-path polygons.
  function zig(yA, yB, n) { return Array.from({ length: n + 1 }, (_, i) => `${(i / n * 100).toFixed(2)}% ${i % 2 ? yB : yA}%`); }
  function tearLine() { return Array.from({ length: 19 }, (_, i) => `${(i / 18 * 100).toFixed(2)}% ${(15.5 + (i % 2 ? 0.7 : -0.5) + Math.random() * 0.5).toFixed(2)}%`); }
  function showPack(st) {
    if (!st) return;
    packs.set = st;
    $('#packPicker').hidden = true;
    $('#packSummary').hidden = true;
    $('#packStage').hidden = false;
    let h = 0;
    for (const ch of st.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const tear = tearLine();
    const topClip = [...zig(0, 2.2, 28), ...tear.slice().reverse()].join(',');
    const mainClip = [...tear, ...zig(100, 97.8, 28).reverse()].join(',');
    const skin = `<div class="skin">
        ${st.art ? `<div class="art" style="background-image:url('${esc(st.art)}')"></div>` : ''}
        <div class="crimp top"></div><div class="crimp bottom"></div>
        <div class="logo"><img class="set-logo" src="${esc(st.logo)}" alt="${esc(st.name)}"></div>
        <div class="label">BOOSTER PACK · ${st.size} CARDS</div>
        <div class="sheen"></div>
      </div>`;
    $('#boosterWrap').innerHTML = `<div class="booster" id="booster" role="button" tabindex="0" aria-label="Open the ${esc(st.name)} booster pack"
        style="--pack-a:hsl(${h},70%,28%);--pack-b:hsl(${(h + 60) % 360},65%,40%)">
        <div class="piece main" style="clip-path:polygon(${mainClip})">${skin}</div>
        <div class="piece top" style="clip-path:polygon(${topClip})">${skin}</div>
        <div class="tearline"></div>
      </div>`;
    $('#packNote').textContent = `${st.name} · ${st.note}`;
    $('#packOpen').disabled = false;
    $('#packOpen').textContent = 'Open pack';
    packs.busy = false;
    const booster = $('#booster');
    booster.addEventListener('click', openPack);
    booster.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPack(); } });
    window.scrollTo({ top: 0 });
  }
  // Tilt the pack toward the pointer.
  $('#boosterWrap').addEventListener('pointermove', (e) => {
    const b = $('#booster');
    if (!b || packs.busy) return;
    const r = b.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
    b.style.transform = `rotateY(${dx * 22}deg) rotateX(${-dy * 16}deg)`;
  });
  $('#boosterWrap').addEventListener('pointerleave', () => { const b = $('#booster'); if (b) b.style.transform = ''; });
  $('#packOpen').addEventListener('click', openPack);

  const preload = (url) => new Promise((res) => { if (!url) return res(); const i = new Image(); i.onload = i.onerror = res; i.src = url; });
  async function openPack() {
    const b = $('#booster');
    if (packs.busy || !b) return;
    packs.busy = true;
    $('#packOpen').disabled = true;
    $('#packOpen').textContent = 'Opening…';
    b.style.transform = '';
    const req = api(`/api/packs/${encodeURIComponent(packs.set.id)}/open`, { method: 'POST', body: {} });
    b.classList.add('shake');
    let pack;
    try {
      [pack] = await Promise.all([req, sleep(560)]);
      if (pack.loading || !pack.cards?.length) throw new Error('not ready');
    } catch (e) {
      b.classList.remove('shake');
      toast(e.status === 429 ? e.message : 'Couldn’t open that pack — try again');
      packs.busy = false;
      $('#packOpen').disabled = false;
      $('#packOpen').textContent = 'Open pack';
      return;
    }
    // Load the card pictures while the pack tears open (but don't wait forever).
    const pics = Promise.race([Promise.all(pack.cards.map((c) => preload(c.images?.large || c.images?.small))), sleep(2600)]);
    b.classList.remove('shake');
    b.classList.add('tearing');
    await sleep(330);
    b.classList.add('torn');
    await Promise.all([pics, sleep(900)]);
    startReveal(pack);
  }

  function startReveal(pack) {
    packs.cards = pack.cards;
    packs.i = 0;
    const n = pack.cards.length;
    $('#revealSet').textContent = pack.set.name;
    const stage = $('#revealStage');
    stage.innerHTML = pack.cards.map((c, i) => {
      const t = c.pull || {};
      // Suspense: the rare slot and any big hit start face-down and flip on tap.
      const down = t.rare || ['I', 'S'].includes(t.tier);
      const url = c.images?.large || c.images?.small;
      return `<div class="rcard enter t-${t.tier} ${t.reverse ? 'rev' : ''} ${t.hit ? 'hit' : ''} ${down ? 'down' : ''}" data-ri="${i}" style="z-index:${n - i}">
          <div class="rcard-inner">
            <div class="rface front"><img ${imgAttrs({ id: c.id, images: { small: url, large: url } }, 'large')} alt="${esc(c.name)}"><div class="foil"></div></div>
            <div class="rface back"><span class="ball"></span></div>
          </div>
        </div>`;
    }).join('');
    $('#packStage').hidden = true;
    $('#reveal').hidden = false;
    document.body.style.overflow = 'hidden';
    // The stack slides up out of the pack, one card after another.
    $$('.rcard', stage).forEach((el, i) => setTimeout(() => el.classList.remove('enter'), 60 + (n - 1 - i) * 45));
    setTimeout(updateReveal, 80);
    $('#revealStage').focus?.();
  }
  function currentCardEl() { return $(`.rcard[data-ri="${packs.i}"]`); }
  function updateReveal() {
    const n = packs.cards.length;
    const el = currentCardEl();
    const c = packs.cards[packs.i];
    $('#revealCount').textContent = `${Math.min(packs.i + 1, n)} / ${n}`;
    if (!el || !c) return;
    const down = el.classList.contains('down');
    const t = c.pull || {};
    const cap = $('#revealCap');
    cap.classList.toggle('hidden', down);
    cap.innerHTML = `<b>${esc(c.name)}</b><span>${esc(c.rarity || 'Common')}${t.reverse ? '<i class="tag">Reverse Holo</i>' : ''}${t.hit || t.tier === 'H' ? `<i class="tag ${t.hit ? 'hit' : ''}">${esc(TIER_NAMES[t.tier] || 'Rare')}</i>` : ''}</span>`;
    $('#revealHint').textContent = down ? (t.rare ? 'Your rare card — tap to flip it!' : 'Something special… tap to flip') : packs.i === n - 1 ? 'Tap to see your whole pack' : 'Tap for the next card';
  }
  function advanceReveal() {
    const el = currentCardEl();
    if (!el) return finishReveal();
    if (el.classList.contains('down')) {
      el.classList.remove('down');
      if (el.classList.contains('hit')) {
        const burst = document.createElement('span');
        burst.className = `burst t-${packs.cards[packs.i].pull.tier}`;
        $('#revealStage').append(burst);
        setTimeout(() => burst.remove(), 1100);
      }
      setTimeout(updateReveal, 250);
      return;
    }
    el.classList.add('gone');
    packs.i++;
    if (packs.i >= packs.cards.length) setTimeout(finishReveal, 420);
    else updateReveal();
  }
  $('#revealStage').addEventListener('click', advanceReveal);
  document.addEventListener('keydown', (e) => {
    if ($('#reveal').hidden) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); advanceReveal(); }
    if (e.key === 'Escape') finishReveal();
  });
  $('#revealSkip').addEventListener('click', finishReveal);

  function finishReveal() {
    if ($('#reveal').hidden) return;
    $('#reveal').hidden = true;
    document.body.style.overflow = '';
    $('#packStage').hidden = true;
    const box = $('#packSummary');
    box.hidden = false;
    const cards = packs.cards;
    const variantOf = (c) => (c.pull?.reverse ? 'reverseHolofoil' : null);
    box.innerHTML = `
      <div class="head">
        <div><h3>Your ${esc(packs.set.name)} pack</h3><p class="muted" style="margin:4px 0 0">Just for fun — these cards aren’t added to your collection.</p></div>
        <div class="value" id="packValue">Pack value: <span class="skeleton-line"></span></div>
      </div>
      <div class="pack-grid">${cards.map((c, i) => {
        const t = c.pull || {};
        return `<button class="pc t-${t.tier} ${t.hit ? 'hit' : ''}" data-pc="${i}">
            <img ${imgAttrs(c, 'small')} alt="" loading="lazy">
            <b>${esc(c.name)}</b><small>${esc(c.rarity || 'Common')}${t.reverse ? ' · Reverse' : ''}</small>
            <span class="p num" data-pp="${i}"></span>
          </button>`;
      }).join('')}</div>
      <div class="pack-actions">
        <button class="btn primary glow" id="packAgain">Open another ${esc(packs.set.name)} pack</button>
        <button class="btn" id="packOther">Choose another set</button>
      </div>`;
    $('#packAgain').addEventListener('click', () => showPack(packs.set));
    $('#packOther').addEventListener('click', showPicker);
    window.scrollTo({ top: 0 });
    // What would this pack be worth? (market prices, fetched now)
    const list = cards.map((c) => ({ id: c.id, variant: variantOf(c) }));
    fetchRaw(list).then(() => {
      let total = 0, known = 0;
      cards.forEach((c, i) => {
        const p = rawCache.get(`${c.id}|${variantOf(c) || ''}`)?.price;
        const el = $(`[data-pp="${i}"]`);
        if (p != null) { total += p; known++; if (el) el.textContent = money(p); }
        else if (el) el.textContent = '—';
      });
      const v = $('#packValue');
      if (v) v.innerHTML = known ? `Pack value: <b class="num">${money(total)}</b>` : 'Pack value: —';
    }).catch(() => { const v = $('#packValue'); if (v) v.textContent = ''; });
  }
  $('#packSummary').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-pc]');
    if (!t) return;
    try { const { card } = await api(`/api/card/${encodeURIComponent(packs.cards[+t.dataset.pc].id)}`); openCard({ card }); } catch { toast('Couldn’t load that card'); }
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
    $('#rawValue').innerHTML = r?.price != null ? `${r.approx ? '<span class="approx">≈</span>' : ''}${money(r.price)}` : (loading ? '<span class="skeleton-line"></span>' : '—');
    $('#rawFoot').textContent = r?.price != null
      ? `${variant ? (VARIANT_LABELS[variant] || variant) + ' · ' : ''}${qty > 1 ? `${qty}× = ${money(r.price * qty)}` : r.approx ? (r.source === 'Cardmarket' ? 'EU market price' : 'lowest listing') : 'market price'}`
      : (loading ? 'Fetching market price…' : 'No sales data yet');
    $('#rawSrc').textContent = r?.source || '';
    $('#rawSrc').title = r?.note || '';
    const psaEst = graded?.estimated?.includes('PSA 10');
    $('#psaValue').innerHTML = psa10 != null ? `${psaEst ? '<span class="approx">≈</span>' : ''}${money(psa10)}` : (loading ? '<span class="skeleton-line"></span>' : '—');
    const base = graded?.prices?.Ungraded ?? r?.price;
    $('#psaFoot').textContent = psa10 != null && base
      ? (psaEst ? 'estimate — no recent PSA 10 sales' : `${(psa10 / base).toFixed(1)}× ungraded`)
      : (loading ? 'Fetching graded sales…' : 'No graded sales found');
    const psaSrc = $('#psaValue')?.closest('.ph')?.querySelector('.src');
    if (psaSrc) psaSrc.textContent = psaEst ? 'Estimate' : 'PriceCharting';
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
    const est = new Set(graded.estimated || []);
    const rung = (label, val, cls = '', key = null) => `<div class="rung ${cls} ${key && est.has(key) ? 'est' : ''}">
        <span class="lbl">${esc(label)}${key && est.has(key) ? ' <em class="est-tag">est.</em>' : ''}</span>
        <div class="bar"><i style="width:${Math.max(2, (val / max) * 100).toFixed(1)}%"></i></div>
        <span class="val"><b>${key && est.has(key) ? '≈' : ''}${money(val)}</b>${rawPrice && cls !== 'raw' ? `<small>${(val / rawPrice).toFixed(1)}× ungraded</small>` : ''}</span>
      </div>`;
    const others = Object.keys(p).filter((k) => k !== 'Ungraded' && !ladderKeys.includes(k));
    box.innerHTML = `
      <div class="ladder">
        ${ladderKeys.map((k) => rung(gradeLabel(k), p[k], '', k)).join('')}
        ${rawPrice != null ? rung('Ungraded', rawPrice, 'raw') : ''}
      </div>
      ${others.length ? `<div class="ladder-other">${others.map((k) => `<div class="mini glass"><div class="k">${esc(k)}</div><div class="v">${money(p[k])}</div></div>`).join('')}</div>` : ''}
      ${(graded.warnings || []).map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}
      ${est.size ? `<p class="est-note"><b>≈ Estimated:</b> ${[...est].map(gradeLabel).join(', ')} ${est.size === 1 ? 'has' : 'have'} no recent graded sales, so ${est.size === 1 ? 'it’s' : 'they’re'} estimated ${graded.estimateBasis === 'graded' ? 'from this card’s real graded sales' : 'from its raw price'} using typical PSA premiums. Treat as a rough guide.</p>` : ''}
      <p class="note">${graded.source === 'Estimate'
        ? `No graded sales were found on PriceCharting for this card. <a href="${esc(graded.url)}" target="_blank" rel="noopener">Search PriceCharting ↗</a>`
        : `Matched to <a href="${esc(graded.url)}" target="_blank" rel="noopener">${esc(graded.title || 'PriceCharting product')} ↗</a> — tap to check it's your card.`}
      Real values are recent sold listings. Low grades (PSA 1–6) usually sell for less than a near-mint raw copy; that's normal.
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
      rememberPsa(ctx.card.id, ctx.variant, res);
      if ($('#sortSelect').value === 'psa') renderList();
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
        <div class="holo" id="holo"><div class="holo-inner"><img ${imgAttrs(c, 'large')} alt="${esc(c.name)} card"><div class="holo-shine"></div></div></div>
        <h2 class="detail-name" id="sheetTitle">${esc(c.name)}</h2>
        <div class="detail-set">
          ${set.images?.symbol ? `<img src="${esc(set.images.symbol)}" alt="">` : ''}
          <span>${esc(set.name)} · #${esc(c.number)}${set.printedTotal ? '/' + esc(set.printedTotal) : ''}</span>
          ${c.lang === 'ja' ? '<span class="chip jp">Japanese</span>' : ''}
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

  /* ================= Leaderboard ================= */
  let lbData = null;
  let lbLoading = null;
  const medal = (r) => (r === 1 ? 'gold' : r === 2 ? 'silver' : r === 3 ? 'bronze' : '');
  const nameInitial = (n) => esc(String(n || '?').trim().charAt(0).toUpperCase() || '?');

  async function loadLeaderboard(force = false) {
    if (lbData && !force) return renderLeaderboard();
    if (!lbData) {
      $('#podium').innerHTML = '';
      $('#lbList').innerHTML = Array.from({ length: 5 }, () => '<div class="lb-row skeleton-row"></div>').join('');
    }
    if (!lbLoading) {
      lbLoading = api('/api/leaderboard').finally(() => { lbLoading = null; });
    }
    try {
      lbData = await lbLoading;
      renderLeaderboard();
    } catch (e) {
      $('#lbList').innerHTML = `<p class="note">${e.status === 429 ? esc(e.message) : 'Couldn’t load the leaderboard. Try again shortly.'}</p>`;
    }
  }
  $('#lbRefresh').addEventListener('click', () => loadLeaderboard(true));

  function renderLeaderboard() {
    const d = lbData;
    const entries = d.entries || [];
    $('#lbSub').textContent = `${d.total} collector${d.total === 1 ? '' : 's'} · updated ${timeAgo(d.computedAt)}`;
    const me = $('#lbMe');
    if (user && d.me) {
      me.hidden = false;
      me.innerHTML = d.me.hidden
        ? `<span class="lb-me-rank">—</span><span><b>You’re hidden from the leaderboard</b><small>Your collection: ${money(d.me.value)} · turn visibility on in your account</small></span>`
        : `<span class="lb-me-rank num">#${d.me.rank}</span><span><b>Your rank</b><small>${money(d.me.value)} · ${d.me.cards} card${d.me.cards === 1 ? '' : 's'}</small></span>`;
    } else if (!user) {
      me.hidden = false;
      me.innerHTML = '<span class="lb-me-rank">?</span><span><b>Want a spot on the board?</b><small>Create a free account and your collection is ranked automatically.</small></span>';
    } else {
      me.hidden = false;
      me.innerHTML = '<span class="lb-me-rank">—</span><span><b>Not ranked yet</b><small>Add cards to your collection to join the leaderboard.</small></span>';
    }
    if (!entries.length) {
      $('#podium').innerHTML = '';
      $('#lbList').innerHTML = '<div class="empty-state"><h3>No collectors yet</h3><p>Be the first — add cards to your collection.</p></div>';
      return;
    }
    $('#podium').innerHTML = podiumHtml(entries, 'data-lb');
    $('#lbList').innerHTML = boardListHtml(entries.slice(3), 'data-lb');
  }

  // Shared by the global and group leaderboards. `attr` decides which click handler opens profiles.
  function podiumHtml(entries, attr) {
    const top3 = entries.slice(0, 3);
    const order = [top3[1], top3[0], top3[2]].filter(Boolean); // 2nd, 1st, 3rd
    return order.map((e) => `
      <button class="pod ${medal(e.rank)} ${user && e.id === user.id ? 'is-me' : ''}" ${attr}="${esc(e.id)}">
        <span class="pod-avatar">${faceHtml(e.name, e.avatar)}<i>${e.rank}</i></span>
        <span class="pod-name">${esc(e.name)}</span>
        <span class="pod-value num">${money(e.value)}</span>
        <span class="pod-cards">${e.cards} card${e.cards === 1 ? '' : 's'}</span>
        <span class="pod-step"></span>
      </button>`).join('');
  }
  function boardListHtml(entries, attr) {
    return entries.map((e) => `
      <button class="lb-row glass ${user && e.id === user.id ? 'is-me' : ''}" ${attr}="${esc(e.id)}">
        <span class="lb-rank num">${e.rank}</span>
        <span class="pod-avatar sm">${faceHtml(e.name, e.avatar)}</span>
        <span class="lb-name">${esc(e.name)}${user && e.id === user.id ? ' <em>you</em>' : ''}<small>${e.cards} card${e.cards === 1 ? '' : 's'}</small></span>
        <span class="lb-thumbs">${e.top.slice(0, 3).map((t) => `<img ${imgAttrs({ id: t.id, images: { small: t.image } })} alt="" loading="lazy">`).join('')}</span>
        <span class="lb-value num">${money(e.value)}</span>
      </button>`).join('');
  }

  function openProfile(id, entries = lbData?.entries) {
    const e = entries?.find((x) => x.id === id);
    if (!e) return;
    $('#sheetBody').innerHTML = `
      <div class="profile">
        <div class="profile-head">
          <span class="pod-avatar lg ${medal(e.rank)}">${faceHtml(e.name, e.avatar)}</span>
          <div>
            <h3 id="sheetTitle">${esc(e.name)}</h3>
            <p class="muted">Rank #${e.rank} · ${e.cards} card${e.cards === 1 ? '' : 's'}</p>
          </div>
          <div class="profile-value"><span class="eyebrow">Collection</span><b class="num">${money(e.value)}</b></div>
        </div>
        <h4 class="profile-sub">Top ${Math.min(5, e.top.length)} card${e.top.length === 1 ? '' : 's'}</h4>
        <div class="profile-cards">
          ${e.top.map((t, i) => `
            <button class="pcard" data-card="${esc(t.id)}">
              <span class="pcard-rank">${i + 1}</span>
              <img ${imgAttrs({ id: t.id, images: { small: t.image } })} alt="" loading="lazy">
              <span class="name">${esc(t.name)}</span>
              <span class="sub">${esc(t.set)}${t.number ? ` · #${esc(t.number)}` : ''}</span>
              <span class="p num">${money(t.price)}${t.qty > 1 ? ` <small>×${t.qty}</small>` : ''}</span>
            </button>`).join('')}
        </div>
      </div>`;
    openSheetShell();
    $$('.pcard').forEach((b) => b.addEventListener('click', async () => {
      try {
        const { card } = await api(`/api/card/${encodeURIComponent(b.dataset.card)}`);
        if (card) openCard({ card });
      } catch { toast('Couldn’t load that card'); }
    }));
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-lb]');
    if (b) openProfile(b.dataset.lb);
  });

  /* ================= Groups ================= */
  let groups = [];
  let openGroup = null; // { id, details, tab, messages: [], lastSeq, firstSeq, board }
  let chatTimer = null, listTimer = null;
  const PENDING_JOIN = 'pokefolio.join';

  // Stable gradient per group name, so each group is recognisable in the list.
  function groupHue(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  const gAvatar = (g, cls = '') => `<span class="g-avatar ${cls}" style="--h:${groupHue(g.id)}">${nameInitial(g.name)}</span>`;
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  function dayLabel(t) {
    const d = new Date(t), now = new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function preview(last) {
    if (!last) return 'No messages yet';
    const who = last.mine ? 'You' : last.name;
    if (last.kind === 'system') return last.body;
    if (last.kind === 'image') return `${who} sent a photo`;
    if (last.kind === 'card') return `${who} shared a card`;
    return `${who}: ${last.body}`;
  }

  async function refreshGroupList() {
    if (!user) return;
    try {
      const res = await api('/api/groups');
      groups = res.groups;
      const badge = $('#groupsBadge');
      badge.hidden = !res.unread;
      badge.textContent = res.unread > 99 ? '99+' : res.unread;
      if ($('#view-groups').classList.contains('active')) renderGroupList();
    } catch (e) {
      if (e.status === 401) signedOut('Your session expired — please sign in again.');
    }
  }
  function startListPolling() {
    clearInterval(listTimer);
    if (user) { refreshGroupList(); listTimer = setInterval(() => { if (!document.hidden) refreshGroupList(); }, 25000); }
  }

  async function loadGroups() {
    if (!user) {
      $('#groupsList').innerHTML = '';
      $('#groupPane').innerHTML = `<div class="group-empty"><div class="reticle small" aria-hidden="true"></div>
        <h3>Groups need an account</h3><p>Create a free account to start group chats with friends, share your pulls and compete on a group leaderboard.</p>
        <button class="btn primary glow" id="groupsSignup">Create account</button></div>`;
      $('#groupsSignup').addEventListener('click', () => { showAuth(); setAuthMode('signup'); });
      $$('.groups-actions .btn').forEach((b) => { b.disabled = true; });
      return;
    }
    $$('.groups-actions .btn').forEach((b) => { b.disabled = false; });
    if (!groups.length) $('#groupsList').innerHTML = Array.from({ length: 3 }, () => '<div class="lb-row skeleton-row"></div>').join('');
    await refreshGroupList();
    renderGroupList();
    if (openGroup) renderGroupPane();
  }

  function renderGroupList() {
    const list = $('#groupsList');
    if (!groups.length) {
      list.innerHTML = '<div class="groups-none"><b>No groups yet</b><span>Create one, or join with an invite code from a friend.</span></div>';
      return;
    }
    list.innerHTML = groups.map((g) => `
      <button class="g-item ${openGroup?.id === g.id ? 'active' : ''}" data-group="${esc(g.id)}">
        ${gAvatar(g)}
        <span class="g-main">
          <span class="g-name">${esc(g.name)}</span>
          <span class="g-last">${esc(preview(g.last))}</span>
        </span>
        <span class="g-meta">
          <span class="g-time">${g.last ? esc(clock(g.last.createdAt)) : ''}</span>
          ${g.unread ? `<b class="g-unread">${g.unread > 99 ? '99+' : g.unread}</b>` : `<span class="g-count">${g.memberCount} 👤</span>`}
        </span>
      </button>`).join('');
  }
  $('#groupsList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-group]');
    if (b) openGroupById(b.dataset.group);
  });

  async function openGroupById(id, tab = 'chat') {
    stopChatPolling();
    openGroup = { id, tab, messages: [], lastSeq: 0, firstSeq: null, details: null, board: null, done: false };
    $('#groupsLayout').classList.add('has-open');
    renderGroupList();
    $('#groupPane').innerHTML = '<div class="group-empty"><div class="reticle small busy" aria-hidden="true"></div></div>';
    try {
      openGroup.details = (await api(`/api/groups/${id}`)).group;
    } catch (e) {
      toast(e.message || 'Couldn’t open that group');
      closeGroup();
      refreshGroupList();
      return;
    }
    renderGroupPane();
  }
  function closeGroup() {
    stopChatPolling();
    openGroup = null;
    $('#groupsLayout').classList.remove('has-open');
    renderGroupList();
    $('#groupPane').innerHTML = '<div class="group-empty"><div class="reticle small" aria-hidden="true"></div><h3>Pick a group</h3><p>Or start a new one and share its invite code with friends.</p></div>';
  }

  function renderGroupPane() {
    const g = openGroup?.details;
    if (!g) return;
    $('#groupPane').innerHTML = `
      <div class="group-head">
        <button class="icon-btn g-back" id="gBack" aria-label="Back to groups">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        ${gAvatar(g)}
        <div class="g-title"><h3>${esc(g.name)}</h3><small>${g.members.length} member${g.members.length === 1 ? '' : 's'}</small></div>
      </div>
      <div class="g-tabs" role="tablist">
        ${[['chat', 'Chat'], ['board', 'Leaderboard'], ['members', 'Members']].map(([k, l]) => `<button role="tab" data-gtab="${k}" class="${openGroup.tab === k ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <div class="g-body" id="gBody"></div>`;
    $('#gBack').addEventListener('click', closeGroup);
    $$('[data-gtab]').forEach((b) => b.addEventListener('click', () => { openGroup.tab = b.dataset.gtab; renderGroupPane(); }));
    if (openGroup.tab === 'chat') renderChat();
    else stopChatPolling();
    if (openGroup.tab === 'board') renderGroupBoard();
    if (openGroup.tab === 'members') {
      renderMembers();
      const g = openGroup, before = g.details.members.length;
      refreshGroupDetails(g).then(() => { if (openGroup === g && g.tab === 'members' && g.details.members.length !== before) renderMembers(); });
    }
  }

  /* ---- chat ---- */
  function renderChat() {
    $('#gBody').innerHTML = `
      <div class="chat" id="chatScroll">
        <button class="btn ghost load-older" id="loadOlder" hidden>Load earlier messages</button>
        <div id="chatMsgs"></div>
      </div>
      <form class="composer" id="composer" autocomplete="off">
        <button type="button" class="icon-btn" id="attachPhoto" title="Send a photo" aria-label="Send a photo">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
        </button>
        <button type="button" class="icon-btn" id="attachCard" title="Share a card from your collection" aria-label="Share a card">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M9 16h6"/></svg>
        </button>
        <input type="file" id="chatPhoto" accept="image/*" hidden>
        <textarea id="chatInput" rows="1" maxlength="2000" placeholder="Message…"></textarea>
        <button class="send" id="sendBtn" aria-label="Send">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3.4 20.4l17.5-7.5a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1.1L4 11l9 1-9 1-2 6.3a1 1 0 0 0 1.4 1.1z"/></svg>
        </button>
      </form>`;
    paintMessages(true);
    const input = $('#chatInput');
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(140, input.scrollHeight) + 'px'; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
    });
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      sendMessage({ text }).then((ok) => { if (ok) { input.value = ''; grow(); } });
    });
    $('#attachPhoto').addEventListener('click', () => $('#chatPhoto').click());
    $('#chatPhoto').addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      e.target.value = '';
      if (!f) return;
      try {
        const image = await shrinkPhoto(f);
        await sendMessage({ kind: 'image', image, text: input.value.trim() }).then((ok) => { if (ok) { input.value = ''; grow(); } });
      } catch { toast('Couldn’t read that photo'); }
    });
    $('#attachCard').addEventListener('click', pickCardToShare);
    $('#loadOlder').addEventListener('click', loadOlder);
    $('#chatMsgs').addEventListener('click', onChatClick);
    if (!openGroup.messages.length) fetchMessages(true); else { fetchMessages(false); startChatPolling(); }
    refreshGroupDetails(openGroup);
  }

  // Phone photos are huge: send at most 1600 px, JPEG.
  async function shrinkPhoto(file) {
    const img = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  async function fetchMessages(initial = false) {
    const g = openGroup;
    if (!g) return;
    try {
      const res = await api(`/api/groups/${g.id}/messages?${initial ? 'limit=50' : `after=${g.lastSeq}`}`);
      if (openGroup !== g) return;
      if (res.messages.length) {
        g.messages = initial ? res.messages : g.messages.concat(res.messages.filter((m) => m.seq > g.lastSeq));
        g.lastSeq = g.messages[g.messages.length - 1].seq;
        g.firstSeq = g.messages[0].seq;
        if (initial) g.done = res.messages.length < 50;
        paintMessages(initial);
        // Someone joined, left, was removed or the group was renamed: refresh the header.
        if (!initial && res.messages.some((m) => m.kind === 'system')) refreshGroupDetails(g);
        const item = groups.find((x) => x.id === g.id);
        if (item && item.unread) { item.unread = 0; renderGroupList(); refreshGroupList(); }
      } else if (initial) {
        g.done = true;
        paintMessages(true);
      }
    } catch (e) {
      if (e.status === 403 || e.status === 404) { toast('You’re no longer in this group'); closeGroup(); refreshGroupList(); return; }
    }
    if (initial) startChatPolling();
  }
  async function refreshGroupDetails(g) {
    try {
      const { group } = await api(`/api/groups/${g.id}`);
      if (openGroup !== g) return;
      g.details = group;
      const t = $('.g-title');
      if (t) t.innerHTML = `<h3>${esc(group.name)}</h3><small>${group.members.length} member${group.members.length === 1 ? '' : 's'}</small>`;
    } catch (e) {
      if (e.status === 403 || e.status === 404) { toast('You’re no longer in this group'); closeGroup(); refreshGroupList(); }
    }
  }
  function startChatPolling() {
    stopChatPolling();
    chatTimer = setInterval(() => { if (!document.hidden && openGroup?.tab === 'chat') fetchMessages(false); }, 3000);
  }
  function stopChatPolling() { clearInterval(chatTimer); chatTimer = null; }

  async function loadOlder() {
    const g = openGroup;
    const btn = $('#loadOlder');
    btn.disabled = true;
    try {
      const res = await api(`/api/groups/${g.id}/messages?before=${g.firstSeq}&limit=50`);
      if (openGroup !== g) return;
      if (res.messages.length) { g.messages = res.messages.concat(g.messages); g.firstSeq = g.messages[0].seq; }
      g.done = res.messages.length < 50;
      const sc = $('#chatScroll'), before = sc.scrollHeight;
      paintMessages(false);
      sc.scrollTop += sc.scrollHeight - before;
    } finally { btn.disabled = false; }
  }

  function paintMessages(scrollToEnd) {
    const box = $('#chatMsgs');
    if (!box || !openGroup) return;
    const sc = $('#chatScroll');
    const nearBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
    const isOwner = openGroup.details.myRole === 'owner';
    let html = '', prevDay = '', prevUser = null, prevTime = 0;
    for (const m of openGroup.messages) {
      const day = dayLabel(m.createdAt);
      if (day !== prevDay) { html += `<div class="day-sep"><span>${esc(day)}</span></div>`; prevDay = day; prevUser = null; }
      if (m.kind === 'system') { html += `<div class="sys-msg">${esc(m.body)} · ${esc(clock(m.createdAt))}</div>`; prevUser = null; continue; }
      const mine = user && m.userId === user.id;
      const grouped = prevUser === m.userId && m.createdAt - prevTime < 5 * 60e3;
      prevUser = m.userId; prevTime = m.createdAt;
      let content = '';
      if (m.kind === 'image' && m.image) content += `<button class="msg-img" data-img="${esc(m.image)}"><img src="${esc(m.image)}" alt="Photo from ${esc(m.name)}" loading="lazy"></button>`;
      if (m.kind === 'card' && m.card) {
        const c = m.card;
        content += `<button class="msg-card" data-card="${esc(c.id)}">
          <img ${imgAttrs({ id: c.id, images: { small: c.image } })} alt="" loading="lazy">
          <span><b>${esc(c.name)}</b><small>${esc(c.set)}${c.number ? ` · #${esc(c.number)}` : ''}</small><em class="num">${c.price != null ? money(c.price) : 'No price yet'}</em></span>
        </button>`;
      }
      if (m.body) content += `<div class="msg-text">${esc(m.body)}</div>`;
      const canDelete = mine || isOwner;
      html += `<div class="msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}" data-seq="${m.seq}">
          ${mine ? '' : `<span class="msg-avatar">${grouped ? '' : faceHtml(m.name, m.avatar)}</span>`}
          <div class="msg-col">
            ${!mine && !grouped ? `<div class="msg-name">${esc(m.name)}</div>` : ''}
            <div class="bubble ${m.kind}">${content}</div>
            <div class="msg-meta">${esc(clock(m.createdAt))}${canDelete ? ` · <button class="msg-del" data-del="${m.seq}">Delete</button>` : ''}</div>
          </div>
        </div>`;
    }
    if (!openGroup.messages.length) html = '<div class="sys-msg">No messages yet — say hi 👋</div>';
    box.innerHTML = html;
    $('#loadOlder').hidden = openGroup.done || !openGroup.messages.length;
    if (scrollToEnd || nearBottom) sc.scrollTop = sc.scrollHeight;
    // Images change height as they load: keep pinned to the bottom.
    if (scrollToEnd || nearBottom) $$('img', box).forEach((im) => im.addEventListener('load', () => { sc.scrollTop = sc.scrollHeight; }, { once: true }));
  }

  async function onChatClick(e) {
    const del = e.target.closest('[data-del]');
    if (del) {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Tap to confirm'; return; }
      try {
        await api(`/api/groups/${openGroup.id}/messages/${del.dataset.del}`, { method: 'DELETE', body: {} });
        openGroup.messages = openGroup.messages.filter((m) => m.seq !== +del.dataset.del);
        paintMessages(false);
      } catch (err) { toast(err.message); }
      return;
    }
    const img = e.target.closest('[data-img]');
    if (img) { openLightbox(img.dataset.img); return; }
    const card = e.target.closest('[data-card]');
    if (card) {
      try {
        const { card: c } = await api(`/api/card/${encodeURIComponent(card.dataset.card)}`);
        if (c) openCard({ card: c });
      } catch { toast('Couldn’t load that card'); }
    }
  }

  function openLightbox(src) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${esc(src)}" alt=""><button class="sheet-close" aria-label="Close"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
    const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    lb.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(lb);
  }

  let sending = false;
  async function sendMessage(body) {
    if (sending || !openGroup) return false;
    sending = true;
    const btn = $('#sendBtn');
    if (btn) btn.disabled = true;
    try {
      const { message } = await api(`/api/groups/${openGroup.id}/messages`, { method: 'POST', body });
      if (message.seq > openGroup.lastSeq) {
        openGroup.messages.push(message);
        openGroup.lastSeq = message.seq;
        if (!openGroup.firstSeq) openGroup.firstSeq = message.seq;
      }
      paintMessages(true);
      refreshGroupList();
      return true;
    } catch (e) {
      toast(e.message || 'Message not sent');
      return false;
    } finally {
      sending = false;
      if (btn) btn.disabled = false;
    }
  }

  function pickCardToShare() {
    const items = state.items.filter((it) => it.card).slice().sort((a, b) => itemValue(b) - itemValue(a));
    $('#sheetBody').innerHTML = `
      <div class="picker">
        <h3 id="sheetTitle">Share a card</h3>
        <p class="muted">${items.length ? 'Pick a card from your collection to share with the group.' : 'Your collection is empty — scan or search for cards to share them here.'}</p>
        <div class="picker-grid">
          ${items.map((it) => `<button class="pcard" data-share="${esc(it.uid)}">
              <img ${imgAttrs(it.card)} alt="" loading="lazy">
              <span class="name">${esc(it.card.name)}</span>
              <span class="sub">${esc(it.card.set?.name)} · #${esc(it.card.number)}</span>
              <span class="p num">${money(itemPrice(it))}</span>
            </button>`).join('')}
        </div>
      </div>`;
    openSheetShell();
    $$('[data-share]').forEach((b) => b.addEventListener('click', async () => {
      const it = state.items.find((x) => x.uid === b.dataset.share);
      closeSheet();
      if (it) await sendMessage({ kind: 'card', cardId: it.cardId, variant: it.variant || null });
    }));
  }

  /* ---- group leaderboard ---- */
  async function renderGroupBoard() {
    const g = openGroup;
    $('#gBody').innerHTML = `<div class="g-board"><div class="podium" id="gPodium"></div><div class="lb-list" id="gList">${Array.from({ length: 3 }, () => '<div class="lb-row skeleton-row"></div>').join('')}</div>
      <p class="note">Ranked by raw collection value, recalculated by PokéFolio from market prices. Everyone in the group can see members’ totals and top 5 cards.</p></div>`;
    try {
      g.board = await api(`/api/groups/${g.id}/leaderboard`);
      if (openGroup !== g || g.tab !== 'board') return;
      $('#gPodium').innerHTML = podiumHtml(g.board.entries, 'data-glb');
      $('#gList').innerHTML = boardListHtml(g.board.entries.slice(3), 'data-glb');
    } catch (e) {
      $('#gList').innerHTML = `<p class="note">${esc(e.message || 'Couldn’t load the leaderboard.')}</p>`;
    }
  }
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-glb]');
    if (b && openGroup?.board) openProfile(b.dataset.glb, openGroup.board.entries);
  });

  /* ---- members & settings ---- */
  const inviteLink = (code) => `${location.origin}/?join=${encodeURIComponent(code)}`;
  function renderMembers() {
    const g = openGroup.details;
    const owner = g.myRole === 'owner';
    $('#gBody').innerHTML = `
      <div class="g-members">
        <div class="invite glass">
          <span class="eyebrow">Invite friends</span>
          <div class="invite-code num" id="inviteCode">${esc(g.inviteCode.replace(/(.{4})/, '$1-'))}</div>
          <p class="muted">Anyone with this code or link can join. Share it with friends who have a PokéFolio account.</p>
          <div class="invite-actions">
            <button class="btn primary" id="copyInvite">Copy invite link</button>
            ${navigator.share ? '<button class="btn" id="shareInvite">Share…</button>' : ''}
            ${owner ? '<button class="btn ghost" id="resetInvite">New code</button>' : ''}
          </div>
        </div>
        <h4 class="profile-sub">${g.members.length} member${g.members.length === 1 ? '' : 's'}</h4>
        <div class="member-list">
          ${g.members.map((m) => `<div class="member-row">
              <span class="pod-avatar sm">${faceHtml(m.name, m.avatar)}</span>
              <span class="lb-name">${esc(m.name)}${m.me ? ' <em>you</em>' : ''}<small>${m.role === 'owner' ? 'Owner' : 'Member'} · joined ${esc(new Date(m.joinedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</small></span>
              ${owner && !m.me ? `<button class="btn ghost danger-text" data-kick="${esc(m.id)}" data-name="${esc(m.name)}">Remove</button>` : ''}
            </div>`).join('')}
        </div>
        <h4 class="profile-sub">Settings</h4>
        ${owner ? `
          <form class="rename" id="renameForm">
            <div class="field"><label for="renameInput">Group name</label><input id="renameInput" maxlength="40" value="${esc(g.name)}"></div>
            <button class="btn" type="submit">Save</button>
          </form>
          <button class="btn danger block" id="deleteGroup">Delete group</button>
          <p class="note">Deleting removes the chat, photos and leaderboard for everyone.</p>` : `
          <button class="btn danger block" id="leaveGroup">Leave group</button>`}
      </div>`;
    $('#copyInvite').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(inviteLink(g.inviteCode)); toast('Invite link copied'); } catch { toast(inviteLink(g.inviteCode)); }
    });
    $('#shareInvite')?.addEventListener('click', () => navigator.share({ title: `Join ${g.name} on PokéFolio`, text: `Join my PokéFolio group “${g.name}” — code ${g.inviteCode}`, url: inviteLink(g.inviteCode) }).catch(() => {}));
    $('#resetInvite')?.addEventListener('click', async () => {
      try {
        g.inviteCode = (await api(`/api/groups/${g.id}/invite`, { method: 'POST', body: {} })).inviteCode;
        toast('New invite code — the old one no longer works');
        renderMembers();
      } catch (e) { toast(e.message); }
    });
    $$('[data-kick]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirm'; return; }
      try {
        await api(`/api/groups/${g.id}/members/${b.dataset.kick}`, { method: 'DELETE', body: {} });
        g.members = g.members.filter((m) => m.id !== b.dataset.kick);
        toast(`Removed ${b.dataset.name}`);
        renderGroupPane();
      } catch (e) { toast(e.message); }
    }));
    $('#renameForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        openGroup.details = (await api(`/api/groups/${g.id}`, { method: 'PATCH', body: { name: $('#renameInput').value } })).group;
        toast('Group renamed');
        renderGroupPane();
        refreshGroupList();
      } catch (err) { toast(err.message); }
    });
    const destructive = (btn, label, run) => btn?.addEventListener('click', async () => {
      if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = `Tap again to ${label}`; return; }
      try { await run(); closeGroup(); await refreshGroupList(); renderGroupList(); } catch (e) { toast(e.message); }
    });
    destructive($('#deleteGroup'), 'delete for everyone', async () => { await api(`/api/groups/${g.id}`, { method: 'DELETE', body: {} }); toast('Group deleted'); });
    destructive($('#leaveGroup'), 'leave', async () => { await api(`/api/groups/${g.id}/leave`, { method: 'POST', body: {} }); toast(`You left ${g.name}`); });
  }

  /* ---- create / join ---- */
  function groupForm({ title, label, placeholder, button, value = '', maxlength = 40, onSubmit, hint = '' }) {
    $('#sheetBody').innerHTML = `
      <form class="g-form" id="gForm">
        <h3 id="sheetTitle">${title}</h3>
        ${hint ? `<p class="muted">${hint}</p>` : ''}
        <div class="field"><label for="gFormInput">${label}</label><input id="gFormInput" maxlength="${maxlength}" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off"></div>
        <p class="auth-error" id="gFormError" hidden></p>
        <button class="btn primary glow block" type="submit">${button}</button>
      </form>`;
    openSheetShell();
    setTimeout(() => $('#gFormInput').focus(), 50);
    $('#gForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('#gForm button[type=submit]');
      btn.disabled = true;
      try { await onSubmit($('#gFormInput').value.trim()); } catch (err) {
        $('#gFormError').textContent = err.message || 'Something went wrong';
        $('#gFormError').hidden = false;
      } finally { btn.disabled = false; }
    });
  }
  $('#newGroupBtn').addEventListener('click', () => groupForm({
    title: 'New group', label: 'Group name', placeholder: 'e.g. Friday Night Pulls', button: 'Create group',
    hint: 'You’ll get an invite code to share with friends.',
    onSubmit: async (name) => {
      const { group } = await api('/api/groups', { method: 'POST', body: { name } });
      closeSheet();
      await refreshGroupList();
      openGroupById(group.id, 'members');
    },
  }));
  function joinPrompt(code = '') {
    groupForm({
      title: 'Join a group', label: 'Invite code', placeholder: 'ABCD-EFGH', button: 'Join group', value: code, maxlength: 12,
      hint: 'Ask a friend for their group’s invite code.',
      onSubmit: async (c) => {
        const { group, alreadyMember } = await api('/api/groups/join', { method: 'POST', body: { code: c } });
        closeSheet();
        toast(alreadyMember ? `You’re already in ${group.name}` : `Joined ${group.name}`);
        await refreshGroupList();
        go('groups');
        openGroupById(group.id);
      },
    });
  }
  $('#joinGroupBtn').addEventListener('click', () => joinPrompt());

  // Invite links: /?join=CODE — remembered across sign-in.
  function handleInviteLink() {
    const params = new URLSearchParams(location.search);
    const code = params.get('join');
    if (code) {
      try { sessionStorage.setItem(PENDING_JOIN, code); } catch { /* ignore */ }
      history.replaceState(null, '', location.pathname);
    }
    let pending = null;
    try { pending = sessionStorage.getItem(PENDING_JOIN); } catch { /* ignore */ }
    if (pending && user) {
      try { sessionStorage.removeItem(PENDING_JOIN); } catch { /* ignore */ }
      go('groups');
      joinPrompt(pending);
    } else if (pending && !user && $('#auth').hidden === false) {
      $('#authError').textContent = 'Sign in or create an account to join the group you were invited to.';
      $('#authError').hidden = false;
    }
  }

  /* ================= Grader ================= */
  const gradeFiles = { front: null, back: null };
  /* ---------- which card is being graded (official image = reference) ---------- */
  let gradeRef = null;     // the selected card
  let gradeChoices = [];   // cards currently offered as tiles
  let gradeSuggestReq = 0;
  function showGradeChoices(cards, label, scores = null) {
    gradeChoices = cards;
    $('#gradeResLabel').hidden = !label;
    $('#gradeResLabel').textContent = label || '';
    $('#gradeResults').innerHTML = cards.map((c, i) => `
      <button type="button" class="gp-tile" data-gi="${i}">
        ${scores?.get(c.id) != null ? `<span class="match">${Math.round(scores.get(c.id) * 100)}%</span>` : ''}
        <img ${imgAttrs(c, 'small', { proxy: true })} alt="" loading="lazy">
        <b>${esc(c.name)}</b>
        <small>${c.lang === 'ja' ? 'JP · ' : ''}${esc(c.set?.name)} · #${esc(c.number)}</small>
      </button>`).join('');
  }
  function showCollectionChoices() {
    const mine = [...new Map(state.items.filter((it) => it.card).map((it) => [it.cardId, it.card])).values()].slice(0, 12);
    showGradeChoices(mine, mine.length ? 'From your collection' : '');
  }
  function paintGradeRef() {
    const box = $('#gradeSelected');
    $('#gradeFinder').hidden = !!gradeRef;
    box.hidden = !gradeRef;
    if (!gradeRef) return;
    const c = gradeRef;
    box.innerHTML = `<img ${imgAttrs(c, 'small', { proxy: true })} alt="">
      <div class="meta"><span class="ok">✓ Selected</span><b>${esc(c.name)}</b><small>${c.lang === 'ja' ? 'Japanese · ' : ''}${esc(c.set?.name)} · #${esc(c.number)}${c.set?.printedTotal ? '/' + esc(c.set.printedTotal) : ''}</small></div>
      <button type="button" class="btn ghost" id="gradeChange">Change</button>`;
  }
  async function selectGradeCard(c) {
    gradeRef = c;
    paintGradeRef();
    if (c.lite) {
      try { const { card } = await api(`/api/card/${encodeURIComponent(c.id)}`); if (gradeRef?.id === c.id) { gradeRef = card; paintGradeRef(); } } catch { /* the lightweight card is enough to grade */ }
    }
  }
  $('#gradeResults').addEventListener('click', (e) => {
    const t = e.target.closest('[data-gi]');
    if (t) selectGradeCard(gradeChoices[+t.dataset.gi]);
  });
  $('#gradeSelected').addEventListener('click', (e) => {
    if (!e.target.closest('#gradeChange')) return;
    gradeRef = null;
    paintGradeRef();
    if (!gradeChoices.length) showCollectionChoices();
    $('#gradeQuery').focus();
  });
  $('#gradeSearch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#gradeQuery').value.trim();
    if (!q) return showCollectionChoices();
    $('#gradeResLabel').hidden = false;
    $('#gradeResLabel').textContent = 'Searching…';
    $('#gradeResults').innerHTML = '';
    try {
      const cards = await findCards(parseSearchText(q));
      showGradeChoices(cards.slice(0, 24), cards.length ? `Tap the card you’re grading` : `No cards found for “${q}”`);
    } catch (err) {
      showGradeChoices([], err.status === 429 ? err.message : 'Couldn’t reach the card database — try again.');
    }
  });
  // Suggest the card from the front photo, using the scanner's image recognition.
  async function suggestFromPhoto(file) {
    if (gradeRef || !window.CardVision) return;
    const req = ++gradeSuggestReq;
    try {
      const bmp = await createImageBitmap(file);
      const c = document.createElement('canvas');
      const sc = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      $('#gradeResLabel').hidden = false;
      $('#gradeResLabel').textContent = 'Recognising your card…';
      const res = await visualSearch(c, { isCard: false, lang: 'any' });
      if (req !== gradeSuggestReq || gradeRef) return;
      const hits = (res?.results || []).slice(0, 6);
      if (!hits.length) return showCollectionChoices();
      showGradeChoices(hits.map((h) => h.card), 'Is it one of these? Tap to select — or search', new Map(hits.map((h) => [h.card.id, h.score])));
    } catch {
      if (req === gradeSuggestReq) showCollectionChoices();
    }
  }
  function prepareGrader() {
    paintGradeRef();
    if (!gradeRef && !gradeChoices.length && !$('#gradeQuery').value) showCollectionChoices();
  }
  function loadRefImage(card) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = cardImgUrl(card.id, 'large');
    });
  }
  for (const side of ['front', 'back']) {
    const input = $(side === 'front' ? '#gradeFront' : '#gradeBack');
    const drop = $(side === 'front' ? '#dropFront' : '#dropBack');
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (!f) return;
      gradeFiles[side] = f;
      const img = $('img', drop);
      if (img.src) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(f);
      img.hidden = false;
      drop.classList.add('has-img');
      $('#gradeBtn').disabled = !gradeFiles.front;
      if (side === 'front') suggestFromPhoto(f);
    });
  }

  const GRADE_NAMES = { 10: 'Gem Mint', 9: 'Mint', 8: 'NM-MT', 7: 'Near Mint', 6: 'EX-MT', 5: 'Excellent', 4: 'VG-EX', 3: 'Very Good', 2: 'Good', 1: 'Poor' };
  $('#gradeBtn').addEventListener('click', async () => {
    const btn = $('#gradeBtn');
    const out = $('#gradeResult');
    if (!window.CardGrader || !gradeFiles.front) return;
    btn.disabled = true;
    btn.textContent = 'Analysing…';
    out.innerHTML = '<div class="grade-empty glass"><div class="reticle small busy" aria-hidden="true"></div><h3>Measuring centering, edges, corners & surface…</h3></div>';
    try {
      const reference = gradeRef ? await loadRefImage(gradeRef) : null;
      if (gradeRef && !reference) toast('Couldn’t load the card’s official image — grading without it');
      const r = await window.CardGrader.grade(gradeFiles.front, gradeFiles.back, { reference });
      if (!r.ok) {
        out.innerHTML = `<div class="grade-empty glass"><h3>Couldn’t grade that</h3>${r.errors.map((e) => `<p>${esc(e)}</p>`).join('')}</div>`;
        return;
      }
      renderGrade(r);
    } catch (e) {
      console.error(e);
      out.innerHTML = `<div class="grade-empty glass"><h3>Something went wrong reading those photos</h3><p>Try a JPEG or PNG photo taken with your phone camera.</p><p class="muted"><small>Details: ${esc(e?.message || e)}</small></p></div>`;
    } finally {
      btn.disabled = !gradeFiles.front;
      btn.textContent = 'Grade my card';
    }
  });

  function renderGrade(r) {
    const out = $('#gradeResult');
    const sub = (label, g, note) => `
      <div class="subgrade">
        <div class="sg-top"><span>${label}</span><b class="num">${g ?? '—'}</b></div>
        <div class="bar"><i style="width:${(g ?? 0) * 10}%" class="${g >= 9 ? 'hi' : g >= 7 ? 'mid' : 'lo'}"></i></div>
        ${note ? `<small>${note}</small>` : ''}
      </div>`;
    const ratio = (v) => (v == null ? '—' : `${Math.round(v)}/${100 - Math.round(v)}`);
    const mm = (v) => (v == null ? '—' : `${v.toFixed(1)} mm`);
    const cenBlock = (side) => {
      const c = r.centering[side];
      if (!c) return '';
      return `<div class="cen glass">
          <div class="cen-title">${side === 'front' ? 'Front' : 'Back'} centering</div>
          <div class="cen-ratios"><div><span>Left / Right</span><b class="num">${ratio(c.lr)}</b></div><div><span>Top / Bottom</span><b class="num">${ratio(c.tb)}</b></div></div>
          <div class="cen-diagram">
            <span class="t num">${mm(c.mm.top)}</span><span class="l num">${mm(c.mm.left)}</span>
            <span class="box"></span>
            <span class="r num">${mm(c.mm.right)}</span><span class="b num">${mm(c.mm.bottom)}</span>
          </div>
        </div>`;
    };
    const linked = gradeRef && (state.items.find((it) => it.cardId === gradeRef.id)
      || { cardId: gradeRef.id, variant: defaultVariant(gradeRef), card: gradeRef });
    out.innerHTML = `
      <div class="grade-hero glass edge">
        <div class="grade-badge ${r.overall >= 9 ? 'hi' : r.overall >= 7 ? 'mid' : 'lo'}">
          <span class="eyebrow">Estimated</span>
          <b class="num">${r.overall}</b>
          <span>${GRADE_NAMES[r.overall] || ''}</span>
        </div>
        <div class="grade-summary">
          <div class="eyebrow">PSA-style estimate · likely range ${r.range[0] === r.range[1] ? r.range[0] : `${r.range[0]}–${r.range[1]}`}</div>
          <div class="conf conf-${r.confidence}">Photo quality: ${r.confidence}</div>
          <div class="subgrades">
            ${sub('Centering', r.subs.centering, r.subs.centering == null ? 'Couldn’t measure — not counted' : r.centering.front ? `Front ${ratio(r.centering.front.lr)} L/R · ${ratio(r.centering.front.tb)} T/B${r.centering.back?.measurable ? ` · Back ${ratio(r.centering.back.lr)} L/R` : ''}` : '')}
            ${sub('Corners', r.subs.corners)}
            ${sub('Edges', r.subs.edges)}
            ${sub('Surface', r.subs.surface)}
          </div>
          <div id="gradeValue"></div>
        </div>
      </div>
      ${r.warnings.length ? `<div class="warn-list">${r.warnings.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join('')}</div>` : ''}
      <div class="cen-row">${cenBlock('front')}${cenBlock('back')}</div>
      <div class="section"><h4>Findings</h4>
        <ul class="findings">${r.findings.map((f) => `<li class="f-${f.level}">${esc(f.text)}</li>`).join('')}</ul>
      </div>
      <div class="section"><h4>What we measured</h4>
        <div class="overlays">
          ${Object.keys(r.sides).map((s) => `<figure><canvas data-ov="${s}"></canvas><figcaption>${s === 'front' ? 'Front' : 'Back'} — <span class="k-cyan">border lines</span> · <span class="k-red">edge wear</span> · <span class="k-green">good corner</span> / <span class="k-red">worn corner</span>${s === 'back' || r.sides[s].reference?.ok ? ' · <span class="k-amber">crease / spot</span>' : ' · <span class="k-amber">spot</span>'}</figcaption></figure>`).join('')}
        </div>
      </div>
      <p class="note">This is an estimate from photos, not an official grade. Grading companies inspect cards under magnification and lighting a photo can’t reproduce; holo scratches, print lines and very small dings may not show up. Centering standards used: PSA 10 = 55/45 front, 75/25 back.</p>`;
    for (const c of $$('canvas[data-ov]', out)) window.CardGrader.drawOverlay(r.sides[c.dataset.ov], c);
    if (linked) showValueAtGrade(linked, r.overall);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function showValueAtGrade(item, grade) {
    const box = $('#gradeValue');
    box.innerHTML = '<div class="gv"><span class="skeleton-line"></span></div>';
    try {
      const res = await api(`/api/prices/${encodeURIComponent(item.cardId)}?variant=${encodeURIComponent(item.variant || '')}`);
      const p = res.graded?.prices || {};
      const key = grade === 10 ? 'PSA 10' : `Grade ${grade}`;
      const raw = res.raw?.price ?? itemPrice(item);
      const at = p[key];
      box.innerHTML = `<div class="gv">
          <div><span class="eyebrow">${esc(item.card.name)} at PSA ${grade}${res.graded?.estimated?.includes(key) ? ' (estimate)' : ''}</span><b class="num">${at != null ? `${res.graded?.estimated?.includes(key) ? '≈' : ''}${money(at)}` : 'No sales data'}</b></div>
          <div><span class="eyebrow">Raw</span><b class="num">${money(raw)}</b></div>
          ${at != null && raw ? `<div><span class="eyebrow">Difference</span><b class="num ${at - raw >= 0 ? 'up' : 'down'}">${signed(at - raw)}</b></div>` : ''}
        </div>`;
    } catch {
      box.innerHTML = '';
    }
  }

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
  // Warn loudly if this deployment would lose accounts on the next update.
  let storageInfo = null;
  api('/api/health').then((h) => {
    storageInfo = h;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (!h.persistent && !local) $$('.storage-warn').forEach((el) => { el.hidden = false; });
  }).catch(() => {});

  (async () => {
    try {
      user = (await api('/api/auth/me')).user;
    } catch {
      user = null;
    }
    if (user || lsGet(GUEST_FLAG) === '1') enterApp();
    else { showAuth(); handleInviteLink(); }
  })();
})();
