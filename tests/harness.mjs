// Shared test harness: drives headless Chrome over the DevTools protocol and fakes Google sign-in, Google Drive and
// GoatCounter, so the app is tested end to end without real accounts. App files are served from the project folder
// through request interception (no web server needed). Used by tests/t-*.mjs; run everything with: node tests/run-all.mjs
import { fileURLToPath } from 'node:url';
// App files served from ~/finance-tracker via CDP interception; Google sign-in, userinfo and Drive are faked (4 accounts).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'tests', '.output'); fs.mkdirSync(OUT, { recursive: true });
export const APP_VERSION = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'))[1];
export const ORIGIN = 'http://localhost:8766';
export const ACCTS = {
  a: { sub: '1001', email: 'alice@gmail.com', name: 'Alice Kumar', given_name: 'Alice' },
  b: { sub: '1002', email: 'bob@gmail.com', name: 'Bob Raj', given_name: 'Bob' },
  c: { sub: '1003', email: 'carol@gmail.com', name: 'Carol', given_name: 'Carol' },
  d: { sub: '1004', email: 'dan@gmail.com', name: 'Dan', given_name: 'Dan' },
};

export const ver = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || 9333}/json/version`)).json();
export const ws = new WebSocket(ver.webSocketDebuggerUrl);
export let seq = 0; const pend = new Map(); const listeners = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else listeners.forEach(h => h(m));
};
await new Promise(r => (ws.onopen = r));
export const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++seq; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- fake Google ---------- */
export const drive = { files: new Map(), log: [], n: 0, dead: new Set() };
export const GIS_STUB = `window.google={accounts:{oauth2:{
 initTokenClient(cfg){return{requestAccessToken(o){window.__gisCalls=(window.__gisCalls||0)+1;window.__lastHint=cfg.login_hint;window.__prompt=o&&o.prompt;window.__scope=cfg.scope;
  const m=window.__gis||'ok';const acct=(o&&o.prompt==='select_account'&&window.__pick)||window.__acct||'a';
  setTimeout(()=>{if(m==='popup')cfg.error_callback({type:'popup_failed_to_open'});else if(m==='closed')cfg.error_callback({type:'popup_closed'});
  else if(m==='denied')cfg.callback({error:'access_denied'});else cfg.callback({access_token:'tok-'+acct,expires_in:3599,scope:m==='nodrive'?'openid email profile':cfg.scope});},10);}};},
 hasGrantedAllScopes(r,...s){return s.every(x=>(' '+r.scope+' ').includes(' '+x+' '));},
 revoke(t,cb){cb&&cb();}}}};`;
export const cors = [{ name: 'Access-Control-Allow-Origin', value: ORIGIN }, { name: 'Access-Control-Allow-Headers', value: 'authorization,content-type,x-upload-content-type' },
  { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,PUT,OPTIONS' }, { name: 'Access-Control-Expose-Headers', value: 'Location' }];
export const json = (code, obj, extra = []) => ({ code, headers: [{ name: 'Content-Type', value: 'application/json' }, ...cors, ...extra], body: JSON.stringify(obj) });
export const meta = f => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, size: String(Buffer.byteLength(f.content)), appProperties: f.appProperties });
export function parseMultipart(ct, body) {
  const b = /boundary=([^;]+)/.exec(ct)[1];
  const parts = body.split('--' + b).slice(1, -1).map(p => p.slice(p.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''));
  return { meta: JSON.parse(parts[0]), content: parts[1] };
}
export function upsert(owner, id, m, content) {
  let f = id ? drive.files.get(id) : null;
  if (id && (!f || f.owner !== owner)) return null;
  if (!f) { f = { id: 'file' + ++drive.n, owner, appProperties: {}, trashed: false }; drive.files.set(f.id, f); }
  Object.assign(f, { name: m.name, appProperties: Object.assign(f.appProperties, m.appProperties || {}), content, modifiedTime: new Date(state.clock += 60000).toISOString() });
  return f;
}
export const filesOf = k => [...drive.files.values()].filter(f => f.owner === k && !f.trashed);
export const resumable = new Map();
export function route(method, url, headers, body) {
  const u = new URL(url), h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === 'OPTIONS') return { code: 204, headers: cors, body: '' };
  const tok = (h.authorization || '').replace('Bearer ', ''), who = tok.replace('tok-', '');
  drive.log.push(`${who} ${method} ${u.pathname}`);
  if (!ACCTS[who] || drive.dead.has(tok)) return json(401, { error: { message: 'Invalid Credentials' } });
  if (u.pathname === '/oauth2/v3/userinfo') return json(200, ACCTS[who]);
  if (u.pathname === '/drive/v3/files' && method === 'GET') {
    const tag = (/key='(\w+)'/.exec(u.searchParams.get('q') || '') || [])[1] || 'cashflowBackup';
    const list = filesOf(who).filter(f => f.appProperties[tag] === '1').sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
    return json(200, { files: list.slice(0, 1).map(meta) });
  }
  let m;
  if (u.pathname === '/upload/drive/v3/files' && method === 'PUT') { const r = resumable.get(u.searchParams.get('upload_id')); return json(200, meta(upsert(who, r.id, r.meta, body))); }
  if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname))) {
    const f = drive.files.get(m[1]);
    if (!f || f.owner !== who) return json(404, { error: { message: 'File not found' } });
    if (method === 'GET' && u.searchParams.get('alt') === 'media') return { code: 200, headers: [{ name: 'Content-Type', value: 'application/json' }, ...cors], body: f.content };
    if (method === 'PATCH') { const p = JSON.parse(body); if (p.trashed === true) f.trashed = true; return json(200, { id: f.id }); }
  }
  if ((m = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(u.pathname))) {
    const id = m[1], type = u.searchParams.get('uploadType');
    if (type === 'multipart') { const p = parseMultipart(h['content-type'], body); const f = upsert(who, id, p.meta, p.content); return f ? json(200, meta(f)) : json(404, {}); }
    if (type === 'resumable') { const key = 'up' + resumable.size; resumable.set(key, { id, meta: JSON.parse(body) }); return json(200, {}, [{ name: 'Location', value: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${key}` }]); }
  }
  return json(400, { error: { message: 'unhandled ' + method + ' ' + url } });
}

/* ---------- browser plumbing ---------- */
export const errors = [], dialogs = [];
export const state = { configured: true, cfg: null, clock: Date.parse('2026-11-17T10:00:00Z') };
import crypto from 'node:crypto';
export const sha = s => crypto.createHash('sha256').update(s).digest('hex');
state.cfg = { googleClientId: '123-test.apps.googleusercontent.com', goatcounterCode: 'test', goatcounterAllowLocal: true, adminHashes: [sha('alice@gmail.com')], supportEmail: 'support@example.com' };
export const counts = [], apiCalls = [];
export const GOOD_KEY = 'gc-test-key-abcdefghijklmnop1234';
export function goat(method, url, headers) {
  const u = new URL(url), h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const cors = [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' }];
  if (method === 'OPTIONS') return { code: 204, headers: cors, body: '' };
  if (u.pathname === '/count') { counts.push({ q: Object.fromEntries(u.searchParams), headers: h }); return { code: 200, headers: [{ name: 'Content-Type', value: 'image/gif' }], body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }; }
  apiCalls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: h.authorization });
  if (h.authorization !== 'Bearer ' + GOOD_KEY) return { code: 401, headers: [...cors, { name: 'Content-Type', value: 'application/json' }], body: '{"error":"unauthorized"}' };
  const J = o => ({ code: 200, headers: [...cors, { name: 'Content-Type', value: 'application/json' }], body: JSON.stringify(o) });
  const today = new Date().toISOString().slice(0, 10), yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (u.pathname === '/api/v0/stats/hits') return J({ more: false, total: 99, hits: [
    { path_id: 1, path: 'app-open', event: true, count: 12, stats: [{ day: yday, daily: 5 }, { day: today, daily: 7 }] },
    { path_id: 2, path: 'open-installed-app', event: true, count: 4, stats: [] },
    { path_id: 3, path: 'open-in-browser', event: true, count: 8, stats: [] },
    { path_id: 4, path: 'download-pdf', event: true, count: 3, stats: [] },
    { path_id: 5, path: 'download-csv', event: true, count: 1, stats: [] },
    { path_id: 6, path: 'import-ok-pdf', event: true, count: 6, stats: [] },
    { path_id: 7, path: 'import-failed-pdf', event: true, count: 1, stats: [] },
    { path_id: 8, path: 'sync-ok', event: true, count: 9, stats: [] },
    { path_id: 9, path: 'sync-error-offline', event: true, count: 2, stats: [] },
    { path_id: 10, path: 'version-' + APP_VERSION, event: true, count: 12, stats: [] },
    { path_id: 11, path: '/dashboard', event: false, count: 11, stats: [] },
    { path_id: 12, path: 'signin-remembered', event: true, count: 3, stats: [] },
    { path_id: 13, path: 'first-open-device', event: true, count: 2, stats: [] } ] });
  if (u.pathname === '/api/v0/stats/total') return J({ total: 21, total_events: 60, total_utc: 21, stats: [] });
  if (u.pathname === '/api/v0/stats/systems') return J({ more: false, stats: [{ id: 1, name: 'Android', count: 7 }, { id: 2, name: 'macOS', count: 5 }] });
  if (u.pathname === '/api/v0/stats/browsers') return J({ more: false, stats: [{ id: 1, name: 'Chrome', count: 10 }, { id: 2, name: 'Safari', count: 2 }] });
  return J({});
}
export const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
export function serveApp(url) {
  let p = new URL(url).pathname; if (p === '/') p = '/index.html';
  if (p === '/config.js') return state.configured ? { code: 200, headers: [{ name: 'Content-Type', value: 'text/javascript' }], body: 'window.CF_CONFIG=' + JSON.stringify(state.cfg) + ';' } : { code: 404, headers: [], body: '' };
  const file = path.join(ROOT, decodeURIComponent(p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return { code: 404, headers: [], body: '' };
  return { code: 200, headers: [{ name: 'Content-Type', value: (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' }], body: fs.readFileSync(file) };
}
export async function onPaused(m, sid) {
  const { requestId, request } = m.params;
  let body = request.postData || '';
  if (request.postDataEntries) body = Buffer.concat(request.postDataEntries.map(e => Buffer.from(e.bytes || '', 'base64'))).toString('utf8');
  const u = new URL(request.url);
  let r = null;
  if (u.origin === ORIGIN) r = serveApp(request.url);
  else if (u.hostname === 'accounts.google.com') r = { code: 200, headers: [{ name: 'Content-Type', value: 'text/javascript' }], body: GIS_STUB };
  else if (u.hostname === 'www.googleapis.com') r = route(request.method, request.url, request.headers, body);
  else if (u.hostname === 'test.goatcounter.com') r = goat(request.method, request.url, request.headers);
  if (!r) return send('Fetch.continueRequest', { requestId }, sid).catch(() => {});
  await send('Fetch.fulfillRequest', { requestId, responseCode: r.code, responseHeaders: r.headers, body: Buffer.from(r.body).toString('base64') }, sid).catch(() => {});
}
export const dialogPlan = new Map();
listeners.push(m => {
  if (m.method === 'Fetch.requestPaused') onPaused(m, m.sessionId);
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message);
    const q = dialogPlan.get(m.sessionId) || []; const accept = q.length ? q.shift() : true;
    send('Page.handleJavaScriptDialog', { accept }, m.sessionId);
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' '));
});
export const DL = path.join(OUT, 'downloads'); fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL);
export async function newPage() {
  const { browserContextId } = await send('Target.createBrowserContext');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, browserContextId });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: ORIGIN + '/*' }, { urlPattern: 'https://accounts.google.com/*' }, { urlPattern: 'https://www.googleapis.com/*' }, { urlPattern: 'https://test.goatcounter.com/*' }] }, sessionId);
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  return sessionId;
}
export const ev = async (sid, expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
export async function waitFor(sid, expr, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(sid, expr).catch(() => false)) return true; await sleep(40); } throw new Error('timeout waiting for ' + expr); }
export async function go(sid, hash = '') {
  await send('Page.navigate', { url: ORIGIN + '/index.html' + hash }, sid);
  await waitFor(sid, `document.readyState==='complete' && !!window.CFDrive && (document.getElementById('gate').hidden || !document.getElementById('gateSignIn').disabled || !CFDrive.configured())`);
}
export const $t = (sid, id) => ev(sid, `document.getElementById('${id}').textContent`);
export const isGated = sid => ev(sid, `!document.getElementById('gate').hidden && document.body.classList.contains('gated')`);
export async function gateSignIn(sid, acct) {
  await ev(sid, `window.__acct='${acct}'; window.__pick='${acct}'; document.getElementById('gateSignIn').click()`);
  await waitFor(sid, `document.getElementById('gate').hidden || document.getElementById('gateMsg').classList.contains('err')`);
}
export async function settings(sid) { await ev(sid, `document.querySelector('.nav-item[data-page=settings]').click()`); }
export async function clickToast(sid, id) {
  await ev(sid, `document.getElementById('toast').hidden=true; document.getElementById('${id}').click()`);
  await waitFor(sid, `!document.getElementById('toast').hidden && !document.getElementById('${id}').disabled`);
  return ev(sid, `document.getElementById('toastMsg').textContent`);
}
export const ls = (sid, k) => ev(sid, `localStorage.getItem(${JSON.stringify(k)})`);
export const txnsIn = async (sid, k) => { const v = await ls(sid, k); return v ? JSON.parse(v).txns.length : null; };
export const dataKey = k => 'cashflow.v2.' + ACCTS[k].sub;
export async function moveClick(sid) { await ev(sid, `document.getElementById('moveNext').click()`); await waitFor(sid, `!document.getElementById('moveNext').disabled`); return ev(sid, `document.getElementById('moveBody').innerText`); }

