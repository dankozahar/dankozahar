/* Mezza Gurme — digital menu. Vanilla JS, no build step. Data: data/menu.js, strings: assets/js/i18n.js */
(function () {
  'use strict';

  const M = window.MENU;
  const I18N = window.I18N;
  if (!M || !I18N) return;

  const LANGS = M.langs.filter(l => I18N[l]);
  const doc = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = window.matchMedia('(min-width: 1024px)');
  const wide = window.matchMedia('(min-width: 768px)');

  // localStorage can be missing or throw (private mode, blocked storage) — the menu must work anyway
  const store = {
    get(k, d) { try { const v = localStorage.getItem('mezza:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('mezza:' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };

  const params = new URLSearchParams(location.search);
  const table = (params.get('table') || params.get('masa') || '').replace(/[^\w-]/g, '').slice(0, 8);

  /* ---------------------------------------------------------------- i18n */

  function pickLang() {
    const q = (params.get('lang') || '').toLowerCase();
    if (LANGS.includes(q)) return q;
    const saved = store.get('lang');
    if (LANGS.includes(saved)) return saved;
    const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (const p of prefs) {
      const c = String(p).slice(0, 2).toLowerCase();
      if (LANGS.includes(c)) return c;
    }
    return 'en';
  }

  let lang = pickLang();
  let NF, PR, NF_TR = new Intl.NumberFormat('tr-TR');

  function setLocale() {
    const loc = I18N[lang].locale;
    NF = new Intl.NumberFormat(loc, { maximumFractionDigits: 0 });
    PR = new Intl.PluralRules(loc);
  }

  function t(key, vars) {
    let s = I18N[lang][key];
    if (s == null) s = M.brand[lang] && M.brand[lang][key];
    if (s == null) s = I18N.en[key];
    if (s == null) s = (M.brand.en && M.brand.en[key]) || '';
    if (vars) s = String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : vars[k]));
    return s;
  }
  function plural(key, n) {
    const forms = I18N[lang][key] || I18N.en[key];
    return (forms[PR.select(n)] || forms.other).replace('{n}', NF.format(n));
  }
  const num = n => NF.format(n);
  const priceHTML = n => (n == null ? '' : `${num(n)}<small>₺</small>`);
  const priceText = n => `${num(n)} ₺`;
  const priceTR = n => `${NF_TR.format(n)} ₺`;
  const titleHTML = () => {
    const a = t('menu.title'), b = t('menu.titleItalic');
    // TR splits one word ("Menü" + "müz"); other languages are two words
    const glue = /^[a-zçğıöşü]/.test(b) ? '' : ' ';
    return `${esc(a)}${glue}<em>${esc(b)}</em>`;
  };
  const emLast = s => {
    const i = s.lastIndexOf(' ');
    return i < 0 ? `<em>${esc(s)}</em>` : `${esc(s.slice(0, i))} <em>${esc(s.slice(i + 1))}</em>`;
  };

  /* -------------------------------------------------------------- indexes */

  const catById = new Map(M.cats.map(c => [c.id, c]));
  const itemsByCat = new Map(M.cats.map(c => [c.id, []]));
  const cardByN = new Map();   // any menu number -> card (variants point to their card)
  const unitByN = new Map();   // orderable unit: menu number -> { it, v }
  M.items.forEach((it, i) => {
    it.i = i;
    itemsByCat.get(it.cat).push(it);
    cardByN.set(it.n, it);
    if (it.variants) it.variants.forEach(v => { unitByN.set(v.n, { it, v }); cardByN.set(v.n, it); });
    else unitByN.set(it.n, { it, v: null });
  });
  let groups = [];
  const totalPositions = M.cats.reduce((a, c) => a + c.count, 0);
  const algName = k => { const a = M.allergens.find(x => x.key === k); return a ? a.name[lang] : k; };

  const thumb = h => `photos/s/${h}.webp`;
  const photo = h => `photos/${h}.webp`;
  const nameOf = it => it.name[lang] || it.name.tr;
  const descOf = it => (it.desc && it.desc[lang]) || '';

  /* ------------------------------------------------------- service hours */

  const hmFmt = (() => {
    try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
    catch (e) { return null; }
  })();
  function nowHM() {
    if (hmFmt) return hmFmt.format(new Date());
    const d = new Date(Date.now() + (d0 => d0.getTimezoneOffset() * 60000)(new Date()) + 3 * 3600000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  const isServed = c => { if (!c.hours) return true; const n = nowHM(); return n >= c.hours[0] && n < c.hours[1]; };

  function updateService() {
    for (const c of M.cats) {
      if (!c.hours) continue;
      const closed = !isServed(c);
      const sec = document.getElementById('c-' + c.id);
      if (sec) sec.classList.toggle('is-closed', closed);
      $$(`[data-closed="${c.id}"]`).forEach(el => { el.hidden = !closed; });
    }
  }

  /* ---------------------------------------------------------------- order */

  let order = {};
  (function loadOrder() {
    const saved = store.get('order', null);
    // a list from yesterday's dinner is not today's order
    if (saved && saved.at && Date.now() - saved.at < 12 * 3600e3 && saved.items) {
      for (const [n, q] of Object.entries(saved.items)) if (unitByN.has(+n) && q > 0) order[n] = Math.min(99, q | 0);
    }
  })();
  const saveOrder = () => store.set('order', { at: Date.now(), items: order });
  const qtyOf = n => order[n] || 0;
  const qtyOfCard = it => (it.variants ? it.variants.reduce((a, v) => a + qtyOf(v.n), 0) : qtyOf(it.n));
  function orderLines() {
    return Object.keys(order).map(Number).filter(n => order[n] > 0 && unitByN.has(n)).map(n => {
      const { it, v } = unitByN.get(n);
      return { n, it, v, q: order[n], price: v ? v.price : it.price };
    }).sort((a, b) => a.it.i - b.it.i || a.n - b.n);
  }
  const orderCount = () => orderLines().reduce((a, l) => a + l.q, 0);
  const orderTotal = () => orderLines().reduce((a, l) => a + l.q * (l.price || 0), 0);

  function changeQty(n, delta, fromCard = false) {
    if (!unitByN.has(n)) return;
    const q = Math.max(0, Math.min(99, qtyOf(n) + delta));
    if (q) order[n] = q; else delete order[n];
    saveOrder();
    refreshQty(n, delta > 0);
    if (delta > 0) {
      if (navigator.vibrate) try { navigator.vibrate(8); } catch (e) { /* ignore */ }
      if (fromCard && q === 1) toast(t('order.added'), 'check');
    }
  }

  /* ------------------------------------------------------------ rendering */

  const els = {
    topbar: $('#topbar'), hero: $('.hero'), menu: $('#menu'), chips: $('#chips'), sidenav: $('#sidenav'),
    catbar: $('#catbar'), rail: $('#featRail'), orderbar: $('#orderbar'), toTop: $('#toTop'), toast: $('#toast'),
    sheets: $('#sheets')
  };

  function addButton(it) {
    const q = qtyOfCard(it);
    return `<button class="add${q ? ' has-qty' : ''}" type="button" data-add="${it.n}" aria-label="${esc(t('item.add'))}: ${esc(nameOf(it))}">${q || icon('plus')}</button>`;
  }

  function cardHTML(it) {
    const name = nameOf(it);
    const desc = descOf(it);
    const price = it.variants
      ? `<div class="vchips">${it.variants.map(v => `<span class="vchip">${esc(v.label)} <b>${num(v.price)}</b></span>`).join('')}</div>`
      : `<span class="price">${priceHTML(it.price)}</span>`;
    const label = it.variants ? name : `${name}, ${it.price != null ? priceText(it.price) : ''}`;
    return `<article class="card${it.img ? '' : ' card--noimg'}" data-n="${it.n}">
<button class="card__hit" type="button" data-open="${it.n}" aria-label="${esc(label)}"></button>
<div class="card__body">${it.variants ? '' : `<p class="card__no">${esc(t('item.no'))} ${it.n}</p>`}<h4 class="card__name">${esc(name)}</h4>${desc ? `<p class="card__desc">${esc(desc)}</p>` : ''}${it.siyez ? `<div class="card__tags"><span class="tag">${icon('wheat')}${esc(t('menu.siyezBadge'))}</span></div>` : ''}<div class="card__foot">${price}${it.img ? '' : addButton(it)}</div></div>${it.img ? `<div class="card__side"><div class="card__media" style="--c:${it.c}"><img src="${thumb(it.img)}" alt="" width="480" height="320" loading="lazy" decoding="async"></div>${addButton(it)}</div>` : ''}
</article>`;
  }

  function catHTML(c) {
    const service = c.hours
      ? `<div class="cat__service"><span class="pill">${icon('clock')}${esc(t('menu.serviceBetween', { start: c.hours[0], end: c.hours[1] }))}</span><span class="pill pill--warn" data-closed="${c.id}" hidden>${esc(t('menu.closedNow'))}</span></div>`
      : '';
    return `<section class="cat" id="c-${c.id}" data-cat="${c.id}" aria-labelledby="h-${c.id}">
<header class="cat__head"><h3 class="cat__title" id="h-${c.id}">${esc(c.name[lang])}</h3><span class="cat__count">${esc(plural('count.items', c.count))}</span>${service}</header>
<div class="cards">${itemsByCat.get(c.id).map(cardHTML).join('')}</div>
</section>`;
  }

  function renderMenu() {
    els.menu.innerHTML = groups.map((g, i) => {
      const count = g.cats.reduce((a, c) => a + c.count, 0);
      return `<section class="group" id="g-${g.id}">
<header class="group__head"><span class="group__no">${String(i + 1).padStart(2, '0')}</span><h2 class="group__title" id="gh-${g.id}">${esc(t('menuGroups.' + g.id))}</h2><span class="group__count">${esc(plural('count.items', count))}</span></header>
${g.cats.map(catHTML).join('')}
</section>`;
    }).join('');
    catSections = $$('.cat', els.menu);
    markLoaded(els.menu);
  }

  function renderNav() {
    els.chips.innerHTML = groups.flatMap(g => g.cats).map(c =>
      `<a class="chip" href="#c-${c.id}" data-go="${c.id}">${esc(c.name[lang])}${c.hours ? `<span class="chip__dot" data-closed="${c.id}" hidden></span>` : ''}</a>`
    ).join('');
    els.sidenav.innerHTML = groups.map(g =>
      `<div class="sidenav__group"><span>${esc(t('menuGroups.' + g.id))}</span>${g.cats.map(c =>
        `<a href="#c-${c.id}" data-go="${c.id}"><span>${esc(c.name[lang])}</span><small>${c.count}</small></a>`).join('')}</div>`
    ).join('');
    activeCat = null;
  }

  function renderFeatured() {
    $('#featTitle').innerHTML = emLast(t('home.featuredTitle'));
    els.rail.innerHTML = M.featured.map((f, i) => {
      const it = cardByN.get(f.n);
      if (!it) return '';
      const src = f.img || (it.img ? photo(it.img) : '');
      const badge = f.badge ? `<span class="badge">${icon(f.badge === 'star' ? 'spark' : 'heart')}${esc(t('badge.' + f.badge))}</span>` : '';
      const desc = descOf(it);
      return `<button class="feat" type="button" data-open="${it.n}" style="--c:${it.c || ''}">
${src ? `<img src="${src}" alt="" width="700" height="466"${i < 2 ? '' : ' loading="lazy"'} decoding="async">` : ''}${badge}
<span class="feat__body"><span class="feat__name">${esc(nameOf(it))}</span>${desc ? `<span class="feat__desc">${esc(desc)}</span>` : ''}
<span class="feat__foot"><span class="price">${priceHTML(it.price)}</span><span class="link">${icon('right')}</span></span></span></button>`;
    }).join('');
    markLoaded(els.rail);
  }

  function renderStatic() {
    doc.lang = lang;
    document.title = `${t('menu.title')}${/^[a-zçğıöşü]/.test(t('menu.titleItalic')) ? '' : ' '}${t('menu.titleItalic')} · Mezza Gurme`;
    $$('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
    $$('[data-label]').forEach(el => { const s = t(el.dataset.label); el.setAttribute('aria-label', s); el.title = s; });
    $('#heroTitle').innerHTML = titleHTML();
    $('#heroMeta').textContent = `${plural('count.cats', M.cats.length)} · ${plural('count.items', totalPositions)}`;
    $('#menuCount').textContent = plural('count.items', totalPositions);
    $('#langFlag').setAttribute('href', '#flag-' + lang);
    $('#langCode').textContent = lang.toUpperCase();

    const pill = $('#tablePill');
    if (table) { pill.hidden = false; pill.lastElementChild.textContent = t('table', { n: table }); }

    $('#claims').innerHTML = [['wheat', 1], ['bread', 2], ['leaf', 3], ['route', 4]].map(([ic, k]) =>
      `<div class="claim reveal">${icon(ic)}<h3>${esc(t(`home.claim${k}Title`))}</h3><p>${esc(t(`home.claim${k}Desc`))}</p></div>`
    ).join('');

    const C = M.contact;
    const wa = text => `https://wa.me/${C.whatsapp}?text=${encodeURIComponent(text)}`;
    $('#contactList').innerHTML = [
      [wa(t('whatsapp.orderMessage')), 'wa', 'WhatsApp', C.phone, true],
      ['tel:' + C.phoneHref, 'phone', t('foot.call'), C.phone, false],
      [`https://instagram.com/${C.instagram}`, 'ig', t('contact.instagramRestaurant'), '@' + C.instagram, true],
      [`https://instagram.com/${C.instagramMarket}`, 'ig', t('contact.instagramMarket'), '@' + C.instagramMarket, true],
      [C.tripadvisor, 'star', t('contact.rateUs').replace(/\s*↗\s*$/, ''), 'Tripadvisor', true],
      ['mailto:' + C.email, 'mail', C.email, '', false]
    ].map(([href, ic, label, small, ext]) =>
      `<li><a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>${icon(ic)}<span>${esc(label)}</span>${small ? `<small>${esc(small)}</small>` : ''}</a></li>`
    ).join('');
    $('#ctaReserve').href = wa(t('form.waIntro'));
    $('#ctaCall').href = 'tel:' + C.phoneHref;
    $('#igMarket').href = `https://instagram.com/${C.instagramMarket}`;
    $('#hours').textContent = `${C.open} – ${C.close}`;
    $('#hoursNote').textContent = t('foot.daily');
    const upd = new Date(M.updated);
    $('#updated').textContent = isNaN(upd) ? '' : t('foot.updated', { date: upd.toLocaleDateString(I18N[lang].locale, { day: 'numeric', month: 'long', year: 'numeric' }) });
    $('#year').textContent = String(new Date().getFullYear());
  }

  // Outside breakfast hours the breakfast block moves to the end of the menu,
  // so an evening guest starts with dishes they can actually order.
  function orderGroups() {
    const gs = M.groups.map(id => ({ id, cats: M.cats.filter(c => c.group === id) }));
    const resting = gs.filter(g => {
      const timed = g.cats.filter(c => c.hours);
      return timed.length && timed.every(c => !isServed(c));
    });
    return gs.filter(g => !resting.includes(g)).concat(resting);
  }

  function renderAll() {
    groups = orderGroups();
    setLocale();
    renderStatic();
    renderFeatured();
    renderNav();
    renderMenu();
    applyView();
    updateService();
    refreshOrderBar(false);
    observeReveals();
    spy();
  }

  /* ---------------------------------------------------- images & reveals */

  document.addEventListener('load', e => { if (e.target.tagName === 'IMG') e.target.classList.add('is-in'); }, true);
  document.addEventListener('error', e => { if (e.target.tagName === 'IMG') { e.target.classList.add('is-in'); e.target.style.visibility = 'hidden'; } }, true);
  function markLoaded(root) {
    $$('img', root).forEach(img => { if (img.complete && img.naturalWidth) img.classList.add('is-in'); });
  }

  let revealObs = null;
  function observeReveals() {
    const items = $$('.reveal:not(.is-in)');
    if (!('IntersectionObserver' in window) || reduceMotion) { items.forEach(el => el.classList.add('is-in')); return; }
    if (!revealObs) {
      revealObs = new IntersectionObserver(entries => entries.forEach(en => {
        if (en.isIntersecting) { en.target.classList.add('is-in'); revealObs.unobserve(en.target); }
      }), { rootMargin: '0px 0px -8% 0px' });
    }
    items.forEach(el => revealObs.observe(el));
  }

  /* ------------------------------------------------ scroll, spy, nav jump */

  let catSections = [];
  let activeCat = null;
  let spyLockUntil = 0;

  const catbarVisible = () => els.catbar.offsetParent !== null && getComputedStyle(els.catbar).display !== 'none';
  const stickyOffset = () => els.topbar.offsetHeight + (catbarVisible() ? els.catbar.offsetHeight : 0);

  function setActive(id) {
    if (id === activeCat) return;
    activeCat = id;
    $$('[data-go].is-active').forEach(el => el.classList.remove('is-active'));
    if (!id) return;
    $$(`[data-go="${id}"]`).forEach(el => el.classList.add('is-active'));
    const chip = $(`.chip[data-go="${id}"]`, els.chips);
    if (chip && catbarVisible()) {
      const left = chip.offsetLeft - els.chips.offsetLeft - 16;
      els.chips.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    const side = $(`a[data-go="${id}"]`, els.sidenav);
    if (side && desktop.matches) {
      const r = side.getBoundingClientRect(), p = els.sidenav.getBoundingClientRect();
      if (r.top < p.top + 40 || r.bottom > p.bottom - 40) els.sidenav.scrollTop += r.top - p.top - p.height / 3;
    }
  }

  function spy() {
    if (Date.now() < spyLockUntil) return;
    const off = stickyOffset() + 28;
    let current = null;
    for (const sec of catSections) {
      if (sec.getBoundingClientRect().top - off <= 0) current = sec.dataset.cat; else break;
    }
    setActive(current);
  }

  function scrollToCat(id, smooth = true) {
    const sec = document.getElementById('c-' + id);
    if (!sec) return;
    const top = Math.max(0, sec.getBoundingClientRect().top + window.scrollY - stickyOffset() + 2);
    spyLockUntil = Date.now() + (smooth ? 900 : 100);
    setActive(id);
    window.scrollTo({ top, behavior: smooth && !reduceMotion ? 'smooth' : 'auto' });
  }

  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = window.scrollY;
    els.topbar.classList.toggle('is-solid', y > els.hero.offsetHeight - els.topbar.offsetHeight - 30);
    els.toTop.classList.toggle('is-visible', y > 1400);
    spy();
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  window.addEventListener('resize', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  if ('onscrollend' in window) window.addEventListener('scrollend', () => { spyLockUntil = 0; spy(); });

  /* -------------------------------------------------------------- view */

  let view = store.get('view', 'list') === 'grid' ? 'grid' : 'list';
  function applyView() {
    els.menu.classList.toggle('view-grid', view === 'grid');
    $('#viewList').setAttribute('aria-pressed', String(view === 'list'));
    $('#viewGrid').setAttribute('aria-pressed', String(view === 'grid'));
  }
  function setView(v) {
    if (v === view) return;
    const anchor = activeCat;
    view = v; store.set('view', v); applyView();
    if (anchor) scrollToCat(anchor, false);
  }

  /* --------------------------------------------------------------- toast */

  let toastTimer = 0;
  function toast(msg, ic = 'check') {
    els.toast.innerHTML = `${icon(ic)}<span>${esc(msg)}</span>`;
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 1800);
  }

  /* -------------------------------------------------------------- sheets */

  const stack = [];
  let lockY = 0;
  history.scrollRestoration = 'manual';

  function lockScroll() {
    if (doc.classList.contains('is-locked')) return;
    lockY = window.scrollY;
    const gap = window.innerWidth - doc.clientWidth;
    doc.classList.add('is-locked');
    doc.style.overflow = 'hidden';
    if (gap > 0) document.body.style.paddingRight = gap + 'px';
  }
  function unlockScroll() {
    doc.classList.remove('is-locked');
    doc.style.overflow = '';
    document.body.style.paddingRight = '';
    if (Math.abs(window.scrollY - lockY) > 2) window.scrollTo(0, lockY);
  }

  function openSheet({ kind, html, label, cls = '', close = true, onOpen, onClose }) {
    const el = document.createElement('div');
    el.className = `sheet sheet--${kind} ${cls}`;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    if (label) el.setAttribute('aria-label', label);
    const full = kind === 'search' || kind === 'waiter';
    el.innerHTML = `<div class="sheet__backdrop" data-close></div><div class="sheet__panel">${full ? '' : '<div class="sheet__grab" aria-hidden="true"></div>'}${close ? `<button class="sheet__close" type="button" data-close aria-label="${esc(t('ui.close'))}">${icon('x')}</button>` : ''}<div class="sheet__scroll">${html}</div></div>`;
    els.sheets.appendChild(el);
    const entry = { el, kind, onClose, full, prevFocus: document.activeElement, closing: false };
    stack.push(entry);
    lockScroll();
    try { history.pushState({ sheet: stack.length }, ''); entry.pushed = true; } catch (e) { entry.pushed = false; }
    markLoaded(el);
    bindDrag(entry);
    el.addEventListener('keydown', e => trapFocus(e, el));
    // two frames so the closed state paints before the transition starts
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-open')));
    if (onOpen) onOpen(el, entry);
    else {
      const f = $('.sheet__close', el) || el;
      f.focus({ preventScroll: true });
    }
    return entry;
  }

  function closeSheet(entry = stack[stack.length - 1], fromPop = false) {
    if (!entry || entry.closing) return;
    if (!fromPop && entry.pushed && history.state && history.state.sheet === stack.indexOf(entry) + 1) {
      entry.closing = true;
      history.back();       // popstate finishes the job, so the back gesture and the X behave the same
      return;
    }
    const i = stack.indexOf(entry);
    if (i < 0) return;
    stack.splice(i, 1);
    entry.closing = true;
    entry.el.classList.remove('is-open');
    if (entry.onClose) entry.onClose();
    setTimeout(() => entry.el.remove(), 520);
    if (!stack.length) unlockScroll();
    if (entry.prevFocus && entry.prevFocus.focus && document.contains(entry.prevFocus)) entry.prevFocus.focus({ preventScroll: true });
  }

  window.addEventListener('popstate', e => {
    const depth = (e.state && e.state.sheet) || 0;
    while (stack.length > depth) {
      const top = stack[stack.length - 1];
      top.closing = false;
      closeSheet(top, true);
    }
  });

  // resolves once the history entries of the closed sheets are gone, so the caller can touch the URL safely
  function closeAllSheets() {
    return new Promise(resolve => {
      if (!stack.length) { resolve(); return; }
      const n = stack.filter(s => s.pushed).length;
      stack.slice().reverse().forEach(s => { s.closing = false; closeSheet(s, true); });
      if (!n) { resolve(); return; }
      let timer = 0;
      const done = () => { clearTimeout(timer); window.removeEventListener('popstate', done); resolve(); };
      window.addEventListener('popstate', done);
      timer = setTimeout(done, 500);
      try { history.go(-n); } catch (e) { done(); }
    });
  }

  function trapFocus(e, el) {
    if (e.key !== 'Tab') return;
    const f = $$('button, [href], input, [tabindex]:not([tabindex="-1"])', el).filter(x => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // swipe a bottom sheet down to dismiss it (phones only)
  function bindDrag(entry) {
    if (entry.full) return;
    const panel = $('.sheet__panel', entry.el);
    const sc = $('.sheet__scroll', entry.el);
    let y0 = null, x0 = 0, dy = 0, t0 = 0, dragging = false;
    panel.addEventListener('touchstart', e => {
      if (wide.matches || e.touches.length > 1) { y0 = null; return; }
      if (sc.scrollTop > 2 && !e.target.closest('.sheet__grab')) { y0 = null; return; }
      y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; t0 = Date.now(); dragging = false;
    }, { passive: true });
    panel.addEventListener('touchmove', e => {
      if (y0 == null) return;
      const d = e.touches[0].clientY - y0, dx = Math.abs(e.touches[0].clientX - x0);
      if (!dragging) {
        if (d > 8 && d > dx) { dragging = true; entry.el.classList.add('is-dragging'); }
        else if (d < -4 || dx > 10) { y0 = null; return; }
        else return;
      }
      dy = Math.max(0, d - 8);
      panel.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    }, { passive: false });
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      if (!dragging) return;
      dragging = false;
      entry.el.classList.remove('is-dragging');
      const v = dy / Math.max(1, Date.now() - t0);
      if (dy > 110 || v > 0.55) { panel.style.transform = 'translateY(100%)'; closeSheet(entry); }
      else panel.style.transform = '';
    };
    panel.addEventListener('touchend', end);
    panel.addEventListener('touchcancel', end);
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && stack.length) { e.preventDefault(); closeSheet(); return; }
    if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) && !stack.length &&
        !/input|textarea/i.test((document.activeElement || {}).tagName || '')) {
      e.preventDefault(); openSearch();
    }
  });

  /* --------------------------------------------------------- item detail */

  function qtyControl(n, small = false) {
    const q = qtyOf(n);
    if (!q) {
      return small
        ? `<button class="add has-qty" style="position:static;box-shadow:none" type="button" data-inc="${n}" aria-label="${esc(t('item.add'))}">${icon('plus')}</button>`
        : `<button class="btn btn--primary" type="button" data-inc="${n}">${icon('plus')}<span>${esc(t('item.add'))}</span></button>`;
    }
    return `<div class="stepper${small ? ' stepper--sm' : ' is-accent'}"><button type="button" data-dec="${n}" aria-label="−">${icon('minus')}</button><output aria-live="polite">${q}</output><button type="button" data-inc="${n}" aria-label="+">${icon('plus')}</button></div>`;
  }

  function detailHTML(it) {
    const c = catById.get(it.cat);
    const name = nameOf(it), desc = descOf(it);
    const trName = lang !== 'tr' && it.name.tr !== name ? it.name.tr : '';
    const crumb = `${t('menuGroups.' + c.group)} · ${c.name[lang]}${it.variants ? '' : ` · ${t('item.no')} ${it.n}`}`;
    const algs = it.alg || [];
    const served = isServed(c);
    const media = it.img
      ? `<figure class="detail__media" style="--c:${it.c};margin:0"><img src="${photo(it.img)}" alt="${esc(name)}" width="700" height="466" decoding="async"></figure>`
      : '';
    const variants = it.variants
      ? `<div class="detail__block"><h3>${esc(t('item.size'))}</h3><div class="variants">${it.variants.map(v =>
          `<div class="variant"><div><p class="variant__label">${esc(v.label)}</p><p class="variant__no">${esc(t('item.no'))} ${v.n}</p></div><span class="price">${priceHTML(v.price)}</span><span data-slot="${v.n}" data-small>${qtyControl(v.n, true)}</span></div>`
        ).join('')}</div></div>`
      : '';
    return `${media}<div class="detail__main"><div class="detail__body">
<div class="detail__top"><p class="detail__crumb">${esc(crumb)}</p><button class="icon-pill" type="button" data-share="${it.n}" aria-label="${esc(t('ui.share'))}" title="${esc(t('ui.share'))}">${icon('share')}</button></div>
<h2 class="detail__name">${esc(name)}</h2>
${trName ? `<p class="detail__tr">${esc(t('item.trName'))}: <b>${esc(trName)}</b></p>` : ''}
${desc ? `<p class="detail__desc">${esc(desc)}</p>` : ''}
${c.hours ? `<div class="cat__service" style="margin-top:16px"><span class="pill">${icon('clock')}${esc(t('menu.serviceBetween', { start: c.hours[0], end: c.hours[1] }))}</span>${served ? '' : `<span class="pill pill--warn">${esc(t('menu.closedNow'))}</span>`}</div>` : ''}
${it.siyez ? `<div class="detail__block"><div class="detail__siyez">${icon('wheat')}<div><b>${esc(t('menu.siyezBadge'))}</b><p>${esc(t('home.siyezBody1'))}</p></div></div></div>` : ''}
${variants}
<div class="detail__block"><h3>${esc(t('allergens.label'))}</h3>${algs.length
      ? `<ul class="algs">${algs.map(a => `<li class="alg">${esc(algName(a))}</li>`).join('')}</ul>`
      : `<p class="muted">${esc(t('item.noAlg'))}</p>`}</div>
</div>${it.variants ? '' : `<div class="detail__bar"><span class="price">${priceHTML(it.price)}</span><span data-slot="${it.n}">${qtyControl(it.n)}</span></div>`}</div>`;
  }

  function openItem(n) {
    const it = cardByN.get(n);
    if (!it) return;
    openSheet({
      kind: 'detail', cls: `detail-sheet${it.img ? '' : ' detail--noimg'}`, label: nameOf(it),
      html: detailHTML(it)
    });
  }

  async function shareItem(n) {
    const it = cardByN.get(n);
    if (!it) return;
    const url = new URL(location.href);
    url.hash = 'i' + it.n;
    url.searchParams.set('lang', lang);
    url.searchParams.delete('table'); url.searchParams.delete('masa');
    const data = { title: `${nameOf(it)} · Mezza Gurme`, url: url.toString() };
    if (navigator.share) { try { await navigator.share(data); } catch (e) { /* cancelled */ } return; }
    try { await navigator.clipboard.writeText(data.url); toast(t('toast.copied'), 'check'); } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------- search */

  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i').replace(/ł/g, 'l').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const foldIndex = M.items.map(it => ({
    names: fold(LANGS.map(l => it.name[l]).join(' ')),
    byLang: Object.fromEntries(LANGS.map(l => [l, fold(it.name[l])])),
    desc: Object.fromEntries(LANGS.map(l => [l, fold(it.desc && it.desc[l])]))
  }));

  const search = { q: '', group: null, siyez: false, without: new Set() };
  const ALG_FILTERS = { Gluten: ['Gluten'], Süt: ['Süt'], Yumurta: ['Yumurta'], nuts: ['Çerez', 'Ceviz'], sea: ['Balık', 'Kabuklu'], Susam: ['Susam'] };

  function runSearch() {
    const tokens = fold(search.q).split(' ').filter(Boolean);
    const out = [];
    M.items.forEach((it, i) => {
      if (search.group && catById.get(it.cat).group !== search.group) return;
      if (search.siyez && !it.siyez) return;
      for (const f of search.without) if ((it.alg || []).some(a => ALG_FILTERS[f].includes(a))) return;
      let score = 0;
      if (tokens.length) {
        const own = foldIndex[i].byLang[lang], all = foldIndex[i].names;
        const desc = foldIndex[i].desc[lang] + ' ' + fold(catById.get(it.cat).name[lang]);
        for (const tk of tokens) {
          if (own.startsWith(tk) || own.includes(' ' + tk)) score += 6;
          else if (own.includes(tk)) score += 4;
          else if (all.includes(tk)) score += 3;
          else if (desc.includes(tk)) score += 1;
          else return;
        }
      }
      out.push({ it, score });
    });
    out.sort((a, b) => b.score - a.score || a.it.i - b.it.i);
    return out;
  }

  function searchFiltersHTML() {
    const chip = (attr, pressed, label, ic) =>
      `<button class="fchip" type="button" ${attr} aria-pressed="${pressed}">${ic ? icon(ic) : ''}${esc(label)}</button>`;
    const alg = M.allergenFilters
      ? Object.keys(ALG_FILTERS).map(k => chip(`data-falg="${k}"`, search.without.has(k), t('filter.' + k))).join('')
      : '';
    return chip('data-fsiyez', search.siyez, t('filter.siyez'), 'wheat') + alg +
      groups.map(g => chip(`data-fgroup="${g.id}"`, search.group === g.id, t('menuGroups.' + g.id))).join('');
  }

  function tilesHTML() {
    return groups.map(g => `<div class="tiles-group"><h3>${esc(t('menuGroups.' + g.id))}</h3><div class="tiles">${g.cats.map(c =>
      `<button class="tile" type="button" data-jump="${c.id}" style="--c:${(M.items.find(i => i.img === c.cover) || {}).c || ''}">${c.cover ? `<img src="${thumb(c.cover)}" alt="" loading="lazy" decoding="async" width="480" height="320">` : ''}<span class="tile__body"><span class="tile__name">${esc(c.name[lang])}</span><span class="tile__count">${esc(plural('count.items', c.count))}</span></span>${c.hours ? `<span class="chip__dot" data-closed="${c.id}"${isServed(c) ? ' hidden' : ''}></span>` : ''}</button>`
    ).join('')}</div></div>`).join('');
  }

  function renderSearch(el) {
    const box = $('#sres', el);
    const filtersOn = search.group || search.siyez || search.without.size;
    $('[data-qclear]', el).hidden = !search.q;
    $('.filters', el).innerHTML = searchFiltersHTML();
    if (!search.q.trim() && !filtersOn) {
      box.innerHTML = `<div class="suggest"><h3>${esc(t('search.suggest'))}</h3><div class="suggest__words">${t('search.words').map(w =>
        `<button type="button" data-word="${esc(w)}">${esc(w)}</button>`).join('')}</div></div>
<div class="suggest"><h3>${esc(t('ui.allCats'))}</h3>${tilesHTML()}</div>`;
      markLoaded(box);
      return;
    }
    const res = runSearch();
    if (!res.length) {
      box.innerHTML = `<div class="empty">${icon('search')}<h3>${esc(t('search.empty'))}</h3><p>${esc(t('search.emptyHint'))}</p></div>`;
      return;
    }
    const byCat = new Map();
    res.forEach(r => { if (!byCat.has(r.it.cat)) byCat.set(r.it.cat, []); byCat.get(r.it.cat).push(r.it); });
    box.innerHTML = `<p class="search-meta"><span>${esc(plural('search.results', res.length))}</span></p>` +
      (search.without.size ? `<p class="note">${icon('info')}<span>${esc(t('filter.note'))}</span></p>` : '') +
      Array.from(byCat, ([cid, its]) => `<section class="search-group"><h3>${esc(catById.get(cid).name[lang])}</h3><div class="cards">${its.map(cardHTML).join('')}</div></section>`).join('');
    markLoaded(box);
  }

  function openSearch(word) {
    if (word != null) search.q = word;
    const entry = openSheet({
      kind: 'search', close: false, label: t('ui.search'),
      html: `<div class="search-head"><div class="search-row"><label class="search-field">${icon('search')}<input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${esc(t('search.placeholder'))}" value="${esc(search.q)}" aria-label="${esc(t('search.placeholder'))}"><button class="search-clear" type="button" data-qclear aria-label="${esc(t('ui.close'))}">${icon('x')}</button></label><button class="search-cancel" type="button" data-close>${esc(t('search.cancel'))}</button></div><div class="filters"></div></div><div class="search-body" id="sres"></div>`,
      onOpen(el) {
        const input = $('#q', el);
        renderSearch(el);
        input.focus({ preventScroll: true });
        let deb = 0;
        input.addEventListener('input', () => {
          search.q = input.value;
          clearTimeout(deb);
          deb = setTimeout(() => renderSearch(el), 70);
        });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
        $('.sheet__scroll', el).addEventListener('scroll', () => { if (document.activeElement === input) input.blur(); }, { passive: true });
      }
    });
    return entry;
  }

  /* ------------------------------------------------- language & categories */

  function openLang() {
    openSheet({
      kind: 'lang', label: t('ui.lang'),
      html: `<div class="sheet__head"><h2 class="sheet__title">${esc(t('ui.lang'))}</h2></div><div class="sheet__content"><div class="langs" role="radiogroup">${LANGS.map(l =>
        `<button class="lang-opt" type="button" role="radio" aria-checked="${l === lang}" data-lang="${l}" lang="${l}"><span class="flag"><svg><use href="#flag-${l}"/></svg></span>${esc(I18N[l].native)}<small>${l.toUpperCase()}</small></button>`
      ).join('')}</div></div>`,
      onOpen(el) { const cur = $(`[data-lang="${lang}"]`, el); if (cur) cur.focus({ preventScroll: true }); }
    });
  }

  function setLang(l) {
    if (!LANGS.includes(l)) return;
    const anchor = activeCat;
    const closed = closeAllSheets();
    if (l === lang) return;
    lang = l;
    store.set('lang', l);
    renderAll();
    if (anchor) requestAnimationFrame(() => scrollToCat(anchor, false));
    closed.then(() => {
      try {
        const url = new URL(location.href);
        url.searchParams.set('lang', l);
        history.replaceState(history.state, '', url);
      } catch (e) { /* ignore */ }
    });
  }

  function openCats() {
    openSheet({
      kind: 'cats', label: t('ui.allCats'),
      html: `<div class="sheet__head"><h2 class="sheet__title">${esc(t('ui.allCats'))}</h2><p class="sheet__sub">${esc(plural('count.cats', M.cats.length))} · ${esc(plural('count.items', totalPositions))}</p></div><div class="sheet__content">${tilesHTML()}</div>`
    });
  }

  /* ----------------------------------------------------- order UI & sheet */

  function refreshOrderBar(bump) {
    const count = orderCount();
    $('#orderCount').textContent = count;
    $('#orderTotal').innerHTML = priceHTML(orderTotal());
    els.orderbar.classList.toggle('is-visible', count > 0);
    els.orderbar.setAttribute('aria-hidden', String(!count));
    els.orderbar.tabIndex = count ? 0 : -1;
    document.body.classList.toggle('has-order', count > 0);
    if (bump && count) { els.orderbar.classList.remove('bump'); void els.orderbar.offsetWidth; els.orderbar.classList.add('bump'); }
  }

  function refreshQty(n, bump) {
    const { it } = unitByN.get(n);
    const q = qtyOfCard(it);
    $$(`[data-add="${it.n}"]`).forEach(b => {
      b.classList.toggle('has-qty', q > 0);
      b.innerHTML = q ? String(q) : icon('plus');
      if (bump) { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
    });
    $$(`[data-slot="${n}"]`).forEach(s => { s.innerHTML = qtyControl(n, s.hasAttribute('data-small')); });
    refreshOrderBar(bump);
    stack.forEach(s => { if (s.kind === 'order') renderOrder(s.el); });
  }

  function orderHTML() {
    const lines = orderLines();
    if (!lines.length) {
      return `<div class="sheet__head"><h2 class="sheet__title">${esc(t('order.title'))}</h2></div><div class="sheet__content"><div class="empty">${icon('receipt')}<h3>${esc(t('order.empty'))}</h3><p>${esc(t('order.emptyHint'))}</p></div></div>`;
    }
    return `<div class="sheet__head"><h2 class="sheet__title">${esc(t('order.title'))}</h2><p class="sheet__sub">${esc(plural('order.positions', orderCount()))}${table ? ' · ' + esc(t('table', { n: table })) : ''}</p></div>
<div class="sheet__content"><ul class="olist">${lines.map(l => `<li class="oline">
<div class="oline__img" style="--c:${l.it.c || ''}">${l.it.img ? `<img src="${thumb(l.it.img)}" alt="" width="480" height="320" decoding="async">` : ''}</div>
<div><p class="oline__name">${esc(nameOf(l.it))}</p><p class="oline__meta">${l.v ? esc(l.v.label) + ' · ' : ''}${esc(t('item.no'))} ${l.n} · <b>${esc(priceText(l.price * l.q))}</b></p></div>
<span data-slot="${l.n}" data-small>${qtyControl(l.n, true)}</span></li>`).join('')}</ul>
<div class="ototal"><span>${esc(t('order.total'))}</span><span class="price">${priceHTML(orderTotal())}</span></div>
<p class="note">${icon('info')}<span>${esc(t('order.note'))}</span></p>
<div class="oactions"><button class="btn btn--primary btn--block" type="button" data-waiter>${icon('cloche')}<span>${esc(t('order.waiter'))}</span></button>
<a class="btn btn--ghost btn--block" href="${esc(waOrderLink())}" target="_blank" rel="noopener">${icon('wa')}<span>${esc(t('order.whatsapp'))}</span></a>
<button class="btn btn--danger" type="button" data-clear>${icon('trash')}<span>${esc(t('order.clear'))}</span></button></div></div>`;
  }

  function renderOrder(el) {
    const sc = $('.sheet__scroll', el);
    const top = sc.scrollTop;
    sc.innerHTML = orderHTML();
    sc.scrollTop = top;
    markLoaded(sc);
  }

  function openOrder() { openSheet({ kind: 'order', label: t('order.title'), html: orderHTML() }); }

  function waOrderLink() {
    const lines = orderLines();
    const msg = [t('whatsapp.orderMessage'), '']
      .concat(lines.map(l => `${l.q} × ${l.it.name.tr}${l.v ? ' ' + l.v.label : ''} (No ${l.n}) — ${priceTR(l.price * l.q)}`))
      .concat(['', `Toplam: ${priceTR(orderTotal())}`]);
    if (table) msg.push(`Masa: ${table}`);
    return `https://wa.me/${M.contact.whatsapp}?text=${encodeURIComponent(msg.join('\n'))}`;
  }

  function openWaiter() {
    const lines = orderLines();
    openSheet({
      kind: 'waiter', label: 'Sipariş',
      html: `<div class="waiter" lang="tr"><span class="waiter__hint" lang="${lang}">${icon('info')}${esc(t('waiter.hint'))}</span>
<div class="waiter__brand"><h2>Mezza · Sipariş</h2>${table ? `<span class="waiter__table">Masa ${esc(table)}</span>` : ''}</div>
${lines.map(l => `<div class="wline"><span class="wline__qty">${l.q}×</span><div><p class="wline__name">${esc(l.it.name.tr)}${l.v ? ' · ' + esc(l.v.label) : ''}</p><p class="wline__sub">No ${l.n}${lang !== 'tr' ? ' · ' + esc(nameOf(l.it)) : ''}</p></div><span class="wline__price">${esc(priceTR(l.price * l.q))}</span></div>`).join('')}
<div class="wtotal"><span>Toplam</span><b>${esc(priceTR(orderTotal()))}</b></div></div>`
    });
  }

  /* -------------------------------------------------------------- events */

  document.addEventListener('click', e => {
    const tgt = e.target.closest('[data-close],[data-open],[data-add],[data-inc],[data-dec],[data-go],[data-jump],[data-lang],[data-word],[data-fgroup],[data-fsiyez],[data-falg],[data-qclear],[data-share],[data-waiter],[data-clear]');
    if (!tgt) return;
    const d = tgt.dataset;

    if ('close' in d) { const entry = stack.find(s => s.el.contains(tgt)); closeSheet(entry); return; }
    if (d.open) { openItem(+d.open); return; }
    if (d.add) {
      const it = cardByN.get(+d.add);
      if (it && it.variants) openItem(it.n); else changeQty(+d.add, 1, true);
      return;
    }
    if (d.inc) { changeQty(+d.inc, 1); return; }
    if (d.dec) { changeQty(+d.dec, -1); return; }
    if (d.go) { e.preventDefault(); scrollToCat(d.go); return; }
    if (d.jump) {
      const id = d.jump;
      closeAllSheets().then(() => scrollToCat(id));
      return;
    }
    if (d.lang) { setLang(d.lang); return; }
    if ('share' in d) { shareItem(+d.share); return; }
    if ('waiter' in d) { openWaiter(); return; }
    if ('clear' in d) {
      order = {}; saveOrder();
      M.items.forEach(it => $$(`[data-add="${it.n}"].has-qty`).forEach(b => { b.classList.remove('has-qty'); b.innerHTML = icon('plus'); }));
      refreshOrderBar(false);
      closeSheet(stack.find(s => s.kind === 'order'));
      return;
    }
    const sheetEl = tgt.closest('.sheet');
    if (sheetEl && (d.word != null || d.fgroup || d.falg || 'fsiyez' in d || 'qclear' in d)) {
      const input = $('#q', sheetEl);
      if (d.word != null) { search.q = d.word; input.value = d.word; }
      if (d.fgroup) search.group = search.group === d.fgroup ? null : d.fgroup;
      if ('fsiyez' in d) search.siyez = !search.siyez;
      if (d.falg) { if (search.without.has(d.falg)) search.without.delete(d.falg); else search.without.add(d.falg); }
      if ('qclear' in d) { search.q = ''; input.value = ''; input.focus(); }
      renderSearch(sheetEl);
    }
  });

  $('#btnSearch').addEventListener('click', () => openSearch());
  $('#heroSearch').addEventListener('click', () => openSearch());
  $('#btnLang').addEventListener('click', openLang);
  $('#btnCats').addEventListener('click', openCats);
  $('#orderbar').addEventListener('click', openOrder);
  $('#viewList').addEventListener('click', () => setView('list'));
  $('#viewGrid').addEventListener('click', () => setView('grid'));
  const railStep = dir => els.rail.scrollBy({ left: dir * Math.max(280, els.rail.clientWidth * 0.7), behavior: reduceMotion ? 'auto' : 'smooth' });
  const railState = () => {
    $('#railPrev').disabled = els.rail.scrollLeft < 8;
    $('#railNext').disabled = els.rail.scrollLeft + els.rail.clientWidth > els.rail.scrollWidth - 8;
  };
  $('#railPrev').addEventListener('click', () => railStep(-1));
  $('#railNext').addEventListener('click', () => railStep(1));
  els.rail.addEventListener('scroll', railState, { passive: true });
  window.addEventListener('resize', railState, { passive: true });
  railState();
  els.toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }));
  $('#brandLink').addEventListener('click', e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }); });
  window.addEventListener('offline', () => toast(t('toast.offline'), 'info'));

  /* ---------------------------------------------------------------- boot */

  renderAll();
  onScroll();
  // set late on purpose: before the menu is rendered this image sits near the top and would load eagerly
  $$('img[data-src]').forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
  setInterval(updateService, 60 * 1000);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => spy());

  // deep links: #i32 opens a dish, #c-pizzalar jumps to a category
  (function deepLink() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (!h) return;
    history.replaceState(null, '', location.pathname + location.search);
    const mi = /^i(\d+)$/.exec(h);
    if (mi && cardByN.has(+mi[1])) {
      const it = cardByN.get(+mi[1]);
      scrollToCat(it.cat, false);
      openItem(+mi[1]);
    } else if (/^c-/.test(h) && catById.has(h.slice(2))) {
      requestAnimationFrame(() => scrollToCat(h.slice(2), false));
    }
  })();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
