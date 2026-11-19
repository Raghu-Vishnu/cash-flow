// Investments (totals, dashboard, chart, filter, downloads), Profile/Settings pages, contact support.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as H from './harness.mjs';
const { $t, ACCTS, APP_VERSION, DL, GIS_STUB, GOOD_KEY, ORIGIN, OUT, ROOT, apiCalls, clickToast, cors, counts, dataKey, dialogPlan, dialogs, drive, errors, ev, filesOf, gateSignIn, go, goat, isGated, json, ls, meta, moveClick, newPage, onPaused, parseMultipart, resumable, route, send, seq, serveApp, settings, sha, sleep, state, txnsIn, types, upsert, ver, waitFor, ws } = H;
let pass = 0; const ok = (c, msg) => { if (!c) throw new Error('FAIL: ' + msg); pass++; console.log('  ✓', msg); };
async function signInGate(sid, acct, remember) { await ev(sid, `document.getElementById('gateRemember').checked=${!!remember}`); await gateSignIn(sid, acct); await sleep(400); }
async function reload(sid, hash) { if (hash) await ev(sid, `location.hash = '${hash}'`); await send('Page.reload', {}, sid); await sleep(500); await waitFor(sid, `document.readyState==='complete' && !!window.CFDrive`); await sleep(500); }
const db = async sid => JSON.parse(await ls(sid, dataKey('a')));
const num = s => Number(String(s).replace(/[^0-9.-]/g, '').replace(/^-?\./, ''));
try {
  const A = await newPage(); await go(A); await signInGate(A, 'a', true);
  await reload(A, '#demo');

  /* ===== 1. investment categories ===== */
  console.log('1. investment categories');
  const re = await db(A);
  const names = re.categories.filter(c => c.invest).map(c => c.name);
  ok(['From investments', 'Mutual funds / SIP', 'Stocks', 'Gold', 'Other investments'].every(n => names.includes(n)), 'investment categories present from the start');
  ok(re.profiles[0].name === 'Alice', 'first person is named after the Google account');
  const sip = re.txns.filter(t => /ZERODHA BROKING SIP/.test(t.desc));
  ok(sip.length && sip.every(t => t.category === 'Mutual funds / SIP'), 'Zerodha SIPs → Mutual funds / SIP');
  await ev(A, `document.querySelector('.nav-item[data-page=settings]').click()`); await sleep(200);
  ok(await ev(A, `!document.getElementById('catFold').open && !document.getElementById('ruleFold').open`), 'Settings: categories and rules collapsed by default');
  ok(await ev(A, `[...document.querySelectorAll('#catInvest input')].map(i => i.value).includes('Gold')`), 'Settings: Investments list shown');
  await ev(A, `catFold.open = true; newCatName.value = 'Crypto'; newCatType.value = 'invest'; newCatKw.value = 'wazirx, coindcx'; addCatForm.requestSubmit()`); await sleep(200);
  ok((await db(A)).categories.find(c => c.name === 'Crypto')?.invest === true, 'a new category of type "Investment" counts as invested');

  /* ===== 3. dashboard ===== */
  console.log('3. dashboard');
  await ev(A, `document.querySelector('.nav-item[data-page=dash]').click()`); await sleep(400);
  const inv = new Set(re.categories.filter(c => c.invest).map(c => c.name));
  const kind = t => t.category === 'Self Transfer' ? 'none' : inv.has(t.category) ? 'invest' : t.type === 'credit' ? 'inc' : 'exp';
  let I = 0, E = 0, P = 0, B = 0;
  const yr = await ev(A, `yearSel.value`);
  for (const t of re.txns.filter(t => yr === 'all' || t.date.startsWith(yr))) { const k = kind(t); if (k === 'inc') I += t.amount; else if (k === 'exp') E += t.amount; else if (k === 'invest') t.type === 'debit' ? P += t.amount : B += t.amount; }
  const K = await ev(A, `({ inc: kIncome.textContent, exp: kExpense.textContent, inv: kInvest.textContent, net: kNet.textContent, netSub: kNetSub.textContent })`);
  ok(Math.abs(num(K.inc) - Math.round(I)) <= 1 && Math.abs(num(K.exp) - Math.round(E)) <= 1, `Income ${K.inc} and Expenses ${K.exp} exclude investments`);
  ok(Math.abs(num(K.inv) - Math.round(P - B)) <= 1 && P > 0, `Invested ${K.inv} = put in − taken out`);
  ok(Math.abs(num(K.net) - Math.round(I - E - (P - B))) <= 1, `Left over ${K.net} = income − expenses − invested`);
  ok(K.netSub.includes(`Saved ${Math.round(((I - E) / I) * 100)}% of income`), `savings rate counts invested as saved ("${K.netSub}")`);
  ok(await ev(A, `Chart.getChart(document.getElementById('flowChart')).data.datasets.map(d => d.label).join() === 'Income,Expenses,Invested'`), 'chart shows Income, Expenses and Invested');
  ok(await ev(A, `!document.getElementById('investCard').hidden && document.getElementById('invCats').innerText.includes('Mutual funds / SIP')`), '"Where you invested" card');
  ok(!(await ev(A, `document.getElementById('expCats').innerText`)).includes('Mutual funds'), 'investments not in "Where the money went"');
  await ev(A, `document.querySelector('.nav-item[data-page=tx]').click(); document.getElementById('typeSel').value='invest'; document.getElementById('typeSel').dispatchEvent(new Event('change'))`); await sleep(300);
  const shown = await ev(A, `[...document.querySelectorAll('#txBody .tx-item')].map(b => b.querySelector('.tx-amt').className)`);
  ok(shown.length > 0 && shown.every(c => c.includes('invest')), `type filter "Investments" shows only investments (${shown.length})`);
  await ev(A, `document.getElementById('typeSel').value=''; document.getElementById('typeSel').dispatchEvent(new Event('change'))`);

  /* ===== 4. downloads label investments ===== */
  await ev(A, `document.querySelector('.nav-item[data-page=settings]').click(); document.getElementById('downloadBtn').click()`); await sleep(300);
  ok((await ev(A, `document.getElementById('exCount').textContent`)).includes('Invested'), 'download dialog shows invested total');
  await ev(A, `document.getElementById('exCsv').click()`); await sleep(800);
  const csvF = fs.readdirSync(DL).filter(n => n.endsWith('.csv')).map(n => path.join(DL, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  ok(fs.readFileSync(csvF, 'utf8').includes('"Invested"'), 'CSV Type column says "Invested"');
  await ev(A, `document.getElementById('exportDlg').close()`);

  /* ===== 5. profile & settings ===== */
  console.log('5. profile and settings');
  await ev(A, `document.getElementById('avatarBtn').click()`); await sleep(200);
  ok(await ev(A, `!profilePage.hidden && settings.hidden && pageTitle.textContent === 'Profile' && !!document.querySelector('#peopleList .person')`), 'avatar opens Profile with people & bank accounts');
  ok(await ev(A, `document.querySelector('.nav-item.active[data-page=settings]') !== null`), 'Settings tab stays highlighted on Profile');
  await ev(A, `toSettings.click()`); await sleep(150);
  ok(await ev(A, `!settings.hidden && profilePage.hidden && plName.textContent === 'Alice Kumar'`), 'Profile ↔ Settings links work; Settings shows who is signed in');
  await ev(A, `toProfile.click()`); await sleep(150);
  ok(await ev(A, `!profilePage.hidden`), 'Settings → Profile link');

  /* ===== 6. contact support ===== */
  console.log('6. contact support');
  const { browserContextId } = (await send('Target.getTargetInfo', {}, A)).targetInfo;
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: ORIGIN, browserContextId });
  await ev(A, `supportBtn.click()`); await sleep(150);
  ok(await ev(A, `supportDlg.open && spOff.hidden && !spSend.disabled`), 'support form opens (support email configured)');
  await ev(A, `spTopic.value = 'A statement wasn\\'t read correctly'; spWhat.value = 'September salary missing'; spSteps.value = '1. Upload Sep PDF'; spCopy.click()`); await sleep(400);
  const clip = await ev(A, `navigator.clipboard.readText()`);
  ok(clip.startsWith('To: support@example.com') && clip.includes("Subject: [Cash Flow] A statement wasn't read correctly") && clip.includes('September salary missing') && clip.includes('App version: ' + APP_VERSION) && /Device: browser, \w+/.test(clip), 'template: topic, description, steps, app version, device');
  ok(!/alice|@gmail|₹|\d{4,}\.\d\d/.test(clip.toLowerCase()), 'no email, amounts or account details added automatically');
  await ev(A, `supportDlg.close()`);
  state.cfg = Object.assign({}, state.cfg, { supportEmail: '' });
  await reload(A); await ev(A, `avatarBtn.click(); supportBtn.click()`); await sleep(150);
  ok(await ev(A, `!spOff.hidden && spSend.disabled`), 'no support email set: says so, Send disabled');
  await ev(A, `supportDlg.close()`);

  /* screenshots */
  const shot = async (name, w, dark, setup) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 844 : 900, deviceScaleFactor: 2, mobile: w < 600 }, A);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] }, A);
    await ev(A, setup + `; document.getElementById('toast').hidden = true; window.scrollTo(0, 0)`); await sleep(600);
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, A);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    return ev(A, `document.documentElement.scrollWidth <= innerWidth`);
  };
  ok(await shot('inv-dash-desktop', 1280, false, `document.querySelector('.nav-item[data-page=dash]').click()`), 'dashboard fits');
  ok(await shot('inv-dash-phone', 390, false, `document.querySelector('.nav-item[data-page=dash]').click()`), 'dashboard fits phone');
  await shot('inv-dash-dark', 1280, true, `document.querySelector('.nav-item[data-page=dash]').click(); setTimeout(()=>document.getElementById('investCard').scrollIntoView(), 50)`);
  ok(await shot('support-phone', 390, false, `avatarBtn.click(); supportBtn.click()`), 'support form fits phone');
  await ev(A, `supportDlg.close()`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, A); await sleep(300);
  ok(await ev(A, `filtersWrap.hidden && !profilePage.hidden`), 'theme change on Profile does not bring back dashboard filters');
} catch (e) { console.log('\n✗', e.message); process.exitCode = 1; }
console.log(`\n${pass} checks passed. Page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
ws.close();
