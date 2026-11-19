// Anonymous usage counts (privacy of every request), opt-out, Do Not Track, admin Insights page and its key in Drive.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as H from './harness.mjs';
const { $t, ACCTS, APP_VERSION, DL, GIS_STUB, GOOD_KEY, ORIGIN, OUT, ROOT, apiCalls, clickToast, cors, counts, dataKey, dialogPlan, dialogs, drive, errors, ev, filesOf, gateSignIn, go, goat, isGated, json, ls, meta, moveClick, newPage, onPaused, parseMultipart, resumable, route, send, seq, serveApp, settings, sha, sleep, state, txnsIn, types, upsert, ver, waitFor, ws } = H;
let pass = 0; const ok = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); pass++; console.log('  ✓', msg); };
const names = () => counts.map(c => c.q.p);
const settle = () => sleep(400);
async function signInGate(sid, acct, remember) { await ev(sid, `document.getElementById('gateRemember').checked=${!!remember}`); await gateSignIn(sid, acct); await sleep(300); }
async function addTx(sid, desc, amt) {
  await ev(sid, `document.querySelector('.nav-item[data-page=dash]').click(); document.getElementById('addTxBtn').click()`);
  await ev(sid, `(()=>{const $=id=>document.getElementById(id); $('tdDate').value='2026-11-10'; $('tdType').value='debit'; $('tdType').dispatchEvent(new Event('change')); $('tdDesc').value=${JSON.stringify(desc)}; $('tdAmt').value='${amt}'; $('txForm').requestSubmit();})()`);
  await sleep(300);
}
try {
  /* ===== 1. counts on open, sign-in, actions ===== */
  console.log('1. what gets counted');
  const A = await newPage();
  await go(A, '#demo'); await settle();
  ok(['app-open', 'open-in-browser', 'version-' + APP_VERSION, '/signin', 'first-open-device'].every(n => names().includes(n)), 'app open counted: app-open, browser, version, sign-in screen, new device');
  ok(await ev(A, `!document.getElementById('gateStats').hidden`), 'sign-in screen mentions anonymous counts');
  await signInGate(A, 'a', true); await settle();
  ok(names().includes('signin-remembered'), 'sign-in counted (remembered device)');
  await ev(A, `location.hash = '#demo'`); await send('Page.reload', {}, A); await sleep(400);
  await waitFor(A, `document.readyState==='complete' && !!window.CFDrive`); await settle();
  ok(JSON.parse(await ls(A, dataKey('a'))).txns.length > 100, 'sample data loaded for the signed-in account');
  await addTx(A, 'Secret dinner at Alice Café', 1234.56); await settle();
  ok(names().includes('manual-transaction-added'), 'manual transaction counted (name only)');
  await settings(A); await settle();
  ok(names().includes('/settings'), 'screen view counted');
  await ev(A, `document.getElementById('downloadBtn').click()`); await sleep(200);
  await ev(A, `document.getElementById('exCsv').click()`); await settle();
  await ev(A, `document.getElementById('exPdf').click()`); await sleep(2500);
  ok(names().includes('download-csv') && names().includes('download-pdf'), 'downloads counted by format');
  await ev(A, `document.getElementById('exportDlg').close()`);
  await sleep(2500);
  ok(names().filter(n => n === 'sync-ok').length === 1, 'sync counted once per session, not on every save');
  const before = counts.length;
  await go(A); await settle();
  ok(!names().slice(before).includes('first-open-device'), '"new device" counted only once per device');

  /* ===== 2. privacy of every request ===== */
  console.log('2. privacy of every request sent');
  ok(counts.length >= 12, `${counts.length} count requests captured`);
  ok(counts.every(c => Object.keys(c.q).every(k => ['p', 't', 'e', 'rnd'].includes(k))), 'only p, t, e, rnd parameters (no screen size, no referrer, no IDs)');
  ok(counts.every(c => /^\/?[a-z0-9.-]+$/.test(c.q.p) && c.q.t === c.q.p), 'event names are fixed lowercase words');
  const blob = JSON.stringify(counts.map(c => c.q)).toLowerCase();
  ok(!/alice|bob|gmail|@|café|cafe|dinner|secret|1234|sample|savings|0000|demo bank|1001/.test(blob), 'no names, emails, descriptions, amounts, account names/numbers or Google IDs in any request');
  ok(counts.every(c => !c.headers.referer && !c.headers.cookie), 'no referrer and no cookies sent');
  ok(!names().some(n => n.includes('insights')), 'admin page views are not counted');

  /* ===== 3. opt-out ===== */
  console.log('3. opt-out');
  await settings(A);
  ok(await ev(A, `!document.getElementById('statsRow').hidden && document.getElementById('statsChk').checked`), 'Settings shows the switch, on by default');
  await ev(A, `document.getElementById('statsChk').click()`);
  const n0 = counts.length;
  await addTx(A, 'After opt-out', 10); await ev(A, `document.querySelector('.nav-item[data-page=tx]').click()`); await go(A); await settle();
  ok(counts.length === n0, 'switched off: nothing is sent (actions, screens, app open)');
  ok(await ls(A, 'cashflow.stats') === 'off' && await ev(A, `document.getElementById('gate').hidden && !document.getElementById('statsChk').checked`), 'choice remembered on this device');
  await settings(A); await ev(A, `document.getElementById('statsChk').click()`);
  await ev(A, `document.querySelector('.nav-item[data-page=tx]').click()`); await settle();
  ok(counts.length > n0, 'switched back on: counting resumes');

  /* ===== 4. browser privacy signal ===== */
  console.log('4. Do Not Track / Global Privacy Control');
  const D = await newPage();
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true });" }, D);
  const n1 = counts.length;
  await go(D); await settle();
  ok(counts.length === n1 && await ev(D, `document.getElementById('gateStats').hidden`), 'privacy signal: off by default, nothing sent, no notice shown');

  /* ===== 5. not configured ===== */
  console.log('5. not configured');
  state.cfg = Object.assign({}, state.cfg, { goatcounterCode: '' });
  const E = await newPage(); const n2 = counts.length;
  await go(E); await signInGate(E, 'b', false); await settings(E); await settle();
  ok(counts.length === n2 && await ev(E, `document.getElementById('statsRow').hidden`), 'no GoatCounter code: nothing sent, no switch shown');
  ok(await ev(E, `[...document.querySelectorAll('.nav-admin')].every(b => b.hidden)`), 'non-admin (Bob): no Insights tab');
  state.cfg = Object.assign({}, state.cfg, { goatcounterCode: 'test' });

  /* ===== 6. admin Insights ===== */
  console.log('6. admin Insights');
  await go(A); await sleep(300);
  ok(await ev(A, `[...document.querySelectorAll('.nav-admin')].every(b => !b.hidden)`), 'admin (Alice): Insights tab shown');
  const cfgText = await ev(A, `fetch('/config.js').then(r => r.text())`);
  ok(!cfgText.includes('alice@gmail.com') && cfgText.includes(sha('alice@gmail.com')), 'published config.js holds only the admin SHA-256 fingerprint, not the email');
  apiCalls.length = 0;
  await ev(A, `document.querySelector('.nav-item[data-page=insights]').click()`); await sleep(200);
  ok(await ev(A, `!document.getElementById('inKeyBox').hidden && document.getElementById('inBody').hidden`) && apiCalls.length === 0, 'asks for the API key first; no calls without it');
  ok((await ev(A, `document.getElementById('inKeyWhere').textContent`)) === 'test.goatcounter.com', 'tells you where to create the key');
  await ev(A, `document.getElementById('inKey').value='short'; document.getElementById('inKeySave').click()`);
  ok((await ev(A, `document.getElementById('toastMsg').textContent`)).includes("doesn't look like"), 'obviously wrong key rejected');
  await ev(A, `document.getElementById('inKey').value='wrong-key-000000000000000000'; document.getElementById('inKeySave').click()`);
  await waitFor(A, `!document.getElementById('inStatus').hidden && document.getElementById('inStatus').textContent.includes('rejected')`);
  ok(true, 'key GoatCounter rejects → clear message');
  await ev(A, `document.getElementById('inKeyForget').click()`); await sleep(600);
  await ev(A, `document.getElementById('inKey').value=${JSON.stringify(GOOD_KEY)}; document.getElementById('inKeySave').click()`);
  await waitFor(A, `!document.getElementById('inBody').hidden`, 10000);
  ok(apiCalls.filter(c => c.auth === 'Bearer ' + GOOD_KEY).length >= 4 && apiCalls.every(c => !JSON.stringify(c.q).includes(GOOD_KEY)), 'stats read with the key in the Authorization header, never in the URL');
  const kpis = await ev(A, `document.getElementById('inKpis').innerText`);
  ok(/Visits\s*21/.test(kpis) && /App opens\s*12/.test(kpis) && /New devices\s*2/.test(kpis) && /Sign-ins\s*3/.test(kpis), 'KPIs: visits, app opens, new devices, sign-ins');
  ok(await ev(A, `!!document.querySelector('#inChart') && Chart.getChart(document.getElementById('inChart')).data.datasets[0].data.slice(-2).join() === '5,7'`), 'opens-per-day chart has the daily numbers');
  const lists = await ev(A, `document.getElementById('inBody').innerText`);
  ok(['PDF statement', 'PDF imported', 'PDF could not be read', 'Sync failed: offline', 'Version ' + APP_VERSION, 'Opened as installed app', 'Android', 'Chrome', 'Dashboard'].every(t => lists.includes(t)), 'feature, import, sync, problem, version, device, OS and browser lists filled');
  ok(!/@|alice|bob|₹/.test(lists.toLowerCase()), 'nothing personal or financial on the page');
  const recentStart = apiCalls[apiCalls.length - 1].q.start;
  await ev(A, `document.getElementById('inRange').value='7'; document.getElementById('inRange').dispatchEvent(new Event('change'))`);
  await waitFor(A, `document.getElementById('inStatus').textContent.startsWith('Last 7 days')`, 10000);
  ok(apiCalls[apiCalls.length - 1].q.start > recentStart && /T\d\d:00:00Z$/.test(apiCalls[apiCalls.length - 1].q.start), 'period switch reloads (hour-rounded start)');
  const adminFile = () => [...drive.files.values()].find(f => f.owner === 'a' && !f.trashed && f.appProperties.cashflowAdmin === '1');
  ok(await ls(A, 'cashflow.gcKey.1001') === GOOD_KEY, 'key cached on this (remembered) device');
  ok(adminFile() && JSON.parse(adminFile().content).goatcounterKey === GOOD_KEY && adminFile().name === 'Cash Flow admin settings.json', 'key saved in a private file in the admin\'s own Drive');
  ok(![...drive.files.values()].filter(f => f.appProperties.cashflowBackup === '1').some(f => f.content.includes(GOOD_KEY)), 'key is not inside the Cash Flow data file');
  ok(filesOf('a').filter(f => f.appProperties.cashflowBackup === '1').length === 1, 'data sync unaffected: still one data file');

  /* another device: key arrives from Drive by itself */
  console.log('7. key follows the admin to other devices');
  const F = await newPage(); await go(F); await signInGate(F, 'a', true); await sleep(1500);
  apiCalls.length = 0;
  await ev(F, `document.querySelector('.nav-item[data-page=insights]').click()`);
  await waitFor(F, `!document.getElementById('inBody').hidden`, 10000);
  ok(apiCalls.length >= 4 && await ls(F, 'cashflow.gcKey.1001') === GOOD_KEY, 'new laptop: Insights opens without pasting (key fetched from Drive)');
  const G = await newPage(); await go(G); await signInGate(G, 'a', false); await sleep(1500);
  await ev(G, `document.querySelector('.nav-item[data-page=insights]').click()`);
  await waitFor(G, `!document.getElementById('inBody').hidden`, 10000);
  ok(await ls(G, 'cashflow.gcKey.1001') === null && await ev(G, `sessionStorage.getItem('cashflow.gcKey.1001')`) === GOOD_KEY, 'shared computer: key kept only for this tab');
  await go(F); await sleep(300);
  await ev(F, `localStorage.removeItem('cashflow.gcKey.1001'); document.querySelector('.nav-item[data-page=insights]').click()`); await sleep(300);
  ok(await ev(F, `!document.getElementById('inKeyBox').hidden && document.getElementById('inStatus').textContent.includes('Get my key from Google Drive')`), 'no Google session yet: offers "Get my key from Google Drive"');
  await ev(F, `document.getElementById('inKeyDrive').click()`);
  await waitFor(F, `!document.getElementById('inBody').hidden`, 10000);
  ok(true, 'one tap on "Get my key from Google Drive" loads Insights');
  await ev(F, `document.getElementById('inKeyForget').click()`);
  await waitFor(F, `!document.getElementById('inKeyBox').hidden`);
  await sleep(500);
  ok(!adminFile() && await ls(F, 'cashflow.gcKey.1001') === null, '"Remove API key": gone from the device and moved to the Drive Bin');

  /* screenshots */
  const shot = async (sid, name, w, dark) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 844 : 1100, deviceScaleFactor: 2, mobile: w < 600 }, sid);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sid);
    await ev(sid, `document.getElementById('toast').hidden=true;` + (name.startsWith('insights') ? 'window.scrollTo(0,0)' : `document.getElementById('statsRow').scrollIntoView({block:'center'})`)); await sleep(500);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    return ev(sid, `document.documentElement.scrollWidth <= innerWidth`);
  };
  await shot(A, 'insights-desktop', 1280, false);
  ok(await shot(A, 'insights-phone', 390, false), 'Insights fits phone width');
  await shot(A, 'insights-dark-desktop', 1280, true);
  await settings(A); await ev(A, `document.getElementById('statsRow').scrollIntoView({block:'center'})`);
  await shot(A, 'stats-switch-phone', 390, false);
} catch (e) { console.log('\n✗', e.message); process.exitCode = 1; }
console.log(`\n${pass} checks passed. Page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
ws.close();
