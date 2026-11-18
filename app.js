/* Cash Flow — app logic. All data lives in this browser's localStorage, stored separately for each signed-in Google account. */
(function () {
  const APP_VERSION = '3.8.0'; // keep in step with VERSION in sw.js
  const KEY = 'cashflow.v2', OLD_KEY = 'cashflow.v1', THEME_KEY = 'cashflow.theme';
  const ACCOUNTS_KEY = 'cashflow.accounts', CURRENT_KEY = 'cashflow.user', OLD_DRIVE_KEY = 'cashflow.drive';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PAGE = 100;
  const $ = id => document.getElementById(id);
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ================= storage ================= */
  function fresh() {
    const me = { id: uid('p'), name: 'Me' };
    return { version: 2, profiles: [me], accounts: [], statements: [], txns: [], categories: clone(FT.DEFAULT_CATEGORIES), rules: {} };
  }
  function migrateV1(old) {
    const d = fresh();
    if (!old.txns || !old.txns.length) return d;
    const acct = { id: uid('a'), profileId: d.profiles[0].id, name: 'My account', bank: '', last4: '' };
    d.accounts.push(acct);
    d.rules = old.rules || {};
    d.statements = (old.sources || []).map(s => ({ id: s.id, accountId: acct.id, fileName: s.name, added: s.added, count: s.count, from: s.from, to: s.to, check: null }));
    d.txns = old.txns.map(t => Object.assign({}, t, { accountId: acct.id, id: acct.id + '|' + t.id }));
    return d;
  }
  const readJSON = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const writeJSON = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  /* Who is signed in, and where their data lives on this device. Google Drive holds the main copy (see "sync").
     - "Remember this device" on: localStorage, so it survives closing the browser and works offline.
     - off (shared computer): sessionStorage, which the browser wipes when the tab closes.
     Each Google account (by its permanent ID, "sub") has its own keys, so people sharing a device stay separate. */
  const SESSION_USER = 'cashflow.sessionUser';
  const signInRequired = () => !!(window.CFDrive && CFDrive.configured());
  const knownAccounts = () => readJSON(ACCOUNTS_KEY) || {};            // remembered accounts only
  const readS = k => { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } };
  const writeS = (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } };
  let user = null;
  if (signInRequired()) {
    user = readS(SESSION_USER);
    if (!user) { const cur = readJSON(CURRENT_KEY); user = (cur && knownAccounts()[cur]) || null; }
  }
  const area = (u = user) => (u && !u.remember ? sessionStorage : localStorage);
  const dataKey = (u = user) => u ? `${KEY}.${u.sub}` : KEY;
  const metaKey = (u = user) => `cashflow.sync.${u.sub}`;
  const readArea = (u, k) => { try { return JSON.parse(area(u).getItem(k)); } catch (e) { return null; } };
  const writeArea = (u, k, v) => { try { v == null ? area(u).removeItem(k) : area(u).setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const gated = () => signInRequired() && !user;
  /** Data saved on this device before sign-in existed (or when sign-in isn't set up). */
  function legacyData() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (d && d.version === 2) return d;
      const old = JSON.parse(localStorage.getItem(OLD_KEY));
      if (old && Array.isArray(old.txns)) return migrateV1(old);
    } catch (e) { /* storage blocked or corrupt */ }
    return null;
  }
  function load() {
    if (!user) return legacyData() || fresh();
    const d = readArea(user, dataKey());
    return d && d.version === 2 ? d : fresh();
  }
  /** Save on this device, then (when signed in) mark it for syncing to Google Drive. */
  function save(opts) {
    if (gated()) return; // nobody signed in yet: nothing to save
    try { area().setItem(dataKey(), JSON.stringify(db)); }
    catch (e) { toast('Could not save. Browser storage may be full or blocked.'); }
    if (user && !(opts && opts.noSync)) markDirty();
  }

  let db = load();
  let compiled = FT.compileCategories(db.categories);
  const recompile = () => (compiled = FT.compileCategories(db.categories));

  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const shiftDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const shiftMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5) + 1;

  let view = {
    page: 'dash', profile: db.profiles[0].id, acct: 'all',
    mode: 'ym', year: 'all', month: 'all', from: shiftDays(today(), -89), to: today(),
    cat: '', type: '', q: '', limit: PAGE,
  };
  let chart;

  /* ================= helpers ================= */
  const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
  const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
  const fmt = n => inr0.format(Math.round(n));
  function compact(n) {
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e7) return s + '₹' + (a / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr';
    if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(1).replace(/\.0$/, '') + 'L';
    if (a >= 1e3) return s + '₹' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return s + '₹' + Math.round(a);
  }
  const fmtDate = d => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${+dd} ${MONTHS[+m - 1]} ${y}`; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const counted = t => t.category !== FT.EXCLUDED;
  const profileOf = id => db.profiles.find(p => p.id === id);
  const accountOf = id => db.accounts.find(a => a.id === id);
  const acctLabel = a => a ? a.name + (a.last4 ? ` ••${a.last4}` : '') : 'Unknown account';

  let toastT;
  /** Material snackbar. action: {label, fn} adds a button. */
  function toast(msg, ms = 4500, action) {
    const t = $('toast'), a = $('toastAct');
    $('toastMsg').textContent = msg;
    a.hidden = !action;
    if (action) { a.textContent = action.label; a.onclick = () => { t.hidden = true; action.fn(); }; }
    t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
  }
  const ICONS = {
    'Salary': 'payments', 'Interest & Dividends': 'percent', 'Refunds & Cashback': 'replay', 'Other Income': 'savings',
    'Investments': 'trending_up', 'Insurance': 'health_and_safety', 'Food & Dining': 'restaurant', 'Groceries': 'local_grocery_store',
    'Shopping': 'shopping_bag', 'Transport & Fuel': 'directions_car', 'Bills & Utilities': 'receipt', 'Rent': 'home',
    'Credit Card Bills': 'credit_card', 'EMI & Loans': 'account_balance', 'Health': 'medical_services', 'Entertainment': 'movie',
    'Education': 'school', 'Cash Withdrawal': 'atm', 'Charges & Fees': 'request_quote', 'UPI / Others': 'qr_code_2', 'Self Transfer': 'sync_alt',
  };
  const catIcon = c => `<span class="ms" aria-hidden="true">${ICONS[c] || 'label'}</span>`;
  function openDlg(id) { const d = $(id); if (!d.open) d.showModal(); }
  document.addEventListener('click', e => { const c = e.target.closest('[data-close]'); if (c) c.closest('dialog').close(); });

  /* ================= theme ================= */
  function getTheme() { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { return 'system'; } }
  function isDark() { const t = getTheme(); return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); }
  function applyTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
    if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    $('themeBtn').innerHTML = `<span class="ms">${isDark() ? 'light_mode' : 'dark_mode'}</span>`;
    syncThemeRadios();
    const meta = document.querySelectorAll('meta[name=theme-color]');
    if (t !== 'system') meta.forEach(m => { m.content = t === 'dark' ? '#111318' : '#F9F9FF'; });
    else { meta[0].content = '#F9F9FF'; meta[1].content = '#111318'; }
    if (view.page !== 'settings') renderDash();
  }
  $('themeBtn').onclick = () => applyTheme(isDark() ? 'light' : 'dark');
  function syncThemeRadios() {
    const t = getTheme();
    document.querySelectorAll('input[name=theme]').forEach(r => { r.checked = r.value === t; r.parentElement.classList.toggle('on', r.checked); });
  }
  document.querySelectorAll('input[name=theme]').forEach(r => (r.onchange = () => applyTheme(r.value)));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getTheme()));

  /* ================= scope (person / account / period) ================= */
  const accountsInScope = () => db.accounts.filter(a => view.profile === 'all' || a.profileId === view.profile);
  function scopeTxns() {
    const ids = new Set(accountsInScope().filter(a => view.acct === 'all' || a.id === view.acct).map(a => a.id));
    return db.txns.filter(t => ids.has(t.accountId));
  }
  function fy(offset) {
    const t = today(), y = +t.slice(0, 4) - (+t.slice(5, 7) < 4 ? 1 : 0) + offset;
    return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${y}-${String(y + 1).slice(2)}` };
  }
  /** Current period as {kind, from, to, label}; kind: allyears | year | month | range */
  function period() {
    const t = today();
    switch (view.mode) {
      case '30d': return { kind: 'range', from: shiftDays(t, -29), to: t, label: 'Last 30 days' };
      case '3m': return { kind: 'range', from: shiftDays(shiftMonths(t, -3), 1), to: t, label: 'Last 3 months' };
      case '6m': return { kind: 'range', from: shiftDays(shiftMonths(t, -6), 1), to: t, label: 'Last 6 months' };
      case 'fy': return Object.assign({ kind: 'range' }, fy(0));
      case 'lfy': return Object.assign({ kind: 'range' }, fy(-1));
      case 'custom': {
        let a = view.from || t, b = view.to || t; if (a > b) [a, b] = [b, a];
        return { kind: 'range', from: a, to: b, label: `${fmtDate(a)} – ${fmtDate(b)}` };
      }
    }
    if (view.year === 'all') return { kind: 'allyears', from: '0000', to: '9999', label: 'All time' };
    if (view.month === 'all') return { kind: 'year', from: `${view.year}-01-01`, to: `${view.year}-12-31`, label: view.year };
    const m = String(view.month).padStart(2, '0'), last = new Date(+view.year, +view.month, 0).getDate();
    return { kind: 'month', from: `${view.year}-${m}-01`, to: `${view.year}-${m}-${last}`, label: `${MONTHS[view.month - 1]} ${view.year}` };
  }
  function previousPeriod(p) {
    if (p.kind === 'allyears') return null;
    if (p.kind === 'year') { const y = +view.year - 1; return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) }; }
    if (p.kind === 'month') {
      let y = +view.year, m = +view.month - 1; if (!m) { m = 12; y--; }
      const mm = String(m).padStart(2, '0');
      return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${new Date(y, m, 0).getDate()}`, label: `${MONTHS[m - 1]} ${y}` };
    }
    const n = daysBetween(p.from, p.to);
    return { from: shiftDays(p.from, -n), to: shiftDays(p.from, -1), label: 'previous ' + n + ' days' };
  }
  const within = (t, p) => t.date >= p.from && t.date <= p.to;
  function totals(list) {
    let inc = 0, exp = 0;
    for (const t of list) if (counted(t)) t.type === 'credit' ? (inc += t.amount) : (exp += t.amount);
    return { inc, exp, net: inc - exp };
  }

  /* ================= header / navigation ================= */
  function renderHeader() {
    const sel = $('profileSel');
    sel.innerHTML = db.profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') +
      (db.profiles.length > 1 ? `<option value="all">Everyone</option>` : '');
    if (view.profile !== 'all' && !profileOf(view.profile)) view.profile = db.profiles[0].id;
    if (view.profile === 'all' && db.profiles.length < 2) view.profile = db.profiles[0].id;
    sel.value = view.profile;
    document.querySelectorAll('.nav-item').forEach(b => {
      const on = b.dataset.page === view.page;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('pageTitle').textContent = { dash: 'Dashboard', tx: 'Transactions', settings: 'Settings', insights: 'Insights' }[view.page];
    document.title = view.page === 'dash' ? 'Cash Flow – Smart Finance Manager' : `${$('pageTitle').textContent} · Cash Flow`;
    $('dash').hidden = view.page !== 'dash';
    $('txPage').hidden = view.page !== 'tx';
    $('settings').hidden = view.page !== 'settings';
    $('insightsPage').hidden = view.page !== 'insights';
    if (view.page === 'settings' || view.page === 'insights') $('filtersWrap').hidden = true;
    $('uploadFab').classList.toggle('hide', view.page === 'settings' || view.page === 'insights');
  }
  function goPage(p) { view.page = p; renderAll(); window.scrollTo(0, 0); if (p !== 'insights') CFStats.page({ dash: 'dashboard', tx: 'transactions', settings: 'settings' }[p] || p); }
  document.querySelectorAll('.nav-item').forEach(b => (b.onclick = () => goPage(b.dataset.page)));
  window.addEventListener('scroll', () => document.querySelector('.appbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  $('profileSel').onchange = e => { view.profile = e.target.value; view.acct = 'all'; view.cat = ''; initFilters(false); renderAll(); };

  function renderAll() {
    renderHeader(); renderAccount(); renderStatsRow();
    if (view.page === 'settings') renderSettings(); else if (view.page === 'insights') renderInsights(); else renderDash();
  }

  /* ================= dashboard ================= */
  function initFilters(keep) {
    const txns = scopeTxns();
    const years = [...new Set(txns.map(t => t.date.slice(0, 4)))].sort().reverse();
    if (!keep || (view.year !== 'all' && !years.includes(view.year))) { view.year = years[0] || 'all'; view.month = 'all'; }
    $('yearSel').innerHTML = `<option value="all">All years</option>` + years.map(y => `<option>${y}</option>`).join('');
    $('yearSel').value = view.year;
    renderMonthOptions();
    const accts = accountsInScope();
    if (view.acct !== 'all' && !accts.some(a => a.id === view.acct)) view.acct = 'all';
    $('acctSel').innerHTML = `<option value="all">All accounts</option>` + accts.map(a =>
      `<option value="${a.id}">${esc(acctLabel(a))}${view.profile === 'all' ? ' · ' + esc(profileOf(a.profileId)?.name) : ''}</option>`).join('');
    $('acctSel').value = view.acct;
    $('modeSel').value = view.mode; $('fromIn').value = view.from; $('toIn').value = view.to;
    const cats = db.categories.map(c => c.name);
    if (view.cat && !cats.includes(view.cat)) view.cat = '';
    $('catSel').innerHTML = `<option value="">All categories</option>` + cats.map(c => `<option>${esc(c)}</option>`).join('');
    $('catSel').value = view.cat;
  }
  function renderMonthOptions() {
    const sel = $('monthSel');
    if (view.year === 'all') { sel.innerHTML = '<option value="all">All months</option>'; sel.disabled = true; view.month = 'all'; return; }
    const have = new Set(scopeTxns().filter(t => t.date.startsWith(view.year)).map(t => +t.date.slice(5, 7)));
    sel.disabled = false;
    sel.innerHTML = '<option value="all">All months</option>' + MONTHS.map((m, i) => `<option value="${i + 1}" ${have.has(i + 1) ? '' : 'disabled'}>${m}</option>`).join('');
    sel.value = view.month;
  }

  function renderDash() {
    const scoped = scopeTxns();
    const hasData = scoped.length > 0;
    $('empty').hidden = hasData; $('dashBody').hidden = !hasData;
    $('filtersWrap').hidden = !hasData || view.page === 'settings';
    $('txEmpty').hidden = hasData; document.querySelector('.tx-card').hidden = !hasData;
    if (!hasData) { if (chart) { chart.destroy(); chart = null; } return; }
    const f = document.querySelector('.filters');
    f.classList.toggle('mode-ym', view.mode === 'ym'); f.classList.toggle('mode-custom', view.mode === 'custom');

    const p = period();
    const list = scoped.filter(t => within(t, p));
    const tot = totals(list);
    $('rangeLabel').textContent = `${p.kind === 'allyears' ? 'All time' : fmtDate(p.from) + ' – ' + fmtDate(p.to)} · ${list.length} transactions`;

    const pp = previousPeriod(p);
    const prevList = pp ? scoped.filter(t => within(t, pp)) : [];
    const pt = prevList.length ? totals(prevList) : null;
    const delta = (cur, old, goodWhenUp) => {
      if (!pt || !old) return '';
      const pct = ((cur - old) / Math.abs(old)) * 100, up = pct >= 0;
      return `<span class="${up === goodWhenUp ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(pct) > 999 ? '>999' : Math.abs(pct).toFixed(0)}%</span> vs ${esc(pp.label)}`;
    };
    $('kIncome').textContent = fmt(tot.inc);
    $('kExpense').textContent = fmt(tot.exp);
    $('kNet').textContent = fmt(tot.net);
    $('kNet').style.color = tot.net < 0 ? css('--bad') : '';
    const rate = tot.inc ? (tot.net / tot.inc) * 100 : null;
    $('kRate').textContent = rate == null ? '–' : rate.toFixed(0) + '%';
    $('kIncomeSub').innerHTML = delta(tot.inc, pt && pt.inc, true) || `${list.filter(t => t.type === 'credit' && counted(t)).length} credits`;
    $('kExpenseSub').innerHTML = delta(tot.exp, pt && pt.exp, false) || `${list.filter(t => t.type === 'debit' && counted(t)).length} debits`;
    $('kNetSub').textContent = tot.net >= 0 ? 'Saved this period' : 'You spent more than you earned';
    $('kRateSub').textContent = rate == null ? 'No income recorded' : 'of income kept';

    renderChart(list, p, scoped);
    renderCategoryBars(list);
    renderTransactions(list);
  }

  function renderChart(list, p, scoped) {
    let labels = [], keys = [], title, single = false, keyOf, titleOf;
    if (p.kind === 'allyears') {
      keys = [...new Set(scoped.map(t => t.date.slice(0, 4)))].sort(); labels = keys.slice();
      keyOf = t => t.date.slice(0, 4); titleOf = i => labels[i]; title = 'Income vs expenses by year';
    } else if (p.kind === 'year') {
      keys = MONTHS.map((_, i) => `${view.year}-${String(i + 1).padStart(2, '0')}`); labels = MONTHS.slice();
      keyOf = t => t.date.slice(0, 7); titleOf = i => `${MONTHS[i]} ${view.year}`; title = `Income vs expenses by month · ${view.year}`;
    } else if (p.kind === 'month' || daysBetween(p.from, p.to) <= 62) {
      for (let d = p.from; d <= p.to; d = shiftDays(d, 1)) keys.push(d);
      labels = keys.map(d => p.kind === 'month' ? String(+d.slice(8)) : `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`);
      keyOf = t => t.date; titleOf = i => fmtDate(keys[i]); single = true;
      title = `Daily spending · ${p.label}`;
    } else {
      for (let m = p.from.slice(0, 7); m <= p.to.slice(0, 7); m = shiftMonths(m + '-01', 1).slice(0, 7)) keys.push(m);
      labels = keys.map(m => `${MONTHS[+m.slice(5) - 1]} ${m.slice(2, 4)}`);
      keyOf = t => t.date.slice(0, 7); titleOf = i => `${MONTHS[+keys[i].slice(5) - 1]} ${keys[i].slice(0, 4)}`;
      title = `Income vs expenses by month · ${p.label}`;
    }
    const idx = new Map(keys.map((k, i) => [k, i]));
    const inc = keys.map(() => 0), exp = keys.map(() => 0);
    for (const t of list) {
      if (!counted(t)) continue;
      const i = idx.get(keyOf(t)); if (i == null) continue;
      (t.type === 'credit' ? inc : exp)[i] += t.amount;
    }
    $('chartTitle').textContent = title;
    $('chartLegend').innerHTML = single ? '' :
      `<span><i class="swatch" style="background:var(--income)"></i>Income</span><span><i class="swatch" style="background:var(--expense)"></i>Expenses</span>`;
    const bar = { borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 28, categoryPercentage: 0.7, barPercentage: 0.9 };
    const datasets = [];
    if (!single) datasets.push({ ...bar, label: 'Income', data: inc, backgroundColor: css('--income') });
    datasets.push({ ...bar, label: single ? 'Spent' : 'Expenses', data: exp, backgroundColor: css('--expense') });

    if (chart) chart.destroy();
    if (!window.Chart) return;
    chart = new Chart($('flowChart'), {
      type: 'bar', data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'), footerColor: css('--text'),
            borderColor: css('--grid'), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
            callbacks: {
              title: items => titleOf(items[0].dataIndex),
              label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y)}`,
              footer: items => single || items.length < 2 ? '' : `Net: ${fmt(items[0].parsed.y - items[1].parsed.y)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: css('--axis') }, ticks: { color: css('--muted'), autoSkip: true, maxRotation: 0 } },
          y: { beginAtZero: true, grid: { color: css('--grid') }, border: { display: false }, ticks: { color: css('--muted'), callback: v => compact(v), maxTicksLimit: 6 } },
        },
        onClick: (e, els) => {
          if (!els.length || single) return;
          const k = keys[els[0].index];
          view.mode = 'ym'; view.year = k.slice(0, 4); view.month = k.length > 4 ? String(+k.slice(5, 7)) : 'all';
          initFilters(true); renderDash();
        },
        onHover: (e, els) => { e.native.target.style.cursor = els.length && !single ? 'pointer' : 'default'; },
      },
    });
  }

  function groupBy(list, keyFn) {
    const m = new Map();
    for (const t of list) { const k = keyFn(t); m.set(k, (m.get(k) || 0) + t.amount); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }
  function barList(el, rows, total, color, clickable) {
    if (!rows.length) { el.innerHTML = '<div class="none">Nothing in this period.</div>'; return; }
    const max = rows[0][1];
    el.innerHTML = rows.map(([name, v]) => {
      const tag = clickable ? 'button' : 'div';
      return `<${tag} class="bar-row${clickable && view.cat === name ? ' active' : ''}" ${clickable ? `data-cat="${esc(name)}"` : ''} title="${esc(name)}: ${fmt(v)}">
        <span class="bar-name">${clickable ? catIcon(name).replace('class="ms"', 'class="ms bar-ic"') : ''}${esc(name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (v / max) * 100)}%;background:${color}"></span></span>
        <span class="bar-val">${fmt(v)}<small>${total ? Math.round((v / total) * 100) : 0}%</small></span>
      </${tag}>`;
    }).join('');
  }
  function renderCategoryBars(list) {
    const deb = list.filter(t => t.type === 'debit' && counted(t)), cred = list.filter(t => t.type === 'credit' && counted(t));
    const te = deb.reduce((s, t) => s + t.amount, 0), ti = cred.reduce((s, t) => s + t.amount, 0);
    barList($('expCats'), groupBy(deb, t => t.category), te, 'var(--expense)', true);
    barList($('incCats'), groupBy(cred, t => t.category), ti, 'var(--income)', true);
    barList($('topMerchants'), groupBy(deb, t => t.merchant).slice(0, 8), te, 'var(--expense)', false);
  }
  const catsFor = type => db.categories.filter(c => c.type === type || c.type === 'any').map(c => c.name);

  function renderTransactions(list) {
    const q = view.q.toLowerCase();
    const rows = list.filter(t =>
      (!view.type || t.type === view.type) && (!view.cat || t.category === view.cat) &&
      (!q || t.desc.toLowerCase().includes(q) || t.merchant.toLowerCase().includes(q))
    ).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const multi = view.acct === 'all' && accountsInScope().length > 1;
    $('txCount').textContent = `${rows.length} transaction${rows.length === 1 ? '' : 's'}` + (view.cat ? ` in ${view.cat}` : '');
    const shown = rows.slice(0, view.limit);
    // daily net for the day headers
    const dayNet = {};
    for (const t of rows) if (counted(t)) dayNet[t.date] = (dayNet[t.date] || 0) + (t.type === 'credit' ? t.amount : -t.amount);
    const td = today(), yd = shiftDays(td, -1);
    let html = '', lastDay = '';
    for (const t of shown) {
      if (t.date !== lastDay) {
        lastDay = t.date;
        const label = t.date === td ? 'Today' : t.date === yd ? 'Yesterday' : fmtDate(t.date);
        const n = dayNet[t.date] || 0;
        html += `<div class="tx-day" role="heading" aria-level="3"><span>${label}</span><span>${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}</span></div>`;
      }
      const acct = multi ? ' · ' + esc(accountOf(t.accountId)?.name) : '';
      html += `<button class="tx-item${counted(t) ? '' : ' excluded'}" data-id="${esc(t.id)}" aria-label="${esc(t.merchant)}, ${t.type === 'credit' ? 'income' : 'expense'} ${inr2.format(t.amount)}, ${esc(t.category)}">
        <span class="tx-avatar${t.type === 'credit' ? ' credit' : ''}">${catIcon(t.category)}</span>
        <span class="tx-main"><span class="tx-title">${esc(t.merchant)}${t.manual ? '<span class="tag">added</span>' : ''}${t.autoSalary ? '<span class="tag">detected</span>' : ''}</span>
          <span class="tx-sub">${esc(t.category)}${acct}</span></span>
        <span class="tx-amt ${t.type}">${t.type === 'credit' ? '+' : '−'}${inr2.format(t.amount)}</span></button>`;
    }
    $('txBody').innerHTML = html || '<div class="none">No matching transactions.</div>';
    $('moreBtn').hidden = rows.length <= view.limit;
  }

  /* ---------- transaction details sheet ---------- */
  let editingTx = null;
  function openTxEdit(id) {
    const t = db.txns.find(x => x.id === id); if (!t) return;
    editingTx = t;
    const a = accountOf(t.accountId);
    $('teIcon').className = 'tx-avatar big' + (t.type === 'credit' ? ' credit' : '');
    $('teIcon').innerHTML = catIcon(t.category);
    $('teTitle').textContent = t.merchant;
    $('teAmt').textContent = (t.type === 'credit' ? '+' : '−') + inr2.format(t.amount);
    $('teAmt').className = 'te-amt' + (t.type === 'credit' ? ' credit' : '');
    $('teMeta').textContent = `${fmtDate(t.date)} · ${t.type === 'credit' ? 'Income' : 'Expense'} · ${acctLabel(a)}${view.profile === 'all' ? ' (' + (profileOf(a?.profileId)?.name || '') + ')' : ''}`;
    $('teDesc').textContent = t.desc;
    const opts = catsFor(t.type);
    $('teCat').innerHTML = opts.map(c => `<option>${esc(c)}</option>`).join('') + (opts.includes(t.category) ? '' : `<option>${esc(t.category)}</option>`);
    $('teCat').value = t.category;
    const same = t.manual ? 0 : db.txns.filter(x => !x.manual && x.merchant.toLowerCase() === t.merchant.toLowerCase() && x.type === t.type).length;
    const unique = t.manual || ['unknown', 'atm cash'].includes(t.merchant.toLowerCase());
    $('teHint').textContent = (t.autoSalary ? 'Marked as Salary because it looks like your usual salary (similar amount, start/end of month). ' : '') +
      (unique || same < 2 ? '' : `Changing the category updates all ${same} transactions from "${t.merchant}" and future uploads.`);
    openDlg('txEditDlg');
  }
  $('txBody').addEventListener('click', e => { const b = e.target.closest('.tx-item'); if (b) openTxEdit(b.dataset.id); });
  $('teCat').onchange = () => {
    const t = editingTx; if (!t) return;
    CFStats.once('category-changed');
    const cat = $('teCat').value, key = t.merchant.toLowerCase();
    let n = 0;
    if (t.manual || key === 'unknown' || key === 'atm cash') { t.category = cat; t.userSet = true; t.autoSalary = false; n = 1; }
    else {
      for (const x of db.txns) if (x.merchant.toLowerCase() === key && x.type === t.type && !x.manual) { x.category = cat; x.autoSalary = false; n++; }
      db.rules[key] = cat;
    }
    $('teIcon').innerHTML = catIcon(cat);
    save(); renderDash();
    toast(`"${t.merchant}" is now ${cat}` + (n > 1 ? ` (${n} transactions)` : ''));
  };
  $('teDel').onclick = () => {
    const t = editingTx; if (!t) return;
    const idx = db.txns.indexOf(t);
    CFStats.once('transaction-deleted');
    db.txns.splice(idx, 1); save(); $('txEditDlg').close(); initFilters(true); renderDash();
    toast('Transaction deleted', 6000, { label: 'Undo', fn: () => { db.txns.splice(idx, 0, t); save(); initFilters(true); renderDash(); } });
  };

  /* ================= importing ================= */
  async function readFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) return FT.pdfLinesToTransactions(await pdfLines(file));
    if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
      // no cellDates: raw Excel serials avoid the "previous day at 23:51" timezone shift in IST
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      let best = null;
      for (const sn of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
        const r = FT.rowsToTransactions(rows);
        if (!best || r.transactions.length > best.transactions.length) best = r;
      }
      return best || { transactions: [], unparsed: [], warnings: ['The workbook is empty.'] };
    }
    return FT.rowsToTransactions(FT.parseCSV(await file.text()));
  }

  // keep each line's vertical position so wrapped narrations can be matched to the right row
  async function pdfLines(file) { return (await pdfExtract(file)).map(l => ({ text: l.items.join(' '), y: l.y, x: l.x, page: l.page })); }

  /** PDF → [{page, items: [text pieces left→right]}], one entry per visual line. */
  async function pdfExtract(file) {
    const lib = window.pdfjsLib;
    if (!lib) throw new Error('offline');
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    task.onPassword = (update, reason) => {
      const pw = prompt(reason === 2 ? 'Wrong password. Try again:' : `"${file.name}" is password-protected. Enter the PDF password (used only on this device):`);
      if (pw == null) task.destroy(); else update(pw);
    };
    const pdf = await task.promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      const rows = [];
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let row = rows.find(r => Math.abs(r.y - y) < 3);
        if (!row) rows.push(row = { y, items: [] });
        row.items.push({ x, s: it.str });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        lines.push({ page: p, y: Math.round(r.y * 10) / 10, x: Math.round(r.items[0].x * 10) / 10, items: r.items.map(i => i.s) });
      }
    }
    return lines;
  }

  /* ---------- anonymised diagnostics ---------- */
  async function diagnoseFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pdf')) return FT.diagnose({ fileType: 'PDF', pdfLines: await pdfExtract(file) });
    if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      let best = null;
      for (const sn of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
        const d = FT.diagnose({ fileType: `Excel (sheet ${wb.SheetNames.indexOf(sn) + 1} of ${wb.SheetNames.length})`, rows });
        if (!best || d.summary.count > best.summary.count) best = d;
      }
      return best || FT.diagnose({ fileType: 'Excel', rows: [] });
    }
    return FT.diagnose({ fileType: 'CSV', rows: FT.parseCSV(await file.text()) });
  }
  let diagFileName = '';
  $('diagBtn').onclick = () => $('diagInput').click();
  $('diagInput').onchange = async e => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    toast('Creating anonymised report…', 2000);
    let d;
    try { d = await diagnoseFile(file); }
    catch (err) {
      toast(err && err.name === 'PasswordException' ? 'Password not provided, so the PDF could not be opened.' : err && err.message === 'offline' ? 'PDF reader not loaded. Check your internet connection and reload.' : 'This file could not be read.', 6000);
      return;
    }
    const s = d.summary;
    diagFileName = 'cashflow-diagnostics-' + file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/\d{6,}/g, 'x').slice(0, 40) + '.txt';
    $('diagSummary').innerHTML = [
      `Transactions read: <b>${s.count}</b> (${s.income} income, ${s.count - s.income} expense)`,
      s.verified ? (s.gaps ? `Balance check: <b>${s.gaps} gap${s.gaps > 1 ? 's' : ''}</b> found` : 'Balance check: no gaps') : 'Balance check: not possible (no running balance found)',
      `Lines that couldn't be read: ${s.unparsed}`,
      s.same ? 'Anonymised copy reads the same as the original ✓' : '<b>Note:</b> the anonymised copy reads slightly differently from the original; it is still useful to share.',
    ].map(x => `<li>${x}</li>`).join('');
    $('diagText').value = d.text;
    $('diagText').scrollTop = 0;
    openDlg('diagDlg');
  };
  $('diagSave').onclick = () => download(diagFileName || 'cashflow-diagnostics.txt', $('diagText').value, 'text/plain');
  $('diagCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('diagText').value); toast('Copied.'); }
    catch (e) { $('diagText').select(); toast('Select-all done. Press ⌘C / Ctrl+C to copy.'); }
  };

  /** Verifies that the statement belongs to the chosen account. Returns {ok, msg, level}. */
  function checkAccount(acct, det) {
    if (!det) return { ok: true, level: 'warn', msg: 'Account number not found in the file, so it couldn\'t be checked against this account.' };
    const other = db.accounts.find(a => a.id !== acct.id && a.last4 === det.last4);
    const where = o => `"${o.name}"${view.profile === 'all' || o.profileId !== acct.profileId ? ` (${profileOf(o.profileId)?.name})` : ''}`;
    if (acct.last4 && acct.last4 !== det.last4) {
      return { ok: false, level: 'err', msg: `This statement is for account ending <b>${det.last4}</b>, but "${esc(acct.name)}" ends in <b>${acct.last4}</b>.` +
        (other ? ` It looks like it belongs to ${esc(where(other))}.` : ' Create a separate account for it.') + ' Nothing was imported.' };
    }
    if (!acct.last4 && other) {
      return { ok: false, level: 'err', msg: `This statement is for account ending <b>${det.last4}</b>, which is ${esc(where(other))}. Nothing was imported.` };
    }
    if (!acct.last4) { acct.last4 = det.last4; return { ok: true, level: 'ok', msg: `Account number ${det.display} detected and saved for this account.` }; }
    return { ok: true, level: 'ok', msg: `Account number ${det.display} matches this account.` };
  }

  function addTransactions(list, acct, stmtId) {
    const existing = new Set(db.txns.map(t => t.id));
    // the running balance makes a transaction unique even when the PDF and CSV/Excel word the description differently
    const balKey = (t, a) => t.balance == null || isNaN(t.balance) ? null : [a, t.date, t.type, t.amount.toFixed(2), Number(t.balance).toFixed(2)].join('|');
    const byBal = new Set(db.txns.map(t => balKey(t, t.accountId)).filter(Boolean));
    const seen = {}; let added = 0, dup = 0, from = null, to = null;
    for (const t of list) {
      const k = acct.id + '|' + FT.baseKey(t);
      seen[k] = (seen[k] || 0) + 1;
      const id = k + '#' + seen[k]; // identical txns on the same day are legitimate (two ₹20 teas)
      const bk = balKey(t, acct.id);
      if (existing.has(id) || (bk && byBal.has(bk))) { dup++; continue; }
      const merchant = FT.extractMerchant(t.desc);
      db.txns.push({ id, date: t.date, desc: t.desc, amount: t.amount, type: t.type, balance: t.balance == null || isNaN(t.balance) ? null : t.balance, merchant, category: FT.categorize({ ...t, merchant }, db.rules, compiled), accountId: acct.id, source: stmtId });
      existing.add(id); if (bk) byBal.add(bk); added++;
      if (!from || t.date < from) from = t.date;
      if (!to || t.date > to) to = t.date;
    }
    return { added, dup, from, to };
  }

  /** Marks salary credits that arrive without a salary keyword (see FT.findSalaryLike). Returns how many changed. */
  function detectSalary() {
    const ids = new Set(FT.findSalaryLike(db.txns, db.rules));
    for (const t of db.txns) if (ids.has(t.id)) { t.category = 'Salary'; t.autoSalary = true; }
    return ids.size;
  }

  async function importFiles(files, acct) {
    const reports = [];
    for (const file of files) {
      const rep = { file: file.name, account: acct.id, items: [] };
      const fmtName = /\.pdf$/i.test(file.name) ? 'pdf' : /\.xlsx?$/i.test(file.name) ? 'excel' : 'csv'; // only the format is counted, never the file name
      reports.push(rep);
      let res;
      try { res = await readFile(file); }
      catch (e) {
        CFStats.event('import-failed-' + fmtName);
        rep.items.push({ level: 'err', msg: e && e.name === 'PasswordException' ? 'Password not provided, so the file could not be opened.' : e && e.message === 'offline' ? 'PDF reader not loaded. Check your internet connection and reload.' : 'This file could not be read.' });
        continue;
      }
      const ac = checkAccount(acct, res.accountNo);
      rep.items.push({ level: ac.level, msg: ac.msg, html: true });
      if (!ac.ok) { CFStats.event('import-wrong-account'); continue; }
      if (!res.transactions.length) { CFStats.event('import-empty-' + fmtName); rep.items.push({ level: 'err', msg: res.warnings.join(' ') || 'No transactions found.' }); continue; }

      const stmtId = uid('s');
      const r = addTransactions(res.transactions, acct, stmtId);
      const dates = res.transactions.map(t => t.date).sort();
      rep.items.push({ level: 'ok', msg: `Read ${res.transactions.length} transactions (${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}): ${r.added} new` + (r.dup ? `, ${r.dup} already imported earlier` : '') + '.' });

      const chk = FT.reconcile(res.transactions, res.opening);
      rep.check = { verified: chk.verified, checked: chk.checked, gaps: chk.gaps, unparsed: (res.unparsed || []).slice(0, 25) };
      CFStats.event('import-ok-' + fmtName);
      if (chk.gaps && chk.gaps.length) CFStats.event('import-gaps-found');
      if (r.added || r.dup) {
        db.statements.push({ id: stmtId, accountId: acct.id, fileName: file.name, added: new Date().toISOString(), count: r.added, from: dates[0], to: dates[dates.length - 1], check: rep.check, accountMsg: ac.msg });
      }
    }
    const sal = detectSalary();
    if (sal) reports.push({ file: 'Salary check', account: acct.id, items: [{ level: 'ok', msg: `${sal} income credit${sal > 1 ? 's' : ''} without "salary" in the description ${sal > 1 ? 'look' : 'looks'} like your usual salary (similar amount, start/end of month) and ${sal > 1 ? 'were' : 'was'} marked as Salary. Tap the transaction to change it if that's wrong.` }] });
    save(); recompile(); initFilters(true); renderAll();
    showReport(reports, 'Import report');
  }

  function checkItems(c) {
    const items = [];
    if (!c) return items;
    if (!c.verified) items.push({ level: 'warn', msg: 'This statement has no running balance column, so it can\'t be automatically checked for missing transactions.' });
    else if (!c.gaps.length) items.push({ level: 'ok', msg: `Running balance verified across ${c.checked} transactions. Nothing is missing.` });
    else {
      items.push({
        level: 'warn', html: true,
        msg: `The running balance doesn't add up in ${c.gaps.length} place${c.gaps.length > 1 ? 's' : ''}, so something may have been missed or misread:<ul class="gap-list">` +
          c.gaps.slice(0, 15).map(g => `<li>${g.from ? `Between ${fmtDate(g.from)} and ${fmtDate(g.to)}` : `On ${fmtDate(g.to)}`}: <b>${inr2.format(g.amount)}</b> ${g.kind === 'credit' ? 'more came in' : 'more went out'} than the transactions show (near "${esc(g.near)}"). Possibly a missing <b>${g.kind === 'credit' ? 'income' : 'expense'}</b>.</li>`).join('') +
          `</ul>You can add a missing one with <b>+ Add transaction</b>. For help, create an anonymised report in <b>Settings → Statement diagnostics</b>.`,
      });
    }
    if (c.unparsed && c.unparsed.length) {
      items.push({ level: 'warn', html: true, msg: `${c.unparsed.length} line${c.unparsed.length > 1 ? 's' : ''} looked like transactions but couldn't be read: <details><summary>Show lines</summary><pre>${esc(c.unparsed.join('\n'))}</pre></details>` });
    }
    return items;
  }

  function showReport(reports, title) {
    const icon = { ok: '✓', warn: '!', err: '✕' };
    $('infoTitle').textContent = title;
    $('infoBody').innerHTML = reports.map(r => {
      const items = r.items.concat(checkItems(r.check));
      return `<div class="rep"><div class="rep-head">${esc(r.file)} <span>→ ${esc(acctLabel(accountOf(r.account)))}</span></div><ul>` +
        items.map(i => `<li><span class="ic ${i.level}">${icon[i.level]}</span><span>${i.html ? i.msg : esc(i.msg)}</span></li>`).join('') + '</ul></div>';
    }).join('');
    openDlg('infoDlg');
  }

  /* ---------- upload dialog ---------- */
  let pending = [];
  function openUpload(files) {
    pending = files ? [...files] : [];
    const accts = accountsInScope();
    const defaultAcct = view.acct !== 'all' ? view.acct : (accts[0] && accts[0].id) || 'new';
    $('upAcct').innerHTML = accts.map(a => `<option value="${a.id}">${esc(acctLabel(a))}${a.bank ? ' · ' + esc(a.bank) : ''}${view.profile === 'all' ? ' (' + esc(profileOf(a.profileId)?.name) + ')' : ''}</option>`).join('') +
      `<option value="new">+ New account…</option>`;
    $('upAcct').value = defaultAcct;
    $('naProfile').innerHTML = db.profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('naProfile').value = view.profile === 'all' ? db.profiles[0].id : view.profile;
    ['naName', 'naBank', 'naLast4'].forEach(id => ($(id).value = ''));
    syncUpload();
    openDlg('uploadDlg');
  }
  function syncUpload() {
    const isNew = $('upAcct').value === 'new';
    $('upNew').hidden = !isNew;
    $('upFiles').textContent = pending.length ? pending.map(f => f.name).join(', ') : 'Drop files here, or';
    $('upGo').disabled = !pending.length || (isNew && !$('naName').value.trim());
  }
  $('upAcct').onchange = syncUpload;
  $('naName').oninput = syncUpload;
  $('upChoose').onclick = () => $('fileInput').click();
  $('fileInput').onchange = e => { pending = pending.concat([...e.target.files]); e.target.value = ''; syncUpload(); };
  const upDrop = $('upDrop');
  upDrop.addEventListener('dragover', e => { e.preventDefault(); upDrop.classList.add('over'); });
  upDrop.addEventListener('dragleave', () => upDrop.classList.remove('over'));
  upDrop.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); upDrop.classList.remove('over'); pending = pending.concat([...e.dataTransfer.files]); syncUpload(); });
  $('upGo').onclick = () => {
    let acct;
    if ($('upAcct').value === 'new') {
      const last4 = $('naLast4').value.replace(/\D/g, '');
      if (last4 && last4.length !== 4) { toast('Last 4 digits must be exactly 4 numbers.'); return; }
      const clash = last4 && db.accounts.find(a => a.last4 === last4);
      if (clash) { toast(`An account ending ${last4} already exists: "${clash.name}".`); return; }
      acct = { id: uid('a'), profileId: $('naProfile').value, name: $('naName').value.trim(), bank: $('naBank').value.trim(), last4 };
      db.accounts.push(acct);
      if (view.profile !== 'all') view.profile = acct.profileId;
    } else acct = accountOf($('upAcct').value);
    const files = pending; pending = [];
    $('uploadDlg').close();
    view.acct = 'all';
    importFiles(files, acct);
  };
  $('uploadBtn').onclick = () => openUpload();
  $('uploadBtn2').onclick = () => openUpload();
  $('uploadFab').onclick = () => openUpload();

  // drag & drop anywhere on the page opens the upload dialog with those files
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if ($('uploadDlg').open) return; e.preventDefault(); dragDepth++; $('overlay').hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('overlay').hidden = true; } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0; $('overlay').hidden = true;
    if (!$('uploadDlg').open && e.dataTransfer.files.length) openUpload(e.dataTransfer.files);
  });

  /* ================= manual transactions ================= */
  function openAddTx() {
    const accts = accountsInScope();
    if (!accts.length) { toast('Add an account first (Settings → People & accounts).'); return; }
    $('tdAcct').innerHTML = accts.map(a => `<option value="${a.id}">${esc(acctLabel(a))}</option>`).join('');
    if (view.acct !== 'all') $('tdAcct').value = view.acct;
    $('tdDate').value = today(); $('tdDesc').value = ''; $('tdAmt').value = ''; $('tdType').value = 'debit';
    fillTxCats(); openDlg('txDlg');
  }
  function fillTxCats() { $('tdCat').innerHTML = catsFor($('tdType').value).map(c => `<option>${esc(c)}</option>`).join(''); $('tdCat').value = FT.FALLBACK[$('tdType').value]; }
  $('tdType').onchange = fillTxCats;
  $('addTxBtn').onclick = openAddTx;
  $('txForm').onsubmit = e => {
    e.preventDefault();
    const t = { date: $('tdDate').value, desc: $('tdDesc').value.trim(), amount: Math.round(+$('tdAmt').value * 100) / 100, type: $('tdType').value };
    if (!t.date || !t.desc || !(t.amount > 0)) return;
    db.txns.push({ ...t, id: uid('m'), merchant: t.desc.slice(0, 40), category: $('tdCat').value, accountId: $('tdAcct').value, manual: true, source: 'manual' });
    CFStats.event('manual-transaction-added');
    save(); $('txDlg').close(); initFilters(true); renderDash(); toast('Transaction added.');
  };

  /* ================= dashboard events ================= */
  $('modeSel').onchange = e => { view.mode = e.target.value; view.limit = PAGE; renderDash(); };
  $('yearSel').onchange = e => { view.year = e.target.value; view.month = 'all'; renderMonthOptions(); view.limit = PAGE; renderDash(); };
  $('monthSel').onchange = e => { view.month = e.target.value; view.limit = PAGE; renderDash(); };
  $('fromIn').onchange = e => { view.from = e.target.value; renderDash(); };
  $('toIn').onchange = e => { view.to = e.target.value; renderDash(); };
  $('acctSel').onchange = e => { view.acct = e.target.value; initFilters(true); renderDash(); };
  $('typeSel').onchange = e => { view.type = e.target.value; view.limit = PAGE; renderDash(); };
  $('catSel').onchange = e => { view.cat = e.target.value; view.limit = PAGE; renderDash(); };
  const txList = () => scopeTxns().filter(t => within(t, period()));
  $('search').oninput = e => { view.q = e.target.value; view.limit = PAGE; renderTransactions(txList()); };
  $('moreBtn').onclick = () => { view.limit += PAGE; renderTransactions(txList()); };

  // tapping a category on the dashboard opens Transactions filtered to it
  document.addEventListener('click', e => {
    const b = e.target.closest('button.bar-row');
    if (!b) return;
    view.cat = b.dataset.cat; view.type = ''; $('typeSel').value = ''; view.limit = PAGE;
    initFilters(true); goPage('tx');
  });

  /* ================= settings ================= */
  function renderSettings() {
    // people & accounts
    $('peopleList').innerHTML = db.profiles.map(p => {
      const accts = db.accounts.filter(a => a.profileId === p.id);
      return `<div class="person">
        <div class="person-head"><h3><span class="ms">person</span>${esc(p.name)}</h3>
          <div><button class="btn sm" data-act="add-acct" data-p="${p.id}"><span class="ms">add</span>Account</button>
          <button class="link" data-act="rename-p" data-p="${p.id}">Rename</button>
          ${db.profiles.length > 1 ? `<button class="link danger" data-act="del-p" data-p="${p.id}">Delete</button>` : ''}</div></div>
        ${accts.map(a => {
          const txs = db.txns.filter(t => t.accountId === a.id), ds = txs.map(t => t.date).sort();
          const stmts = db.statements.filter(s => s.accountId === a.id).sort((x, y) => (x.from < y.from ? 1 : -1));
          return `<div class="acct"><div class="acct-row">
              <div><div class="acct-name">${esc(a.name)} ${a.last4 ? `<span class="meta">••${a.last4}</span>` : '<span class="badge warn">number not set</span>'}</div>
              <div class="meta">${esc(a.bank || 'Bank not set')} · ${txs.length} transactions${ds.length ? ` · ${fmtDate(ds[0])} – ${fmtDate(ds[ds.length - 1])}` : ''}</div></div>
              <div><button class="btn sm" data-act="upload" data-a="${a.id}">Upload</button>
              <button class="link" data-act="edit-acct" data-a="${a.id}">Edit</button>
              <button class="link danger" data-act="del-acct" data-a="${a.id}">Delete</button></div></div>
            ${stmts.length ? `<ul class="stmts">${stmts.map(s => {
              const c = s.check, st = !c ? ['', '–'] : !c.verified ? ['warn', 'not verifiable'] : c.gaps.length ? ['warn', `${c.gaps.length} gap${c.gaps.length > 1 ? 's' : ''}`] : ['ok', '✓ verified'];
              return `<li><span>${esc(s.fileName)} <span class="meta">${fmtDate(s.from)} – ${fmtDate(s.to)} · ${s.count} new</span></span>
                <span><span class="badge ${st[0]}">${st[1]}</span> ${c ? `<button class="link" data-act="stmt-info" data-s="${s.id}">Details</button>` : ''}
                <button class="link danger" data-act="del-stmt" data-s="${s.id}">Remove</button></span></li>`;
            }).join('')}</ul>` : ''}</div>`;
        }).join('') || '<p class="meta">No accounts yet.</p>'}
      </div>`;
    }).join('');

    // categories
    const row = (c, i) => `<div class="cat-row" data-i="${i}">
      <input value="${esc(c.name)}" data-f="name" aria-label="Category name" ${c.fallback || c.name === FT.EXCLUDED ? 'disabled' : ''} maxlength="40">
      <input class="kw" value="${esc((c.keywords || []).join(', '))}" data-f="kw" aria-label="Keywords for ${esc(c.name)}" ${c.fallback ? 'disabled placeholder="Used when nothing else matches"' : 'placeholder="keywords…"'}>
      <span class="ctl">${c.fallback ? '' : `<button class="link" data-act="up" title="Higher priority" aria-label="Move up">↑</button><button class="link" data-act="down" title="Lower priority" aria-label="Move down">↓</button>`}
      ${c.fallback || c.name === FT.EXCLUDED ? '' : `<button class="link danger" data-act="del-cat" title="Delete" aria-label="Delete category">✕</button>`}</span></div>`;
    const by = type => db.categories.map((c, i) => [c, i]).filter(([c]) => c.type === type).map(([c, i]) => row(c, i)).join('');
    $('catDebit').innerHTML = by('debit'); $('catCredit').innerHTML = by('credit'); $('catAny').innerHTML = by('any');

    // rules
    const rules = Object.entries(db.rules).sort((a, b) => a[0].localeCompare(b[0]));
    $('ruleList').innerHTML = rules.map(([m, c]) => `<div class="rule"><span><b>${esc(m.replace(/\b\w/g, x => x.toUpperCase()))}</b> → ${esc(c)}</span><button class="link danger" data-act="del-rule" data-m="${esc(m)}">Remove</button></div>`).join('') ||
      '<p class="meta">No rules yet. Change a transaction\'s category on the dashboard to create one.</p>';
    syncThemeRadios(); renderInstall();
  }

  let editingAcct = null;
  function openAcctDlg(acct, profileId) {
    editingAcct = acct;
    $('acctDlgTitle').textContent = acct ? 'Edit account' : 'Add account';
    $('adProfile').innerHTML = db.profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('adName').value = acct ? acct.name : ''; $('adBank').value = acct ? acct.bank : ''; $('adLast4').value = acct ? acct.last4 : '';
    $('adProfile').value = acct ? acct.profileId : profileId;
    openDlg('acctDlg');
  }
  $('acctForm').onsubmit = e => {
    e.preventDefault();
    const last4 = $('adLast4').value.trim();
    const clash = last4 && db.accounts.find(a => a.last4 === last4 && a !== editingAcct);
    if (clash) { toast(`An account ending ${last4} already exists: "${clash.name}".`); return; }
    const data = { name: $('adName').value.trim(), bank: $('adBank').value.trim(), last4, profileId: $('adProfile').value };
    if (!editingAcct) CFStats.event('bank-account-added');
    if (editingAcct) Object.assign(editingAcct, data); else db.accounts.push({ id: uid('a'), ...data });
    save(); $('acctDlg').close(); renderAll();
  };

  function removeAccount(id) {
    db.txns = db.txns.filter(t => t.accountId !== id);
    db.statements = db.statements.filter(s => s.accountId !== id);
    db.accounts = db.accounts.filter(a => a.id !== id);
  }

  $('addPersonBtn').onclick = () => {
    const name = (prompt('Name of the person (for example Mom, Dad, Priya):') || '').trim();
    if (!name) return;
    CFStats.event('person-added');
    db.profiles.push({ id: uid('p'), name: name.slice(0, 30) }); save(); renderAll();
  };

  $('settings').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'add-acct') openAcctDlg(null, b.dataset.p);
    else if (act === 'edit-acct') openAcctDlg(accountOf(b.dataset.a));
    else if (act === 'upload') { const a = accountOf(b.dataset.a); view.profile = a.profileId; view.acct = a.id; renderHeader(); openUpload(); }
    else if (act === 'rename-p') {
      const p = profileOf(b.dataset.p), name = (prompt('New name:', p.name) || '').trim();
      if (name) { p.name = name.slice(0, 30); save(); renderAll(); }
    } else if (act === 'del-p') {
      const p = profileOf(b.dataset.p), n = db.accounts.filter(a => a.profileId === p.id).length;
      if (!confirm(`Delete ${p.name}${n ? ` and their ${n} account(s) with all transactions` : ''}? This can't be undone.`)) return;
      db.accounts.filter(a => a.profileId === p.id).forEach(a => removeAccount(a.id));
      db.profiles = db.profiles.filter(x => x.id !== p.id); save(); renderAll();
    } else if (act === 'del-acct') {
      const a = accountOf(b.dataset.a);
      if (!confirm(`Delete "${a.name}" and all its transactions? This can't be undone.`)) return;
      removeAccount(a.id); save(); renderAll();
    } else if (act === 'del-stmt') {
      if (!confirm('Remove this statement and the transactions it added?')) return;
      db.txns = db.txns.filter(t => t.source !== b.dataset.s);
      db.statements = db.statements.filter(s => s.id !== b.dataset.s); save(); renderAll();
    } else if (act === 'stmt-info') {
      const s = db.statements.find(x => x.id === b.dataset.s);
      showReport([{ file: s.fileName, account: s.accountId, items: s.accountMsg ? [{ level: 'ok', msg: s.accountMsg, html: true }] : [], check: s.check }], 'Statement check');
    } else if (act === 'del-rule') { delete db.rules[b.dataset.m]; save(); renderSettings(); }
    else if (act === 'up' || act === 'down' || act === 'del-cat') {
      const i = +b.closest('.cat-row').dataset.i, c = db.categories[i];
      if (act === 'del-cat') {
        if (!confirm(`Delete "${c.name}"? Its transactions move to "${c.type === 'credit' ? FT.FALLBACK.credit : FT.FALLBACK.debit}".`)) return;
        db.txns.forEach(t => { if (t.category === c.name) t.category = FT.FALLBACK[t.type]; });
        for (const k in db.rules) if (db.rules[k] === c.name) delete db.rules[k];
        db.categories.splice(i, 1);
      } else {
        const step = act === 'up' ? -1 : 1;
        let j = i + step;
        while (j >= 0 && j < db.categories.length && db.categories[j].type !== c.type) j += step;
        if (j < 0 || j >= db.categories.length || db.categories[j].fallback) return;
        [db.categories[i], db.categories[j]] = [db.categories[j], db.categories[i]];
      }
      recompile(); save(); renderSettings();
    }
  });

  $('settings').addEventListener('change', e => {
    const inp = e.target.closest('.cat-row input'); if (!inp) return;
    const c = db.categories[+inp.closest('.cat-row').dataset.i];
    if (inp.dataset.f === 'kw') {
      c.keywords = inp.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      toast(`Keywords saved for ${c.name}. Click "Re-apply" to update existing transactions.`);
    } else {
      const name = inp.value.trim();
      if (!name || db.categories.some(x => x !== c && x.name.toLowerCase() === name.toLowerCase())) { toast('That name is empty or already used.'); inp.value = c.name; return; }
      db.txns.forEach(t => { if (t.category === c.name) t.category = name; });
      for (const k in db.rules) if (db.rules[k] === c.name) db.rules[k] = name;
      if (view.cat === c.name) view.cat = name;
      c.name = name;
    }
    recompile(); save();
  });

  $('addCatForm').onsubmit = e => {
    e.preventDefault();
    const name = $('newCatName').value.trim(), type = $('newCatType').value;
    if (db.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) { toast('A category with that name already exists.'); return; }
    const keywords = $('newCatKw').value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const fb = db.categories.findIndex(c => c.fallback && c.type === type); // insert above the type's fallback
    db.categories.splice(fb < 0 ? db.categories.length : fb, 0, { name, type, keywords });
    $('newCatName').value = ''; $('newCatKw').value = '';
    recompile(); save(); renderSettings(); toast(`Added "${name}".` + (keywords.length ? ' Click "Re-apply" to sort existing transactions into it.' : ''));
  };

  $('reapplyBtn').onclick = () => {
    let n = 0;
    for (const t of db.txns) {
      if (t.manual || t.userSet) continue; // never undo the user's own choices
      const c = FT.categorize(t, db.rules, compiled);
      if (c !== t.category) { t.category = c; t.autoSalary = false; n++; }
    }
    n += detectSalary();
    CFStats.once('categories-reapplied');
    save(); toast(n ? `${n} transactions re-categorised.` : 'Everything is already up to date.');
  };

  /* ---------- downloads: CSV / Excel / PDF for a chosen person, account and period ---------- */
  const download = (name, data, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  /** Parse and validate Cash Flow data (the Drive file); throws if it isn't Cash Flow data. */
  function parseBackup(text) {
    let d = JSON.parse(text);
    if (!d || typeof d !== 'object') throw 0;
    if (d.version !== 2) { if (!Array.isArray(d.txns)) throw 0; d = migrateV1(d); }
    if (!Array.isArray(d.profiles) || !d.profiles.length || !Array.isArray(d.txns)) throw 0;
    return d;
  }
  function exportSel() {
    const p = $('exProfile').value, a = $('exAcct').value;
    const accts = db.accounts.filter(x => (p === 'all' || x.profileId === p) && (a === 'all' || x.id === a));
    const ids = new Set(accts.map(x => x.id));
    return { p, a, all: db.txns.filter(t => ids.has(t.accountId)).sort((x, y) => x.date.localeCompare(y.date) || (x.type === 'credit' ? -1 : 1)) };
  }
  function exportRange() { const { all } = exportSel(); return all.length ? [all[0].date, all[all.length - 1].date] : [null, null]; }
  function exportPeriod() { let f = $('exFrom').value, t = $('exTo').value; if (f && t && f > t) [f, t] = [t, f]; return [f, t]; }
  function exportRows() { const [f, t] = exportPeriod(); return exportSel().all.filter(x => (!f || x.date >= f) && (!t || x.date <= t)); }
  const sumOf = (rows, type) => rows.reduce((s, t) => s + (t.type === type ? t.amount : 0), 0);
  function syncExportDates() {
    const [min, max] = exportRange();
    for (const id of ['exFrom', 'exTo']) { const el = $(id); el.min = min || ''; el.max = max || ''; el.disabled = !min; }
    $('exFrom').value = min || ''; $('exTo').value = max || '';
    renderExportCount();
  }
  function renderExportCount() {
    const [min, max] = exportRange();
    for (const id of ['exFrom', 'exTo']) { const el = $(id); if (min && el.value && (el.value < min || el.value > max)) el.value = el.value < min ? min : max; }
    const rows = exportRows();
    $('exRange').textContent = min ? `Transactions for this selection run from ${fmtDate(min)} to ${fmtDate(max)}.` : 'There are no transactions for this selection yet.';
    $('exCount').textContent = rows.length ? `${rows.length} transactions · Income ${fmt(sumOf(rows, 'credit'))} · Expense ${fmt(sumOf(rows, 'debit'))}` : 'No transactions in this period.';
    ['exCsv', 'exXlsx', 'exPdf'].forEach(id => ($(id).disabled = !rows.length));
  }
  function fillExportAccts() {
    const p = $('exProfile').value;
    $('exAcct').innerHTML = '<option value="all">All accounts</option>' + db.accounts.filter(a => p === 'all' || a.profileId === p)
      .map(a => `<option value="${a.id}">${esc(acctLabel(a))}${p === 'all' ? ' · ' + esc(profileOf(a.profileId)?.name || '') : ''}</option>`).join('');
  }
  $('downloadBtn').onclick = () => {
    const sel = $('exProfile');
    sel.innerHTML = db.profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') + (db.profiles.length > 1 ? '<option value="all">Everyone</option>' : '');
    sel.value = view.profile === 'all' ? (db.profiles.length > 1 ? 'all' : db.profiles[0].id) : (profileOf(view.profile) ? view.profile : db.profiles[0].id);
    fillExportAccts();
    if (view.acct !== 'all' && [...$('exAcct').options].some(o => o.value === view.acct)) $('exAcct').value = view.acct;
    syncExportDates(); openDlg('exportDlg');
  };
  $('exProfile').onchange = () => { fillExportAccts(); syncExportDates(); };
  $('exAcct').onchange = syncExportDates;
  $('exFrom').onchange = $('exTo').onchange = renderExportCount;
  const exportWho = () => { const { p, a } = exportSel(); return a !== 'all' ? `${acctLabel(accountOf(a))} (${profileOf(accountOf(a)?.profileId)?.name || ''})` : p === 'all' ? 'Everyone, all accounts' : `${profileOf(p)?.name || ''}, all accounts`; };
  const exportName = ext => {
    const { p, a } = exportSel(), [f, t] = exportPeriod();
    const who = a !== 'all' ? acctLabel(accountOf(a)) : p === 'all' ? 'everyone' : profileOf(p)?.name || '';
    return `cashflow_${who.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export'}_${f}_to_${t}.${ext}`;
  };
  const rowInfo = t => { const a = accountOf(t.accountId); return { person: profileOf(a?.profileId)?.name || '', account: acctLabel(a) }; };
  function monthly(rows) {
    const m = new Map();
    for (const t of rows) { const k = t.date.slice(0, 7), v = m.get(k) || { inc: 0, exp: 0 }; if (t.type === 'credit') v.inc += t.amount; else v.exp += t.amount; m.set(k, v); }
    return [...m].sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => ({ month: `${MONTHS[+k.slice(5) - 1]} ${k.slice(0, 4)}`, inc: v.inc, exp: v.exp, net: v.inc - v.exp }));
  }
  function byCategory(rows) {
    const m = new Map();
    for (const t of rows) { const k = t.type + '|' + t.category, v = m.get(k) || { type: t.type, cat: t.category, total: 0, n: 0 }; v.total += t.amount; v.n++; m.set(k, v); }
    return [...m.values()].sort((x, y) => x.type.localeCompare(y.type) || y.total - x.total);
  }
  const r2 = n => Math.round(n * 100) / 100;

  $('exCsv').onclick = () => {
    const rows = exportRows();
    const out = [['Date', 'Person', 'Account', 'Type', 'Amount', 'Category', 'Merchant', 'Description', 'Balance']].concat(rows.map(t => {
      const i = rowInfo(t);
      return [t.date, i.person, i.account, t.type === 'credit' ? 'Income' : 'Expense', t.amount, t.category, t.merchant, t.desc, t.balance ?? ''];
    }));
    // a leading = + - @ would make Excel run the cell as a formula; prefix with ' (CSV injection guard)
    const cell = c => { let s = String(c); if (typeof c !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    CFStats.event('download-csv');
    download(exportName('csv'), '﻿' + out.map(r => r.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  };

  $('exXlsx').onclick = () => {
    if (!window.XLSX) return toast('The Excel library failed to load. Try reloading the page.');
    const rows = exportRows(), [f, t] = exportPeriod(), inc = sumOf(rows, 'credit'), exp = sumOf(rows, 'debit');
    const MONEY = '#,##0.00', DATE = 'dd-mmm-yyyy';
    const serial = iso => { const [y, m, d] = iso.split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
    const sheet = (aoa, widths, fmtCols) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = widths.map(w => ({ wch: w }));
      for (const addr in ws) {
        if (addr[0] === '!') continue;
        const c = ws[addr], col = XLSX.utils.decode_cell(addr).c;
        if (c.t === 'n' && fmtCols[col]) c.z = fmtCols[col];
      }
      return ws;
    };
    const summary = [['Cash Flow statement'], ['Selection', exportWho()], ['Period', `${fmtDate(f)} to ${fmtDate(t)}`], ['Generated', fmtDate(today())], [],
      ['Income', r2(inc)], ['Expense', r2(exp)], ['Net', r2(inc - exp)], ['Transactions', rows.length], [],
      ['Month', 'Income', 'Expense', 'Net'], ...monthly(rows).map(m => [m.month, r2(m.inc), r2(m.exp), r2(m.net)]), [],
      ['Category', 'Type', 'Total', 'Transactions'], ...byCategory(rows).map(c => [c.cat, c.type === 'credit' ? 'Income' : 'Expense', r2(c.total), c.n])];
    const ws1 = sheet(summary, [24, 34, 14, 14], { 1: MONEY, 2: MONEY, 3: MONEY });
    if (ws1.B9) delete ws1.B9.z; // the transaction count is not money
    const tx = [['Date', 'Person', 'Account', 'Category', 'Merchant', 'Description', 'Income', 'Expense', 'Balance']];
    for (const x of rows) { const i = rowInfo(x); tx.push([serial(x.date), i.person, i.account, x.category, x.merchant, x.desc, x.type === 'credit' ? x.amount : null, x.type === 'debit' ? x.amount : null, x.balance ?? null]); }
    tx.push([], ['Total', '', '', '', '', '', r2(inc), r2(exp)]);
    const ws2 = sheet(tx, [12, 14, 22, 20, 22, 60, 13, 13, 13], { 0: DATE, 6: MONEY, 7: MONEY, 8: MONEY });
    // the category table's transaction counts are plain numbers
    for (let r = 0; r < summary.length; r++) if (summary[r][0] === 'Category') { for (let k = r + 1; k < summary.length && summary[k].length; k++) { const c = ws1[XLSX.utils.encode_cell({ r: k, c: 3 })]; if (c) delete c.z; } }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
    XLSX.utils.book_append_sheet(wb, ws2, 'Transactions');
    XLSX.writeFile(wb, exportName('xlsx'));
    CFStats.event('download-excel');
  };

  let pdfLib = null;
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(new Error('load')); }; document.head.appendChild(s); });
  async function jsPDFReady() {
    const ok = () => window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable;
    if (!ok()) {
      pdfLib = pdfLib || loadScript('vendor/jspdf.umd.min.js').then(() => loadScript('vendor/jspdf.plugin.autotable.min.js'));
      try { await pdfLib; } catch (e) { pdfLib = null; throw e; }
    }
    if (!ok()) throw new Error('PDF library not available');
    return window.jspdf.jsPDF;
  }
  $('exPdf').onclick = async () => {
    const btn = $('exPdf'), label = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const JsPDF = await jsPDFReady();
      const rows = exportRows(), [f, t] = exportPeriod(), inc = sumOf(rows, 'credit'), exp = sumOf(rows, 'debit');
      // the PDF's built-in fonts cover Latin characters only: show ₹ as Rs. and drop anything else they can't draw
      const txt = s => String(s ?? '').replace(/₹/g, 'Rs.').replace(/••/g, 'ending ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/\s+/g, ' ').trim();
      const num = n => n == null || n === '' ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const doc = new JsPDF({ unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 40;
      const blue = [0, 90, 193], base = { theme: 'grid', margin: { left: M, right: M }, styles: { fontSize: 9, cellPadding: 4, lineColor: [210, 212, 220], lineWidth: 0.5 }, headStyles: { fillColor: blue, textColor: 255, fontStyle: 'bold' } };
      doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Cash Flow statement', M, 52);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(80);
      doc.text(txt(exportWho()), M, 70);
      doc.text(`Period: ${fmtDate(f)} to ${fmtDate(t)}     Generated: ${fmtDate(today())}     Amounts in INR`, M, 85);
      doc.setTextColor(0);
      const right = { halign: 'right' };
      doc.autoTable(Object.assign({}, base, { startY: 100, head: [['Income', 'Expense', 'Net', 'Transactions']], body: [[num(inc), num(exp), num(inc - exp), String(rows.length)]],
        styles: Object.assign({}, base.styles, { fontSize: 11, halign: 'right' }), headStyles: Object.assign({}, base.headStyles, right) }));
      const heading = (s, y) => { doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(s, M, y); doc.setFont('helvetica', 'normal'); return y + 6; };
      doc.autoTable(Object.assign({}, base, { startY: heading('Month by month', doc.lastAutoTable.finalY + 26), head: [['Month', 'Income', 'Expense', 'Net']],
        body: monthly(rows).map(m => [m.month, num(m.inc), num(m.exp), num(m.net)]), columnStyles: { 1: right, 2: right, 3: right } }));
      doc.autoTable(Object.assign({}, base, { startY: heading('By category', doc.lastAutoTable.finalY + 26), head: [['Category', 'Type', 'Total', 'Transactions']],
        body: byCategory(rows).map(c => [txt(c.cat), c.type === 'credit' ? 'Income' : 'Expense', num(c.total), String(c.n)]), columnStyles: { 2: right, 3: right } }));
      doc.addPage();
      doc.autoTable(Object.assign({}, base, { startY: heading('Transactions', 52), head: [['Date', 'Description', 'Category', 'Income', 'Expense', 'Balance']],
        body: rows.map(x => [fmtDate(x.date), txt(x.desc).slice(0, 120), txt(x.category), x.type === 'credit' ? num(x.amount) : '', x.type === 'debit' ? num(x.amount) : '', num(x.balance)]),
        styles: Object.assign({}, base.styles, { fontSize: 8, overflow: 'linebreak' }),
        columnStyles: { 0: { cellWidth: 58 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 78 }, 3: Object.assign({ cellWidth: 62 }, right), 4: Object.assign({ cellWidth: 62 }, right), 5: Object.assign({ cellWidth: 66 }, right) } }));
      const pages = doc.getNumberOfPages();
      for (let i = 1; i <= pages; i++) {
        doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120);
        doc.text('Cash Flow', M, H - 20); doc.text(`Page ${i} of ${pages}`, W - M, H - 20, { align: 'right' });
      }
      doc.save(exportName('pdf'));
      CFStats.event('download-pdf');
    } catch (e) {
      toast(navigator.onLine === false ? 'The PDF maker is not on this device yet. Connect to the internet once, then try again.' : 'Could not create the PDF. Try reloading the page.', 7000);
    } finally { btn.disabled = false; btn.innerHTML = label; }
  };

  $('clearBtn').onclick = () => {
    const drive = user && CFDrive.configured() && !meta.paused;
    if (!confirm('Delete ALL people, accounts, transactions and category settings?' + (drive ? '\n\nThis also deletes them from your Google Drive copy and your other devices when they sync.' : ''))) return;
    CFStats.event('all-data-deleted');
    db = fresh(); recompile(); save(); view.profile = db.profiles[0].id; view.acct = 'all'; view.cat = ''; initFilters(false); renderAll();
  };

  /* ================= Google account & Drive sync (the user's own Drive; see gdrive.js and sync.js) ================= */
  const fmtWhen = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const DRIVE_ERR = {
    'not-configured': 'Google sign-in has not been set up for this copy of the app yet.',
    'not-loaded': 'Google sign-in is still loading. Try again in a moment.',
    offline: "You're offline. Connect to the internet and try again.",
    'popup-blocked': 'The browser blocked the Google sign-in window. Allow pop-ups for this site, then try again.',
    cancelled: 'Google sign-in was closed before it finished.',
    denied: 'Google sign-in was cancelled.',
    scope: 'Cash Flow needs permission to save its file in your Google Drive. Try again and tick the Google Drive box.',
    auth: 'Your Google sign-in expired. Tap Sync to sign in again.',
    'drive-full': 'Your Google Drive is full. Free up some space, then try again.',
  };
  const errText = e => DRIVE_ERR[e && e.code] || (e && e.message) || 'Something went wrong with Google.';
  const firstName = u => (u.given || (u.name || '').split(' ')[0] || (u.email || '').split('@')[0] || '').trim();
  let sess = null;   // Google session for the signed-in account: memory only, about 1 hour
  let busy = false;
  let meta = (user && readArea(user, metaKey())) || {};  // sync state: base, remoteModified, syncedAt, editedAt, dirty, paused
  const setMeta = patch => { meta = Object.assign({}, meta, patch); if (user) writeArea(user, metaKey(), meta); };

  function setUser(u) {
    if (u && u.remember) {
      const all = knownAccounts(); all[u.sub] = u;
      writeJSON(ACCOUNTS_KEY, all); writeJSON(CURRENT_KEY, u.sub); writeS(SESSION_USER, null);
    } else if (u) { writeS(SESSION_USER, u); writeJSON(CURRENT_KEY, null); }
    else { writeS(SESSION_USER, null); writeJSON(CURRENT_KEY, null); }
    user = u;
    meta = (u && readArea(u, metaKey(u))) || {};
    checkAdmin();
  }
  /** A Drive session for the signed-in account. Opens Google's popup only when needed, so call it straight from a click. */
  async function session() {
    if (CFDrive.valid(sess) && sess.drive) return sess;
    const s = await CFDrive.signIn({ hint: user.email, needDrive: true });
    const u = await CFDrive.userInfo(s);
    if (u.sub !== user.sub) throw new Error(`You chose ${u.email}, but this device is signed in as ${user.email}. Choose ${user.email}, or use "Change Google account" to move to ${u.email}.`);
    return (sess = s);
  }

  /* ---- sync with Google Drive ---- */
  let syncing = false, syncQueued = false, syncTimer = null, syncErr = '', nudged = false;
  const syncOn = () => !!user && CFDrive.configured() && !meta.paused;
  function markDirty() {
    if (!syncOn()) return;
    setMeta({ dirty: true, editedAt: Date.now() });
    renderSync(); scheduleSync();
  }
  function scheduleSync(ms = 2000) {
    clearTimeout(syncTimer);
    if (!syncOn() || !meta.dirty) return;
    if (CFDrive.valid(sess) && sess.drive && navigator.onLine !== false) syncTimer = setTimeout(() => syncNow(false), ms);
    else if (!nudged && navigator.onLine !== false) {
      nudged = true;
      // after the action's own message ("Transaction added." etc.), not instead of it
      setTimeout(() => meta.dirty && toast(user.remember ? 'Saved on this device. Tap Sync to save it to your Google Drive too.' : "Not in your Google Drive yet. Tap Sync so it isn't lost when this tab closes.", 12000, { label: 'Sync', fn: () => syncNow(true) }), 1800);
    }
  }
  function refreshView() { recompile(); initFilters(true); renderAll(); }
  /** Bring this device and Google Drive up to date with each other. manual: started by a click (may open Google's popup). */
  async function syncNow(manual) {
    if (!syncOn()) return false;
    if (syncing) { syncQueued = true; return false; }
    syncing = true; syncErr = ''; clearTimeout(syncTimer); renderSync();
    let changedHere = false;
    try {
      const s = manual ? await session() : sess;
      if (!CFDrive.valid(s)) throw Object.assign(new Error('auth'), { code: 'auth' });
      for (let round = 0; ; round++) {
        if (round > 3) throw new Error('Your Google Drive copy kept changing while syncing. Please try again.');
        const snap = JSON.stringify(db), local = JSON.parse(snap), editedAt = meta.editedAt || 0;
        const f = await CFDrive.find(s);
        let remote = null;
        if (f && f.modified !== meta.remoteModified) {
          try { remote = parseBackup(await CFDrive.download(s, f.id)); }
          catch (e) { if (e && e.code) throw e; throw new Error('The Cash Flow file in your Google Drive is damaged, so it was left as it is. Delete the Drive copy in Settings, then turn sync back on to replace it.'); }
        }
        // a brand-new device with nothing on it simply takes the Drive copy
        const localEmpty = !meta.base && !local.accounts.length && !local.txns.length;
        const merged = remote ? (localEmpty ? remote : CFSync.merge(local, remote, meta.base || null, editedAt > Date.parse(f.modified))) : local;
        const needUpload = !f || (remote ? !CFSync.same(merged, remote) : !!meta.dirty);
        let up = null;
        if (needUpload) {
          if (f) { const again = await CFDrive.find(s); if (again && again.modified !== f.modified) continue; } // saved elsewhere meanwhile: merge again
          up = await CFDrive.save(s, JSON.stringify(merged), { txns: merged.txns.length, people: merged.profiles.length }, f && f.id);
        }
        // the user may have changed something while we were talking to Google: fold those edits in too
        const editedDuring = JSON.stringify(db) !== snap;
        const next = editedDuring ? CFSync.merge(db, merged, CFSync.fingerprint(local), true) : merged;
        if (!CFSync.same(next, db)) { changedHere = true; db = next; writeArea(user, dataKey(), db); }
        setMeta({ base: CFSync.fingerprint(merged), remoteModified: up ? up.modifiedTime : f ? f.modified : null, syncedAt: new Date().toISOString(), dirty: editedDuring });
        if (!editedDuring) break;
      }
      nudged = false;
      CFStats.once('sync-ok');
      if (changedHere) CFStats.once('sync-brought-changes');
      return true;
    } catch (e) {
      CFStats.once('sync-error-' + (e && e.code ? e.code : 'other'));
      syncErr = errText(e);
      if (manual) toast(syncErr, 8000);
      return false;
    } finally {
      syncing = false;
      if (changedHere) refreshView(); else renderSync();
      if (syncQueued) { syncQueued = false; scheduleSync(300); }
    }
  }
  function syncState() {
    if (!user || !CFDrive.configured()) return null;
    if (meta.paused) return { ic: 'cloud_off', text: 'Drive sync is off. Your data is only on this device.' };
    if (syncing) return { ic: 'cloud_sync', text: 'Syncing with Google Drive…', spin: true };
    if (navigator.onLine === false) return { ic: 'cloud_off', text: meta.dirty ? "You're offline. Your changes are kept on this device and sync when you're back online." : "You're offline. Showing the copy on this device." };
    if (syncErr) return { ic: 'sync_problem', text: `Not synced: ${syncErr}`, dot: true };
    if (meta.dirty) return { ic: 'cloud_upload', text: 'Some changes on this device are not in Google Drive yet.', dot: true };
    if (!meta.syncedAt) return { ic: 'cloud_sync', text: 'Not synced with Google Drive yet.', dot: true };
    return { ic: 'cloud_done', text: `Saved to Google Drive · ${fmtWhen(meta.syncedAt)}` + (CFDrive.valid(sess) ? '' : '. Tap Sync to get changes from your other devices.') };
  }
  function renderSync() {
    const st = syncState(), b = $('syncBtn');
    b.hidden = !st;
    if (st) {
      $('syncIc').textContent = st.ic; b.classList.toggle('spin', !!st.spin); $('syncDot').hidden = !st.dot;
      b.title = st.text; b.setAttribute('aria-label', 'Sync with Google Drive. ' + st.text);
    }
    $('syncLine').hidden = !st;
    if (st) { $('syncLineIc').textContent = st.ic; $('driveStatus').textContent = st.text; }
    $('syncNowBtn').disabled = busy || syncing || !st || !!meta.paused;
  }
  $('syncBtn').onclick = $('syncNowBtn').onclick = async () => {
    if (meta.paused) { goPage('settings'); $('driveCard').scrollIntoView({ block: 'start' }); return; }
    if (await syncNow(true)) toast('Synced with Google Drive.');
  };
  window.addEventListener('online', () => { renderSync(); scheduleSync(300); });
  window.addEventListener('offline', () => renderSync());
  window.addEventListener('beforeunload', e => { if (user && !user.remember && meta.dirty && !meta.paused) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- sign-in screen ---- */
  function renderGate(msg, isErr) {
    const g = gated();
    document.body.classList.toggle('gated', g);
    $('gate').hidden = !g;
    if (!g) return;
    const loaded = !!(window.google && google.accounts && google.accounts.oauth2), offline = navigator.onLine === false;
    $('gateSignIn').disabled = !loaded || busy;
    $('gateStats').hidden = !CFStats.enabled();
    $('gateMsg').textContent = msg || (loaded ? '' : offline ? "You're offline. Connect to the internet to sign in." : 'Loading Google sign-in…');
    $('gateMsg').classList.toggle('err', !!isErr || (!loaded && offline));
  }
  try { $('gateRemember').checked = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { /* ignore */ }
  $('gateSignIn').onclick = async () => {
    if (busy) return;
    busy = true; renderGate('Waiting for Google…');
    try {
      const s = await CFDrive.signIn({ selectAccount: true });
      const u = await CFDrive.userInfo(s);
      sess = s; busy = false;
      enterAccount(u, $('gateRemember').checked);
    } catch (e) { busy = false; renderGate(errText(e), true); }
  };
  function enterAccount(u, remember) {
    const known = knownAccounts()[u.sub];
    const rec = { sub: u.sub, email: u.email, name: u.name, given: u.given, remember: !!(remember || known) };
    writeJSON(OLD_DRIVE_KEY, null); // state from the earlier backup-only version
    let d = readArea(rec, dataKey(rec)), adopted = false;
    if (!(d && d.version === 2)) {
      d = null;
      const legacy = legacyData();
      if (legacy && (legacy.txns.length || legacy.accounts.length) &&
          confirm(`This device has Cash Flow data from before sign-in (${legacy.txns.length} transactions).\n\nMove it into ${u.email}?\n\nChoose Cancel if it belongs to someone else. It stays on this device for them.`)) {
        d = legacy; adopted = true; writeJSON(KEY, null); writeJSON(OLD_KEY, null);
      }
      d = d || fresh();
      if (d.profiles.length === 1 && d.profiles[0].name === 'Me' && firstName(rec)) d.profiles[0].name = firstName(rec);
    }
    setUser(rec);
    db = d; recompile();
    writeArea(rec, dataKey(rec), db);
    if (adopted) setMeta({ dirty: true, editedAt: Date.now() });
    Object.assign(view, { page: 'dash', profile: db.profiles[0].id, acct: 'all', cat: '' });
    initFilters(false); renderGate(); renderAll();
    toast(`Signed in as ${u.email}.`);
    CFStats.event(rec.remember ? 'signin-remembered' : 'signin-shared-computer');
    if (adopted) CFStats.event('signin-moved-old-data');
    if (CFDrive.valid(sess) && sess.drive) syncNow(false);
    else { toast('To load your data from Google Drive, tap Sync and tick the Google Drive box.', 12000, { label: 'Sync', fn: () => syncNow(true) }); }
  }

  /* ---- account card ---- */
  function renderAccount() {
    const on = CFDrive.configured(), u = user;
    $('whoBox').hidden = $('acctActions').hidden = $('rememberRow').hidden = !u;
    if (u) {
      $('whoInitial').textContent = firstName(u).slice(0, 1); $('whoName').textContent = u.name || firstName(u); $('whoEmail').textContent = u.email;
      $('rememberChk').checked = !!u.remember;
    }
    ['driveDeleteBtn', 'driveOnBtn', 'changeAcctBtn', 'signOutBtn', 'rememberChk'].forEach(id => ($(id).disabled = !u || busy));
    $('driveDeleteBtn').hidden = !!meta.paused; $('driveOnBtn').hidden = !meta.paused; $('syncNowBtn').hidden = !!meta.paused;
    $('driveOff').hidden = on;
    const av = $('avatarBtn');
    av.hidden = !u;
    if (u) { $('avatarInitial').textContent = firstName(u).slice(0, 1); av.title = `Signed in as ${u.email}`; av.setAttribute('aria-label', `Google account: ${u.email}`); }
    renderSync();
  }
  $('avatarBtn').onclick = () => { goPage('settings'); $('driveCard').scrollIntoView({ block: 'start' }); };
  async function driveRun(btn, label, fn) {
    if (busy) return;
    const b = $(btn), html = b.innerHTML;
    busy = true; renderAccount(); b.textContent = label;
    try { await fn(); }
    catch (e) { toast(errText(e), 8000); }
    finally { busy = false; b.innerHTML = html; renderAccount(); }
  }
  $('driveDeleteBtn').onclick = () => driveRun('driveDeleteBtn', 'Deleting…', async () => {
    const s = await session();
    const f = await CFDrive.find(s);
    if (!confirm(`Delete the Cash Flow copy from your Google Drive (${user.email})?\n\n` + (f ? `Saved ${fmtWhen(f.modified)}, ${f.txns} transactions. It moves to the Drive Bin, where you can restore it for 30 days.\n\n` : '') +
      `Drive sync is then turned off on this device, so your data stays only here` + (user.remember ? '.' : ', and is removed when you close this tab.') + ' Other devices that are still signed in will save a new copy when they sync.')) return;
    if (f) await CFDrive.trash(s, f.id);
    setMeta({ paused: true, dirty: false, base: null, remoteModified: null, syncedAt: null });
    CFStats.event('drive-copy-deleted');
    toast('Drive copy deleted. It is in your Google Drive Bin for 30 days.');
  });
  $('driveOnBtn').onclick = () => driveRun('driveOnBtn', 'Turning on…', async () => {
    await session();
    setMeta({ paused: false, dirty: true, editedAt: Date.now() });
    if (!(await syncNow(false))) throw new Error(syncErr || 'Could not sync.');
    CFStats.event('drive-sync-on');
    toast('Drive sync is on again.');
  });
  $('rememberChk').onchange = e => {
    const on = e.target.checked;
    if (!on && !confirm('Stop keeping your data on this device?\n\nIt stays in your Google Drive. On this device it is removed when you close this tab.' +
        (meta.dirty || meta.paused ? '\n\nWarning: some of your data is not in Google Drive. Choose Cancel and Sync first.' : ''))) { e.target.checked = true; return; }
    const old = user, keepMeta = meta;
    writeArea(old, dataKey(old), null); writeArea(old, metaKey(old), null);
    if (!on) { const all = knownAccounts(); delete all[old.sub]; writeJSON(ACCOUNTS_KEY, all); }
    setUser(Object.assign({}, old, { remember: on }));
    writeArea(user, dataKey(), db); setMeta(keepMeta);
    renderAccount();
    CFStats.event(on ? 'remember-on' : 'remember-off');
    toast(on ? 'This device keeps a copy now: it opens quickly and works offline.' : 'This device no longer keeps your data after the tab closes.');
  };

  /* ---- sign out ---- */
  $('signOutBtn').onclick = () => {
    const r = user.remember;
    $('soText').innerHTML = r ? `Your data stays on this device. It opens again the next time <b>${esc(user.email)}</b> signs in here.`
      : `This device doesn't keep your data, so it is removed from this browser now. Your Google Drive copy stays.`;
    $('soWipeRow').hidden = $('soHint').hidden = !r; $('soWipe').checked = false;
    $('soWarn').hidden = !(meta.dirty || meta.paused);
    openDlg('signOutDlg');
  };
  $('soGo').onclick = () => {
    const wipe = !user.remember || $('soWipe').checked;
    if (wipe && (meta.dirty || meta.paused) && !confirm('Some of your data is not in Google Drive and will be lost from this device. Sign out anyway?')) return;
    if (wipe && user.remember && !confirm(`Remove all of ${user.email}'s Cash Flow data from this device?`)) return;
    const email = user.email;
    if (wipe) { writeArea(user, dataKey(), null); writeArea(user, metaKey(), null); const all = knownAccounts(); delete all[user.sub]; writeJSON(ACCOUNTS_KEY, all); }
    sess = null; clearTimeout(syncTimer); setUser(null);
    db = fresh(); recompile();
    $('signOutDlg').close(); renderGate(); renderAccount();
    CFStats.event(wipe ? 'signout-removed-data' : 'signout');
    toast(wipe ? `Signed out. ${email}'s data was removed from this device.` : `Signed out of ${email}.`);
  };

  /* ---- change Google account: moves the data and the Drive copy to another account ---- */
  let mv = null;
  function moveStep(step, errMsg) {
    mv.step = step;
    const e = errMsg ? `<p class="move-err" role="alert">${esc(errMsg)}</p>` : '';
    const steps = n => `<ol class="move-steps">${[`Confirm your current account (${esc(mv.old.email)}) and sync it`, 'Choose the new Google account', 'Your data is copied to its Google Drive and checked', 'Choose whether to delete the copy in the old account']
      .map((t, i) => `<li class="${i < n ? 'done' : i === n ? 'on' : ''}">${t}</li>`).join('')}</ol>`;
    const B = { cancel: $('moveCancel'), next: $('moveNext') };
    B.cancel.hidden = false; B.next.classList.remove('danger');
    if (step === 'intro') {
      $('moveBody').innerHTML = `<p>Move your Cash Flow data and Google Drive copy from <b>${esc(mv.old.email)}</b> to another Google account.</p>${steps(0)}${e}`;
      B.cancel.textContent = 'Cancel'; B.next.textContent = 'Continue';
    } else if (step === 'pick') {
      $('moveBody').innerHTML = `${steps(1)}<p>Now choose the Google account to move to. If it isn't listed, choose <b>Use another account</b>.</p><p>Cash Flow will move your data (${db.txns.length} transactions).</p>${e}`;
      B.cancel.textContent = 'Cancel'; B.next.textContent = 'Choose new account';
    } else if (step === 'askDelete') {
      $('moveBody').innerHTML = `${steps(3)}<p>Done: your data is now in <b>${esc(user.email)}</b>.</p><p>The old copy is still in <b>${esc(mv.old.email)}</b>'s Google Drive (${fmtWhen(mv.oldFile.modified)}, ${mv.oldFile.txns} transactions). Delete it? It moves to that Drive's Bin for 30 days.</p>${e}`;
      B.cancel.textContent = 'Keep it'; B.next.textContent = 'Delete old copy'; B.next.classList.add('danger');
    } else if (step === 'done') {
      $('moveBody').innerHTML = `<p>All done. You're now signed in as <b>${esc(user.email)}</b>, and your data is in that account's Google Drive.</p>${mv.deleted ? `<p>The old copy was moved to ${esc(mv.old.email)}'s Drive Bin.</p>` : mv.oldFile ? `<p>The old copy was kept in ${esc(mv.old.email)}'s Drive.</p>` : ''}`;
      B.cancel.hidden = true; B.next.textContent = 'Done';
    }
  }
  function moveBusy(on, label) { busy = on; $('moveNext').disabled = $('moveCancel').disabled = on; if (on) $('moveNext').textContent = label; renderAccount(); }
  $('changeAcctBtn').onclick = () => { mv = { old: Object.assign({}, user) }; moveStep('intro'); openDlg('moveDlg'); };
  $('moveCancel').onclick = () => { if (mv && mv.step === 'askDelete') moveStep('done'); else $('moveDlg').close(); };
  $('moveDlg').addEventListener('cancel', e => { if (busy) e.preventDefault(); else if (mv && mv.step === 'askDelete') { e.preventDefault(); moveStep('done'); } });
  $('moveNext').onclick = async () => {
    if (busy || !mv) return;
    const step = mv.step;
    if (step === 'done') return $('moveDlg').close();
    if (step === 'intro') {
      moveBusy(true, 'Checking…');
      try {
        mv.oldSess = await session();
        if (!meta.paused && !(await syncNow(false))) throw new Error(syncErr || 'Could not sync before moving.');
        mv.oldFile = meta.paused ? null : await CFDrive.find(mv.oldSess);
        moveBusy(false); moveStep('pick');
      } catch (e) { moveBusy(false); moveStep('intro', errText(e)); }
      return;
    }
    if (step === 'pick') {
      moveBusy(true, 'Waiting for Google…');
      try {
        const s = await CFDrive.signIn({ selectAccount: true, needDrive: true });
        const u = await CFDrive.userInfo(s);
        if (u.sub === mv.old.sub) { moveBusy(false); return moveStep('pick', `That's ${u.email}, the account you're already using. Choose a different one.`); }
        const target = await CFDrive.find(s);
        const onDevice = readArea(Object.assign({ remember: mv.old.remember }, u), dataKey(u));
        const warn = [target && `${u.email} already has Cash Flow data in its Google Drive (${fmtWhen(target.modified)}, ${target.txns} transactions).`,
          onDevice && onDevice.version === 2 && `${u.email} already has Cash Flow data on this device (${(onDevice.txns || []).length} transactions).`].filter(Boolean);
        if (warn.length && !confirm(`${warn.join('\n')}\n\nReplace it with the data you're moving?`)) { moveBusy(false); return moveStep('pick', 'Nothing was changed. Choose another account, or Cancel.'); }
        $('moveNext').textContent = 'Copying…';
        const source = JSON.parse(JSON.stringify(db)), text = JSON.stringify(source);
        const f = await CFDrive.save(s, text, { txns: source.txns.length, people: source.profiles.length }, target && target.id);
        if (await CFDrive.download(s, f.id) !== text) throw new Error('The copy in the new Google Drive did not match. Nothing was changed on this device; please try again.');
        // switch this device over to the new account
        const rec = { sub: u.sub, email: u.email, name: u.name, given: u.given, remember: !!mv.old.remember };
        writeArea(mv.old, dataKey(mv.old), null); writeArea(mv.old, metaKey(mv.old), null);
        const all = knownAccounts(); delete all[mv.old.sub]; writeJSON(ACCOUNTS_KEY, all);
        writeArea(rec, metaKey(rec), null);
        setUser(rec); sess = s;
        db = source; recompile(); writeArea(rec, dataKey(rec), db);
        setMeta({ base: CFSync.fingerprint(source), remoteModified: f.modifiedTime, syncedAt: new Date().toISOString(), dirty: false, paused: false });
        Object.assign(view, { profile: db.profiles[0].id, acct: 'all', cat: '' });
        initFilters(false); renderAll();
        moveBusy(false); moveStep(mv.oldFile ? 'askDelete' : 'done');
        CFStats.event('account-changed');
        toast(`Moved to ${u.email}.`);
      } catch (e) { moveBusy(false); moveStep('pick', errText(e)); }
      return;
    }
    if (step === 'askDelete') {
      moveBusy(true, 'Deleting…');
      try {
        if (!CFDrive.valid(mv.oldSess)) {
          const s = await CFDrive.signIn({ hint: mv.old.email, needDrive: true });
          if ((await CFDrive.userInfo(s)).sub !== mv.old.sub) throw new Error(`Please choose ${mv.old.email} to delete its old copy.`);
          mv.oldSess = s;
        }
        await CFDrive.trash(mv.oldSess, mv.oldFile.id);
        mv.deleted = true; moveBusy(false); moveStep('done');
        CFStats.event('old-copy-deleted');
      } catch (e) { moveBusy(false); moveStep('askDelete', errText(e)); }
    }
  };

  // load Google's sign-in library ahead of time so the sign-in popup opens straight from a click
  const preloadGoogle = () => { if (CFDrive.configured() && navigator.onLine !== false) CFDrive.preload().then(() => renderGate(), () => renderGate()); renderGate(); };
  window.addEventListener('online', preloadGoogle);
  window.addEventListener('offline', () => renderGate());
  preloadGoogle(); renderAccount();
  // opening the app: offer to fetch changes made on other devices (needs a tap, because Google's sign-in can't run unprompted)
  if (syncOn() && navigator.onLine !== false) {
    if (meta.dirty) scheduleSync();
    else { setTimeout(() => toast('Tap Sync to get the latest from your Google Drive.', 8000, { label: 'Sync', fn: () => syncNow(true) }), 600); }
  }

  /* ================= anonymous usage counts: Settings switch ================= */
  function renderStatsRow() {
    $('statsRow').hidden = !CFStats.configured();
    $('statsChk').checked = CFStats.enabled();
  }
  $('statsChk').onchange = e => {
    CFStats.setEnabled(e.target.checked);
    toast(e.target.checked ? 'Thanks! Anonymous usage counts are on.' : 'Anonymous usage counts are off on this device.');
  };

  /* ================= admin: product insights (anonymous counts from GoatCounter) =================
     Shown only to admin accounts: config.js holds SHA-256 fingerprints of the admin emails (never the emails).
     Reading the stats needs a GoatCounter API key that the admin pastes once; it's kept only in this browser.
     There is no personal data to show: the app only ever sends fixed event names (see analytics.js). */
  const ADMIN_HASHES = (((window.CF_CONFIG || {}).adminHashes) || []).map(String);
  const GC_KEY = 'cashflow.gcKey';
  let isAdmin = false, inChart = null, inLoading = false, inData = null;
  async function checkAdmin() {
    let ok = false;
    try {
      if (user && user.email && ADMIN_HASHES.length && window.crypto && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.email.trim().toLowerCase()));
        ok = ADMIN_HASHES.includes([...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''));
      }
    } catch (e) { ok = false; }
    isAdmin = ok;
    document.querySelectorAll('.nav-admin').forEach(b => (b.hidden = !ok));
    if (!ok) { inData = null; if (view.page === 'insights') goPage('dash'); }
  }
  const gcKey = () => { try { return localStorage.getItem(GC_KEY) || ''; } catch (e) { return ''; } };
  async function gcGet(path, params) {
    let r;
    try {
      r = await fetch(`https://${CFStats.code}.goatcounter.com/api/v0/${path}?${new URLSearchParams(params)}`,
        { headers: { Authorization: 'Bearer ' + gcKey(), 'Content-Type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    } catch (e) { throw new Error("Couldn't reach GoatCounter. Check your internet connection."); }
    if (r.status === 401) throw new Error('GoatCounter rejected the API key. Check it, or create a new one and paste it again.');
    if (r.status === 403) throw new Error('This API key may not read statistics. Create a key with the "Read statistics" permission.');
    if (r.status === 429) throw new Error('GoatCounter is busy (too many requests). Try again in a few seconds.');
    if (!r.ok) throw new Error(`GoatCounter error ${r.status}.`);
    return r.json();
  }
  const isoHour = t => { const d = new Date(t); d.setUTCMinutes(0, 0, 0); return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); };
  function inStatus(msg, isErr) { const el = $('inStatus'); el.hidden = !msg; el.textContent = msg || ''; el.classList.toggle('move-err', !!isErr); }
  function renderInsights() {
    if (!isAdmin) return;
    if (!CFStats.configured()) {
      $('inKeyBox').hidden = $('inBody').hidden = true;
      return inStatus('Usage counting is not set up yet: add GOATCOUNTER_CODE to .env and to the GitHub repository variables (see README).', true);
    }
    $('inKeyWhere').textContent = `${CFStats.code}.goatcounter.com`;
    const hasKey = !!gcKey();
    $('inKeyBox').hidden = hasKey;
    if (!hasKey) { $('inBody').hidden = true; return inStatus(''); }
    if (inData && inData.days === +$('inRange').value) drawInsights(inData); else loadInsights();
  }
  async function loadInsights() {
    if (inLoading || !gcKey()) return;
    inLoading = true; $('inRefresh').disabled = true;
    const days = +$('inRange').value;
    inStatus('Loading insights…');
    try {
      const range = { start: isoHour(Date.now() - days * 864e5), end: isoHour(Date.now() + 3600e3) };
      const pause = () => new Promise(r => setTimeout(r, 300)); // GoatCounter allows 4 requests a second
      const hits = [];
      let page = await gcGet('stats/hits', Object.assign({ limit: 100, group: 'day' }, range));
      hits.push(...(page.hits || []));
      for (let n = 0; page.more && n < 4; n++) {
        await pause();
        page = await gcGet('stats/hits', Object.assign({ limit: 100, group: 'day', exclude_paths: hits.map(h => h.path_id).join(',') }, range));
        hits.push(...(page.hits || []));
      }
      await pause(); const total = await gcGet('stats/total', range);
      await pause(); const systems = await gcGet('stats/systems', Object.assign({ limit: 8 }, range));
      await pause(); const browsers = await gcGet('stats/browsers', Object.assign({ limit: 8 }, range));
      inData = { days, hits, total, systems: systems.stats || [], browsers: browsers.stats || [], at: new Date() };
      drawInsights(inData);
    } catch (e) {
      $('inBody').hidden = true; inStatus(e.message || 'Could not load insights.', true);
    } finally { inLoading = false; $('inRefresh').disabled = false; }
  }
  const LABELS = {
    'app-open': 'App opened', 'first-open-device': 'New device (first open)', 'app-installed': 'App installed',
    'open-installed-app': 'Opened as installed app', 'open-in-browser': 'Opened in a browser',
    'signin-remembered': 'Sign-in: remembered device', 'signin-shared-computer': 'Sign-in: shared computer', 'signin-moved-old-data': 'Sign-in moved old data',
    'import-ok-pdf': 'PDF imported', 'import-ok-csv': 'CSV imported', 'import-ok-excel': 'Excel imported',
    'import-failed-pdf': 'PDF could not be read', 'import-failed-csv': 'CSV could not be read', 'import-failed-excel': 'Excel could not be read',
    'import-empty-pdf': 'PDF had no transactions', 'import-empty-csv': 'CSV had no transactions', 'import-empty-excel': 'Excel had no transactions',
    'import-wrong-account': 'Wrong account blocked', 'import-gaps-found': 'Balance gaps found',
    'download-csv': 'CSV', 'download-excel': 'Excel', 'download-pdf': 'PDF statement',
    'person-added': 'Person added', 'bank-account-added': 'Bank account added', 'manual-transaction-added': 'Transaction added by hand',
    'transaction-deleted': 'Deleted a transaction *', 'category-changed': 'Changed a category *', 'categories-reapplied': 'Re-applied categories *',
    'remember-on': 'Remember device turned on', 'remember-off': 'Remember device turned off', 'signout': 'Signed out', 'signout-removed-data': 'Signed out and removed data',
    'account-changed': 'Changed Google account', 'old-copy-deleted': 'Deleted old account copy', 'drive-copy-deleted': 'Deleted Drive copy',
    'drive-sync-on': 'Turned Drive sync back on', 'all-data-deleted': 'Deleted all data',
    'sync-ok': 'Synced successfully *', 'sync-brought-changes': 'Sync brought changes from another device *',
    'error-js': 'App error *',
  };
  const label = p => LABELS[p] || (p.startsWith('/') ? p.slice(1).replace(/^./, c => c.toUpperCase())
    : p.startsWith('sync-error-') ? `Sync failed: ${p.slice(11).replace(/-/g, ' ')} *` : p.startsWith('version-') ? 'Version ' + p.slice(8) : p.replace(/-/g, ' '));
  function countList(el, rows) {
    rows = rows.filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
    if (!rows.length) { el.innerHTML = '<div class="none">Nothing yet in this period.</div>'; return; }
    const max = rows[0][1], color = getComputedStyle(document.documentElement).getPropertyValue('--income').trim() || '#2a78d6';
    el.innerHTML = rows.map(([name, v]) => `<div class="bar-row" title="${esc(name)}: ${v}">
      <span class="bar-name">${esc(name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (v / max) * 100)}%;background:${color}"></span></span>
      <span class="bar-val">${v.toLocaleString('en-IN')}</span></div>`).join('');
  }
  function drawInsights(d) {
    const by = new Map();
    for (const h of d.hits) by.set(h.path, (by.get(h.path) || 0) + (Number(h.count) || 0));
    const n = p => by.get(p) || 0;
    const rows = (pred) => [...by].filter(([p]) => pred(p)).map(([p, v]) => [label(p), v]);
    const kpi = (ic, cls, name, val, sub) => `<div class="kpi"><span class="k-ic ${cls}"><span class="ms">${ic}</span></span><span class="k-label">${name}</span><span class="k-val">${val.toLocaleString('en-IN')}</span><span class="k-sub">${sub}</span></div>`;
    const visits = Number(d.total.total) || 0;
    $('inKpis').innerHTML = kpi('group', 'inc', 'Visits', visits, 'Each browser counted once per 8 hours')
      + kpi('space_dashboard', 'net', 'App opens', n('app-open'), `${n('open-installed-app')} as installed app`)
      + kpi('install_mobile', 'rate', 'New devices', n('first-open-device'), `${n('app-installed')} installs`)
      + kpi('account_circle', 'exp', 'Sign-ins', n('signin-remembered') + n('signin-shared-computer'), `${n('signin-shared-computer')} on shared computers`);
    // app opens per day
    const opens = d.hits.find(h => h.path === 'app-open'), perDay = new Map();
    for (const s of (opens && opens.stats) || []) {
      const v = s.daily != null ? Number(s.daily) : (s.hourly || []).reduce((a, b) => a + (Number(b) || 0), 0);
      if (s.day) perDay.set(String(s.day).slice(0, 10), (perDay.get(String(s.day).slice(0, 10)) || 0) + v);
    }
    const labels = [], values = [];
    for (let i = d.days - 1; i >= 0; i--) { const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); labels.push(fmtDate(day).replace(/ \d{4}$/, '')); values.push(perDay.get(day) || 0); }
    if (inChart) { inChart.destroy(); inChart = null; }
    if (window.Chart) {
      const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
      inChart = new Chart($('inChart'), { type: 'bar', data: { labels, datasets: [{ label: 'App opens', data: values, backgroundColor: css('--income') || '#2a78d6', borderRadius: 4, maxBarThickness: 28 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } },
          scales: { x: { grid: { display: false }, ticks: { color: css('--text-2'), maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
            y: { beginAtZero: true, ticks: { precision: 0, color: css('--text-2') }, grid: { color: css('--grid') } } } } });
    }
    countList($('inDevices'), ['open-installed-app', 'open-in-browser', 'signin-remembered', 'signin-shared-computer', 'app-installed', 'signin-moved-old-data'].map(p => [label(p), n(p)]));
    countList($('inScreens'), rows(p => p.startsWith('/')));
    countList($('inImports'), rows(p => p.startsWith('import-')));
    countList($('inDownloads'), rows(p => p.startsWith('download-')));
    countList($('inAccount'), rows(p => /^(person-added|bank-account-added|manual-transaction-added|transaction-deleted|category-changed|categories-reapplied|remember-|signout|account-changed|old-copy-deleted|drive-|all-data-deleted)/.test(p)));
    countList($('inSync'), rows(p => p.startsWith('sync-')));
    countList($('inErrors'), rows(p => p === 'error-js' || p.startsWith('sync-error-') || p.startsWith('import-failed-') || p.startsWith('import-empty-') || p === 'import-gaps-found'));
    countList($('inVersions'), rows(p => p.startsWith('version-')));
    countList($('inSystems'), d.systems.map(s => [s.name || 'Unknown', Number(s.count) || 0]));
    countList($('inBrowsers'), d.browsers.map(s => [s.name || 'Unknown', Number(s.count) || 0]));
    $('inBody').hidden = false;
    inStatus(`Last ${d.days} days · updated ${d.at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}. Items marked * are counted at most once per app session.`);
  }
  $('inRange').onchange = loadInsights;
  $('inRefresh').onclick = loadInsights;
  $('inKeySave').onclick = () => {
    const k = $('inKey').value.trim();
    if (k.length < 20 || /\s/.test(k)) return toast('That doesn\'t look like a GoatCounter API key.');
    try { localStorage.setItem(GC_KEY, k); } catch (e) { return toast('This browser could not save the key.'); }
    $('inKey').value = ''; inData = null; renderInsights();
  };
  $('inKeyForget').onclick = () => {
    if (!confirm('Remove the GoatCounter API key from this device? You can paste it again any time.')) return;
    try { localStorage.removeItem(GC_KEY); } catch (e) { /* ignore */ }
    inData = null; if (inChart) { inChart.destroy(); inChart = null; } renderInsights();
  };

  /* ================= sample data ================= */
  function sampleData() {
    const out = []; let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const pick = a => a[Math.floor(rnd() * a.length)];
    const now = new Date();
    let bal = 40000;
    for (let k = 13; k >= 0; k--) {
      const d0 = new Date(now.getFullYear(), now.getMonth() - k, 1);
      const y = d0.getFullYear(), m = d0.getMonth(), days = new Date(y, m + 1, 0).getDate();
      const last = k === 0 ? Math.min(now.getDate(), days) : days;
      const month = [];
      const add = (d, desc, amount, type) => { if (d <= last) month.push({ date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, desc, amount: Math.round(amount * 100) / 100, type }); };
      add(1, 'NEFT CR-ACME TECHNOLOGIES PVT LTD-SALARY', 82000 + (m === 3 ? 15000 : 0), 'credit');
      add(3, 'UPI/DR/4123/NOBROKER RENT/YESB/nobroker@ybl', 18000, 'debit');
      add(5, 'ACH D- ZERODHA BROKING SIP', 10000, 'debit');
      add(7, 'BILLDESK*TNEB ELECTRICITY', 900 + rnd() * 1400, 'debit');
      add(8, 'UPI/DR/4124/AIRTEL/AIRP/airtel@airtel', 799, 'debit');
      add(10, 'NACH DR HDFC BANK CAR LOAN EMI', 9800, 'debit');
      add(12, 'NETFLIX.COM', 649, 'debit');
      add(15, 'ATW-512345XXXXXX1234-CHENNAI', pick([2000, 3000, 5000]), 'debit');
      if (m % 3 === 2) add(28, 'BY TRANSFER INT PD SB ACCOUNT', 400 + rnd() * 300, 'credit');
      if (rnd() > 0.6) add(20, 'UPI/CR/4129/FREELANCE PROJECT/ICIC', 8000 + rnd() * 12000, 'credit');
      for (let i = 0; i < 26; i++) {
        const [desc, lo, hi] = pick([
          ['UPI/DR/41/SWIGGY/YESB/swiggy@ybl', 180, 650], ['UPI/DR/41/ZOMATO/HDFC/zomato@hdfcbank', 200, 800],
          ['UPI/DR/41/BLINKIT/YESB/blinkit@ybl', 150, 1400], ['UPI/DR/41/ZEPTO/YESB/zepto@ybl', 120, 900],
          ['UPI/DR/41/AMAZON PAY/YESB/amazon@apl', 300, 4500], ['UPI/DR/41/UBER INDIA/ICIC/uber@icici', 120, 600],
          ['UPI/DR/41/HPCL PETROL PUMP/SBIN', 500, 2500], ['UPI/DR/41/APOLLO PHARMACY/ICIC', 150, 1200],
          ['UPI/DR/41/MURUGAN STORES/SBIN', 50, 700], ['UPI/DR/41/STARBUCKS/HDFC', 250, 700], ['POS 4123 DMART CHENNAI', 900, 3500],
        ]);
        add(1 + Math.floor(rnd() * days), desc, lo + rnd() * (hi - lo), 'debit');
      }
      if (m === 9 || m === 10) add(18, 'FLIPKART INTERNET PVT LTD BIG BILLION', 12000 + rnd() * 9000, 'debit');
      add(25, 'IMPS/P2A/SELF TRANSFER TO SAVINGS', 5000, 'debit');
      month.sort((a, b) => a.date.localeCompare(b.date) || (a.type === 'credit' ? -1 : 1));
      for (const t of month) { bal += t.type === 'credit' ? t.amount : -t.amount; t.balance = Math.round(bal * 100) / 100; out.push(t); }
    }
    return out;
  }
  function loadSample() {
    const profileId = view.profile === 'all' ? db.profiles[0].id : view.profile;
    let acct = db.accounts.find(a => a.name === 'Sample savings');
    if (!acct) { acct = { id: uid('a'), profileId, name: 'Sample savings', bank: 'Demo Bank', last4: '0000' }; db.accounts.push(acct); }
    const stmtId = uid('s'), data = sampleData();
    const r = addTransactions(data, acct, stmtId);
    if (r.added) db.statements.push({ id: stmtId, accountId: acct.id, fileName: 'Sample statement', added: new Date().toISOString(), count: r.added, from: r.from, to: r.to, check: Object.assign(FT.reconcile(data, 40000), { unparsed: [] }) });
    save(); initFilters(false); renderAll();
    if (r.added) toast('Sample data loaded. Delete the "Sample savings" account in Settings when you\'re done.');
  }
  $('sampleBtn').onclick = loadSample;

  /* ================= start ================= */
  if (!window.Chart) toast('The chart library failed to load. Try reloading the page.', 8000);

  /* ================= installable app (PWA) ================= */
  let installEvt = null;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function renderInstall() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const btn = $('installBtn'), hint = $('installHint');
    btn.hidden = !installEvt;
    if (standalone()) hint.textContent = 'Cash Flow is installed on this device. ✓';
    else if (location.protocol === 'file:') hint.textContent = 'To install it as an app, open Cash Flow from a web address (for example http://localhost or a hosted link) instead of a file. See README.md.';
    else if (installEvt) hint.textContent = 'Install Cash Flow on this device to open it like a regular app, even offline.';
    else if (ios) hint.textContent = 'On iPhone / iPad: tap the Share button in Safari, then "Add to Home Screen".';
    else hint.textContent = 'Use your browser menu: "Install app" (Chrome / Edge), or "Add to Home screen" (Android).';
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { installEvt = null; renderInstall(); toast('Cash Flow installed.'); CFStats.event('app-installed'); });
  $('installBtn').onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => null);
    installEvt = null; renderInstall();
  };
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      const offerUpdate = w => toast('A new version of Cash Flow is ready.', 15000, { label: 'Reload', fn: () => w.postMessage('skipWaiting') });
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); });
      });
    }).catch(() => { /* offline support unavailable; the app still works */ });
    // reload only when an UPDATE takes over (not on the very first install)
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
  renderInstall();
  // ask the browser not to clear this app's data when the device is low on space (Chrome/Edge/Android/Firefox)
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(p => p || navigator.storage.persist()).catch(() => {}); } catch (e) { /* not supported */ }
  initFilters(false);
  if (location.hash === '#demo' && !db.txns.length) loadSample();
  applyTheme(getTheme());
  renderAll();
  // anonymous usage counts for this app open (fixed names only; see analytics.js)
  CFStats.event('app-open');
  CFStats.event(standalone() ? 'open-installed-app' : 'open-in-browser');
  CFStats.event('version-' + APP_VERSION);
  CFStats.page(gated() ? 'signin' : 'dashboard');
  try { if (!localStorage.getItem('cashflow.seen')) { localStorage.setItem('cashflow.seen', '1'); CFStats.event('first-open-device'); } } catch (e) { /* ignore */ }
  window.addEventListener('error', () => CFStats.once('error-js'));
  window.addEventListener('unhandledrejection', () => CFStats.once('error-js'));
  checkAdmin();
  save({ noSync: true }); // persists a migrated v1 store in the new format (skipped while nobody is signed in)
})();
