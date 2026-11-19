// Drive as main storage: sync and merge across devices, remember-this-device, offline, delete Drive copy, sign out, change account, downloads.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as H from './harness.mjs';
const { $t, ACCTS, APP_VERSION, DL, GIS_STUB, GOOD_KEY, ORIGIN, OUT, ROOT, apiCalls, clickToast, cors, counts, dataKey, dialogPlan, dialogs, drive, errors, ev, filesOf, gateSignIn, go, goat, isGated, json, ls, meta, moveClick, newPage, onPaused, parseMultipart, resumable, route, send, seq, serveApp, settings, sha, sleep, state, txnsIn, types, upsert, ver, waitFor, ws } = H;
let pass = 0; const ok = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); pass++; console.log('  ✓', msg); };
const statusText = sid => ev(sid, `document.getElementById('driveStatus').textContent`);
const lsKeys = sid => ev(sid, `Object.keys(localStorage)`);
const ssGet = (sid, k) => ev(sid, `sessionStorage.getItem(${JSON.stringify(k)})`);
const driveData = k => { const f = filesOf(k)[0]; return f ? JSON.parse(f.content) : null; };
const localData = async (sid, k, session) => JSON.parse(session ? await ssGet(sid, dataKey(k)) : await ls(sid, dataKey(k)));
const descs = d => d.txns.map(t => t.desc);
const idle = sid => waitFor(sid, `!document.getElementById('syncBtn').classList.contains('spin')`, 10000);
const metaExpr = `(()=>{ for (const st of [localStorage, sessionStorage]) for (const k of Object.keys(st)) if (k.startsWith('cashflow.sync.')) return JSON.parse(st.getItem(k)); return {}; })()`;
async function settled(sid) { await sleep(300); await waitFor(sid, `!${metaExpr}.dirty && !document.getElementById('syncBtn').classList.contains('spin')`, 15000); await sleep(100); }
async function addTx(sid, desc, amt) {
  await ev(sid, `document.querySelector('.nav-item[data-page=dash]').click(); document.getElementById('addTxBtn').click()`);
  await ev(sid, `(()=>{const $=id=>document.getElementById(id); $('tdDate').value='2026-11-10'; $('tdType').value='debit'; $('tdType').dispatchEvent(new Event('change')); $('tdDesc').value=${JSON.stringify(desc)}; $('tdAmt').value='${amt}'; $('txForm').requestSubmit();})()`);
  await waitFor(sid, `[...Object.keys(localStorage), ...Object.keys(sessionStorage)].some(k => k.startsWith('cashflow.v2.') && (localStorage.getItem(k) || sessionStorage.getItem(k)).includes(${JSON.stringify(JSON.stringify(desc))}))`);
}
async function delTx(sid, desc) {
  await ev(sid, `(()=>{ document.querySelector('.nav-item[data-page=tx]').click(); })()`);
  const id = await ev(sid, `(()=>{ for (const k of [...Object.keys(localStorage), ...Object.keys(sessionStorage)]) { if (!k.startsWith('cashflow.v2.')) continue; const d = JSON.parse(localStorage.getItem(k) || sessionStorage.getItem(k)); const t = d.txns.find(t => t.desc === ${JSON.stringify(desc)}); if (t) return t.id; } })()`);
  await waitFor(sid, `!!document.querySelector('.tx-item[data-id="' + CSS.escape(${JSON.stringify(id)}) + '"]')`);
  await ev(sid, `document.querySelector('.tx-item[data-id="' + CSS.escape(${JSON.stringify(id)}) + '"]').click(); document.getElementById('teDel').click()`);
}
async function manualSync(sid) {
  await ev(sid, `document.getElementById('toast').hidden=true; document.getElementById('syncBtn').click()`);
  await sleep(150); await idle(sid);
  return ev(sid, `document.getElementById('toast').hidden ? '' : document.getElementById('toastMsg').textContent`);
}
async function signInGate(sid, acct, remember) {
  await ev(sid, `document.getElementById('gateRemember').checked=${!!remember}`);
  await gateSignIn(sid, acct);
  await sleep(200); await idle(sid);
}
const waitFile = async (suffix, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const f = fs.readdirSync(DL).find(n => n.endsWith(suffix) && !n.endsWith('.crdownload')); if (f) { await sleep(150); return path.join(DL, f); } await sleep(100); } throw new Error('no download ' + suffix); };

try {
  /* ===== 1. first device: remembered, saves to Drive ===== */
  console.log('1. laptop (remembered)');
  const A = await newPage();
  state.configured = false; await go(A);
  ok(await ev(A, `document.getElementById('gate').hidden && !document.getElementById('driveOff').hidden && document.getElementById('syncBtn').hidden`), 'without sign-in set up: no sign-in screen, no sync button, data stays in this browser');
  state.configured = true; await go(A);
  ok(await ev(A, `!document.getElementById('gateRemember').checked`), '"Remember this device" is off by default in a browser tab');
  dialogs.length = 0;
  await signInGate(A, 'a', true);
  ok(!(await isGated(A)) && !dialogs.length, 'signed in; fresh start, no questions asked');
  await ev(A, `location.hash = '#demo'`); await send('Page.reload', {}, A); await sleep(500);
  await waitFor(A, `document.readyState === 'complete' && !!window.CFDrive`);
  const N = JSON.parse(await ls(A, dataKey('a'))).txns.length;
  await manualSync(A);
  const dA = driveData('a');
  ok(dA && dA.txns.length === N && N > 100, `sample data saved to Alice's Drive (${N} transactions)`);
  ok(JSON.stringify(dA) === await ls(A, dataKey('a')), 'Drive copy identical to this device');
  ok((await statusText(A)).startsWith('Saved to Google Drive'), 'status: saved to Google Drive');
  ok(await ev(A, `document.getElementById('syncIc').textContent`) === 'cloud_done', 'header sync icon: done');
  ok(JSON.parse(await ls(A, 'cashflow.accounts'))['1001'].remember === true, 'remembered on this device');

  // a change saves to Drive by itself
  await addTx(A, 'Laptop tea', 20); await settled(A);
  ok(descs(driveData('a')).includes('Laptop tea'), 'new transaction saved to Drive automatically (no button)');

  /* ===== 2. second device: not remembered, takes the Drive copy ===== */
  console.log('2. shared computer (not remembered)');
  const B = await newPage(); await go(B);
  await signInGate(B, 'a', false);
  const bData = await localData(B, 'a', true);
  ok(bData.txns.length === N + 1 && descs(bData).includes('Laptop tea'), 'second device loads everything from Drive');
  ok(bData.profiles.length === dA.profiles.length, 'no extra empty person created on the new device');
  ok(!(await lsKeys(B)).some(k => k.startsWith('cashflow.v2') || k.startsWith('cashflow.sync') || k === 'cashflow.accounts'), 'nothing about the account stored permanently on the shared computer');
  ok(await ls(B, 'cashflow.user') === null && await ssGet(B, 'cashflow.sessionUser') !== null, 'sign-in kept only for this tab');
  await settings(B);
  ok(!(await ev(B, `document.getElementById('rememberChk').checked`)), 'settings: Remember this device is off');

  /* ===== 3. both devices change: merged ===== */
  console.log('3. both devices change');
  await addTx(B, 'Office lunch', 150); await settled(B);
  ok(descs(driveData('a')).includes('Office lunch') && descs(driveData('a')).includes('Laptop tea'), 'device B change merged into Drive');
  await addTx(A, 'Laptop fuel', 500); await settled(A);
  let d = driveData('a');
  ok(descs(d).includes('Laptop fuel') && descs(d).includes('Office lunch'), 'device A change merged; Drive has both devices\' changes');
  ok(descs(await localData(A, 'a')).includes('Office lunch'), 'device A picked up device B\'s change while saving');
  await delTx(B, 'Laptop tea'); await settled(B);
  ok(!descs(driveData('a')).includes('Laptop tea'), 'delete on device B reaches Drive');
  const msg = await manualSync(A);
  ok(msg.includes('Synced') && !descs(await localData(A, 'a')).includes('Laptop tea') && descs(await localData(A, 'a')).includes('Laptop fuel'), 'Sync on device A: deletion applied, own change kept');
  ok(descs(await localData(B, 'a', true)).includes('Laptop fuel'), 'device B already received device A\'s change while saving its delete');
  await manualSync(B);
  ok(descs(await localData(B, 'a', true)).includes('Laptop fuel'), 'Sync on device B: gets device A\'s change');
  const sameNow = JSON.stringify((await localData(A, 'a')).txns.map(t => t.id).sort()) === JSON.stringify((await localData(B, 'a', true)).txns.map(t => t.id).sort());
  ok(sameNow, 'both devices now hold exactly the same transactions');

  /* ===== 4. expired sign-in, offline ===== */
  console.log('4. expired sign-in and offline');
  await go(A);                             // reopen: no Google session yet
  const toastHas = (sid, t) => waitFor(sid, `!document.getElementById('toast').hidden && document.getElementById('toastMsg').textContent.includes(${JSON.stringify(t)})`, 6000).then(() => true, () => false);
  ok(await toastHas(A, 'Tap Sync to get the latest'), 'reopening offers Sync for changes from other devices');
  await addTx(A, 'Offline-ish snack', 30);
  ok(await toastHas(A, 'Tap Sync to save it to your Google Drive'), 'change without a Google session: saved locally, asks to Sync');
  ok(await ev(A, `!document.getElementById('syncDot').hidden`), 'header shows a pending dot');
  await ev(A, `document.getElementById('toastAct').click()`); await sleep(150); await idle(A);
  ok(descs(driveData('a')).includes('Offline-ish snack'), 'tapping Sync in the message saves to Drive');
  await send('Network.enable', {}, A);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, A);
  await sleep(200);
  await addTx(A, 'Offline bus', 25); await sleep(2600);
  ok((await statusText(A)).includes("You're offline. Your changes are kept on this device"), 'offline: status explains changes wait on the device');
  ok(!descs(driveData('a')).includes('Offline bus'), 'offline: nothing sent');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, A);
  await sleep(400); await settled(A);
  ok(descs(driveData('a')).includes('Offline bus'), 'back online: change saved to Drive automatically');

  /* ===== 5. remember on/off ===== */
  console.log('5. remember this device');
  await settings(A);
  dialogPlan.set(A, [true]);
  await ev(A, `document.getElementById('rememberChk').click()`); await sleep(200);
  ok(await ls(A, dataKey('a')) === null && (await ssGet(A, dataKey('a'))) !== null && !JSON.parse(await ls(A, 'cashflow.accounts'))['1001'], 'turned off: data moved to tab-only storage');
  await ev(A, `document.getElementById('rememberChk').click()`); await sleep(200);
  ok((await ls(A, dataKey('a'))) !== null && (await ssGet(A, dataKey('a'))) === null, 'turned on: data kept on the device again');

  /* ===== 6. wrong account, damaged file ===== */
  console.log('6. safety checks');
  await go(A); await settings(A); await ev(A, `window.__acct='b'`);
  ok((await manualSync(A)).includes('You chose bob@gmail.com, but this device is signed in as alice@gmail.com'), 'Sync refuses a different Google account');
  await ev(A, `window.__acct='a'`);
  const good = filesOf('a')[0].content;
  filesOf('a')[0].content = '{broken'; filesOf('a')[0].modifiedTime = new Date(state.clock += 60000).toISOString();
  ok((await manualSync(A)).includes('damaged, so it was left untouched') && filesOf('a')[0].content === '{broken', 'damaged Drive file: not overwritten, clear message');
  ok((await localData(A, 'a')).txns.length > N, 'local data untouched');
  filesOf('a')[0].content = good; filesOf('a')[0].modifiedTime = new Date(state.clock += 60000).toISOString();
  await manualSync(A);

  /* ===== 7. delete Drive copy, turn back on ===== */
  console.log('7. delete Drive copy');
  dialogs.length = 0;
  await ev(A, `document.getElementById('toast').hidden=true; document.getElementById('driveDeleteBtn').click()`);
  await waitFor(A, `!document.getElementById('toast').hidden`);
  ok(dialogs[0].includes('Delete the Cash Flow copy from your Google Drive (alice@gmail.com)') && dialogs[0].includes('Drive sync is then turned off'), 'delete asks and explains sync turns off');
  ok(filesOf('a').length === 0, 'Drive copy moved to Bin');
  ok((await statusText(A)).includes('Drive sync is off') && await ev(A, `!document.getElementById('driveOnBtn').hidden && document.getElementById('driveDeleteBtn').hidden`), 'status: sync off; "Turn back on" shown');
  await addTx(A, 'Paused coffee', 40); await sleep(2600);
  ok(filesOf('a').length === 0, 'while off: changes stay on this device only');
  await ev(A, `document.getElementById('toast').hidden=true; document.getElementById('driveOnBtn').click()`);
  await waitFor(A, `!document.getElementById('toast').hidden`); await idle(A);
  ok(descs(driveData('a')).includes('Paused coffee'), 'turned back on: everything saved to Drive again');

  /* ===== 8. sign out ===== */
  console.log('8. sign out');
  await ev(B, `document.getElementById('signOutBtn').click()`);
  ok((await ev(B, `document.getElementById('soText').textContent`)).includes("doesn't keep your data") && await ev(B, `document.getElementById('soWipeRow').hidden`), 'shared computer: sign-out always removes data');
  await ev(B, `document.getElementById('soGo').click()`);
  ok(await isGated(B) && await ssGet(B, dataKey('a')) === null, 'shared computer: signed out and wiped');

  /* ===== 9. change account ===== */
  console.log('9. change Google account');
  await settings(A);
  const before = await ls(A, dataKey('a'));
  await ev(A, `document.getElementById('changeAcctBtn').click()`);
  await moveClick(A);
  await ev(A, `window.__pick='b'`);
  let body = await moveClick(A);
  ok(body.includes('now in bob@gmail.com') && filesOf('b')[0].content === before, 'moved to Bob: his Drive has identical data');
  ok(JSON.parse(await ls(A, 'cashflow.accounts'))['1002'].remember === true && await ls(A, dataKey('a')) === null, 'device stays remembered for Bob; Alice\'s copy removed');
  body = await moveClick(A);
  ok(filesOf('a').length === 0 && body.includes("moved to alice@gmail.com's Drive Bin"), 'old copy deleted when asked');
  await ev(A, `document.getElementById('moveNext').click()`);
  await addTx(A, 'Bob first', 10); await settled(A);
  ok(descs(driveData('b')).includes('Bob first') && filesOf('a').length === 0, 'after the move, changes sync to Bob\'s Drive only');

  /* ===== 10. downloads ===== */
  console.log('10. downloads');
  await ev(A, `document.querySelector('.nav-item[data-page=settings]').click(); document.getElementById('downloadBtn').click()`);
  const all = (await localData(A, 'b')).txns.map(t => t.date).sort();
  ok(await ev(A, `document.getElementById('exFrom').min`) === all[0] && await ev(A, `document.getElementById('exTo').max`) === all[all.length - 1], 'date pickers limited to the account\'s first and last transaction');
  ok(await ev(A, `document.getElementById('exFrom').value === document.getElementById('exFrom').min && document.getElementById('exTo').value === document.getElementById('exTo').max`), 'defaults to the whole range');
  const acctId = await ev(A, `[...document.getElementById('exAcct').options].find(o=>o.value!=='all').value`);
  await ev(A, `(()=>{const $=id=>document.getElementById(id); $('exAcct').value=${JSON.stringify(acctId)}; $('exAcct').dispatchEvent(new Event('change')); $('exFrom').value='2026-09-01'; $('exTo').value='2026-09-30'; $('exTo').dispatchEvent(new Event('change'));})()`);
  const expect = (await localData(A, 'b')).txns.filter(t => t.accountId === acctId && t.date >= '2026-09-01' && t.date <= '2026-09-30');
  ok((await ev(A, `document.getElementById('exCount').textContent`)).startsWith(`${expect.length} transactions`), `count for Sep 2026 shown (${expect.length})`);
  await ev(A, `document.getElementById('exCsv').click()`);
  const csvF = await waitFile('.csv'); const csv = fs.readFileSync(csvF, 'utf8');
  ok(path.basename(csvF) === 'cashflow_sample-savings-0000_2026-09-01_to_2026-09-30.csv', 'CSV file name: account and period');
  const csvLines = csv.trim().split('\r\n');
  ok(csvLines.length === expect.length + 1 && csvLines.slice(1).every(l => l.startsWith('"2026-09-')), 'CSV holds exactly that account\'s September transactions');
  await ev(A, `document.getElementById('exXlsx').click()`);
  const xf = await waitFile('.xlsx');
  const XLSX = createRequire(import.meta.url)(ROOT + '/vendor/xlsx.full.min.js');
  const wb = XLSX.read(fs.readFileSync(xf), { cellNF: true });
  ok(wb.SheetNames.join() === 'Summary,Transactions', 'Excel: Summary and Transactions sheets');
  const txs = XLSX.utils.sheet_to_json(wb.Sheets.Transactions, { header: 1 }).filter(r => r.length);
  ok(txs.length === expect.length + 1, 'Excel: header plus every transaction');
  const c = wb.Sheets.Transactions.A2;
  ok(c.t === 'n' && c.z === 'dd-mmm-yyyy' && XLSX.SSF.format('yyyy-mm-dd', c.v).startsWith('2026-09'), 'Excel: dates are real dates');
  const cats = (await localData(A, 'b')).categories, inv = new Set(cats.filter(c => c.invest).map(c => c.name));
  const kind = t => t.category === 'Self Transfer' ? 'none' : inv.has(t.category) ? 'invest' : t.type;
  const inc = expect.filter(t => kind(t) === 'credit').reduce((s, t) => s + t.amount, 0), exp = expect.filter(t => kind(t) === 'debit').reduce((s, t) => s + t.amount, 0);
  const sum = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
  ok(Math.abs(sum.find(r => r[0] === 'Income')[1] - inc) < 0.01 && Math.abs(sum.find(r => r[0] === 'Expenses')[1] - exp) < 0.01, 'Excel: summary totals match');
  await ev(A, `document.getElementById('exPdf').click()`);
  const pf = await waitFile('.pdf', 15000); const pdf = fs.readFileSync(pf, 'latin1');
  ok(pdf.startsWith('%PDF-') && pdf.includes('(Cash Flow statement)') && pdf.includes('Period: 1 Sep 2026 to 30 Sep 2026'), 'PDF: real PDF file with title and period');
  ok((pdf.match(/\/Type \/Page\b/g) || []).length >= 2 && pdf.includes('Page 1 of'), 'PDF: summary page + transactions, page numbers');

  /* ===== screenshots ===== */
  const shot = async (sid, name, w, dark, setup) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 844 : 900, deviceScaleFactor: 2, mobile: w < 600 }, sid);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, sid);
    if (setup) await ev(sid, setup);
    await sleep(400);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sid);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    return ev(sid, `document.documentElement.scrollWidth <= innerWidth`);
  };
  ok(await shot(A, 'export-phone', 390, false), 'download dialog fits phone width');
  await shot(A, 'export-dark-desktop', 1280, true);
  await ev(A, `document.getElementById('exportDlg').close()`);
  ok(await shot(A, 'sync-card-phone', 390, false, `document.getElementById('toast').hidden=true; document.getElementById('avatarBtn').click(); document.getElementById('rememberRow').scrollIntoView({block:'center'})`), 'account card fits phone width');
  await shot(A, 'sync-card-dark-desktop', 1280, true, `document.getElementById('avatarBtn').click(); document.getElementById('rememberRow').scrollIntoView({block:'center'})`);
  await shot(B, 'gate2-phone', 390, false);
} catch (e) { console.log('\n✗', e.message); process.exitCode = 1; }
console.log(`\n${pass} checks passed. Page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
ws.close();
