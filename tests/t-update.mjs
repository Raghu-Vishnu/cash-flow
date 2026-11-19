// Real offline-cache (service worker) update test. A tiny in-process web server serves the current code as version A,
// then B, then C (only the version numbers differ). Like GitHub Pages, files are sent with max-age=600.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), PORT = Number(process.env.UPDATE_PORT || 8768), ORIGIN = `http://localhost:${PORT}`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
let mode = 'A';
const CUR = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'))[1];
const V = { A: '0.0.1', B: '0.0.2', C: '0.0.3' };
function file(p) {
  if (p === 'config.js') return Buffer.from('window.CF_CONFIG={};');
  const f = path.join(ROOT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return null;
  let b = fs.readFileSync(f);
  if (p === 'app.js' || p === 'sw.js') b = Buffer.from(b.toString().replace(`APP_VERSION = '${CUR}'`, `APP_VERSION = '${V[mode]}'`).replace(`cashflow-v${CUR}`, `cashflow-v${V[mode]}`));
  return b;
}
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, ORIGIN).pathname).replace(/^\/+/, ''); if (!p) p = 'index.html';
  if (p.includes('..')) { res.writeHead(400); return res.end(); }
  const b = file(p);
  if (!b) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': (types[path.extname(p)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'max-age=600' });
  res.end(b);
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const ver = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9333}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl); let seq = 0; const pend = new Map(), L = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } else L.forEach(h => h(m)); };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++seq; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = []; L.push(m => { if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
const ev = async (s, e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }, s); return r.exceptionDetails ? undefined : r.result.value; };
async function waitFor(s, e, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(s, e).catch(() => false)) return true; await sleep(150); } throw new Error('timeout: ' + e); }
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); pass++; console.log('  ✓', m); };
const version = s => ev(s, `document.getElementById('verLabel') && (document.getElementById('verLabel').textContent || (window.__v = 1, ''))`);
// the version shows in Settings' footer; it's filled when Settings renders, so read it from the page source instead
const appVersion = s => ev(s, `fetch('app.js').then(r => r.text()).then(t => (t.match(/APP_VERSION = '([\\d.]+)'/) || [])[1])`);
const cachedApp = s => ev(s, `caches.keys().then(async ks => { const k = ks.find(x => x.startsWith('cashflow-v')); const r = await (await caches.open(k)).match('app.js'); return [k, ks.filter(x => x.startsWith('cashflow-v')).length, r ? (await r.text()).match(/APP_VERSION = '([\\d.]+)'/)?.[1] : null]; })`);

try {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, s); await send('Runtime.enable', {}, s);
  let loads = 0; L.push(m => { if (m.method === 'Page.loadEventFired' && m.sessionId === s) loads++; });

  console.log('A. a device on version A (0.0.1)');
  await send('Page.navigate', { url: ORIGIN + '/' }, s);
  await waitFor(s, `!!navigator.serviceWorker.controller`);
  ok(await appVersion(s) === '0.0.1', 'running v0.0.1 with its offline copy installed');
  await send('Page.reload', {}, s); await waitFor(s, `document.readyState === 'complete' && !!navigator.serviceWorker.controller`);
  ok((await cachedApp(s))[2] === '0.0.1', 'offline copy holds v0.0.1');

  console.log('B. version B (0.0.2) is published');
  mode = 'B';
  const before = loads;
  await ev(s, `navigator.serviceWorker.getRegistration().then(r => r.update())`);
  await waitFor(s, `false`, 1).catch(() => {});
  const t0 = Date.now();
  await (async () => { while (Date.now() - t0 < 25000) { if (loads > before && await appVersion(s) === '0.0.2') return; await sleep(200); } throw new Error('did not switch to 0.0.2'); })();
  ok(true, `switched to v0.0.2 by itself in ${((Date.now() - t0) / 1000).toFixed(1)}s, no tap needed`);
  const [key, n, cached] = await cachedApp(s);
  ok(key === 'cashflow-v0.0.2' && n === 1 && cached === '0.0.2', 'offline copy is the new files (not stale ones from the browser cache); old copy removed');
  ok(await ev(s, `document.getElementById('toast').hidden || !document.getElementById('toastMsg').textContent.includes('new version')`), 'no "new version" message left to tap');

  console.log('C. reopening later, and offline');
  await send('Page.navigate', { url: 'about:blank' }, s); await sleep(300);
  await send('Page.navigate', { url: ORIGIN + '/' }, s); await waitFor(s, `document.readyState === 'complete' && !!navigator.serviceWorker.controller`);
  ok(await appVersion(s) === '0.0.2', 'reopening shows v0.0.2 (does not fall back to the old version)');
  await send('Network.enable', {}, s);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);
  await send('Page.reload', {}, s); await sleep(800);
  await waitFor(s, `document.readyState === 'complete' && !!document.getElementById('pageTitle') && caches.match('app.js').then(r => r && r.text()).then(t => !!t && t.includes("APP_VERSION = '0.0.2'"))`);
  ok(true, 'offline: the app opens, from the v0.0.2 offline copy');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);

  console.log('D. an update arrives while a dialog is open');
  await send('Page.reload', {}, s); await waitFor(s, `document.readyState === 'complete' && !!navigator.serviceWorker.controller`);
  await send('Page.bringToFront', {}, s); await send('Emulation.setFocusEmulationEnabled', { enabled: true }, s); await sleep(500);
  ok(await ev(s, `document.visibilityState`) === 'visible', 'page in front (someone is using it)');
  await ev(s, `document.getElementById('exportDlg').showModal()`);
  mode = 'C';
  const b2 = loads;
  await ev(s, `navigator.serviceWorker.getRegistration().then(r => r.update())`);
  await sleep(4000);
  await waitFor(s, `!document.getElementById('toast').hidden && document.getElementById('toastMsg').textContent === 'Cash Flow was updated.'`, 40000);
  ok(loads === b2 && await ev(s, `document.getElementById('exportDlg').open`), 'with a dialog open: no surprise reload, a "Reload" button is offered');
  await ev(s, `document.getElementById('toastAct').click()`);
  await (async () => { const t = Date.now(); while (Date.now() - t < 15000) { if (loads > b2 && await appVersion(s) === '0.0.3') return; await sleep(200); } throw new Error('no reload to 0.0.3'); })();
  ok(true, 'tapping Reload opens the new version');
} catch (e) { console.log('\n✗', e.message); process.exitCode = 1; }
console.log(`\n${pass} checks passed. Page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
ws.close(); server.close();
