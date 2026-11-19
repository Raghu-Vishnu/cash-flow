/* Cash Flow: Google sign-in and the Cash Flow data file in the user's OWN Google Drive.
   - Runs entirely in the browser. Data goes straight between this device and Google; Cash Flow has no server.
   - Scopes: "openid email profile" (who is signed in) and "drive.file" (ONLY the files this app created,
     never the rest of the user's Drive).
   - Access tokens live in memory only (about 1 hour) and are never written to storage.
   Setup: the OAuth client ID comes from GOOGLE_CLIENT_ID in .env (locally) or the GitHub repository variable
   (live site), written into config.js by scripts/make-config.py. See README.md → "Settings". */
window.CFDrive = (function () {
  const CLIENT_ID = String((window.CF_CONFIG && window.CF_CONFIG.googleClientId) || '');
  const DRIVE = 'https://www.googleapis.com/auth/drive.file';
  const SCOPE = 'openid email profile ' + DRIVE;
  const FILE_NAME = 'Cash Flow backup.json';
  const TAG = 'cashflowBackup';
  const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const MULTIPART_MAX = 4 * 1024 * 1024; // larger files use a resumable upload
  let gis = null;

  const configured = () => !!CLIENT_ID;
  const ready = () => !!(window.google && google.accounts && google.accounts.oauth2);
  function err(code, detail) { const e = new Error(detail || code); e.code = code; return e; }

  /** Load Google's sign-in library. Call early (not inside a click) so the sign-in popup isn't blocked later. */
  function preload() {
    if (!configured()) return Promise.reject(err('not-configured'));
    if (ready()) return Promise.resolve();
    if (!gis) gis = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res();
      s.onerror = () => { gis = null; s.remove(); rej(err('offline')); };
      document.head.appendChild(s);
    });
    return gis;
  }

  /** Open Google sign-in and resolve with a session {token, exp, drive}. Must be called straight from a click.
      opts.hint: email to pre-select · opts.selectAccount: always show the account chooser
      opts.needDrive: reject with 'scope' if the user unticked Google Drive */
  function signIn(opts = {}) {
    if (!ready()) return Promise.reject(err(navigator.onLine === false ? 'offline' : 'not-loaded'));
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE, login_hint: opts.hint || undefined,
        callback: r => {
          if (r.error) return rej(err(r.error === 'access_denied' ? 'denied' : 'auth', r.error_description || r.error));
          const drive = google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE);
          if (opts.needDrive && !drive) return rej(err('scope'));
          res({ token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000, drive });
        },
        error_callback: e => rej(err(e && e.type === 'popup_failed_to_open' ? 'popup-blocked' : 'cancelled')),
      });
      client.requestAccessToken({ prompt: opts.selectAccount ? 'select_account' : '' });
    });
  }
  const valid = s => !!(s && s.token && Date.now() < s.exp - 60000);

  async function api(s, url, opts = {}) {
    if (!valid(s)) throw err('auth');
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + s.token }, opts.headers) })); }
    catch (e) { throw err('offline'); }
    if (r.status === 401) { s.token = null; throw err('auth'); }
    if (!r.ok) {
      let m = ''; try { m = (await r.json()).error.message; } catch (e) { /* not JSON */ }
      throw err(r.status === 403 && /quota|storage/i.test(m) ? 'drive-full' : 'http', `Google error ${r.status}${m ? ': ' + m : ''}`);
    }
    return r;
  }

  /** Who signed in: {sub, email, name, picture}. sub is Google's permanent account ID. */
  async function userInfo(s) {
    const u = await (await api(s, 'https://www.googleapis.com/oauth2/v3/userinfo')).json();
    if (!u.sub) throw err('auth', 'Google did not return the account details.');
    return { sub: String(u.sub), email: u.email || '', name: u.name || u.given_name || '', given: u.given_name || '', picture: u.picture || '' };
  }

  /** The Cash Flow data file in this account's Drive, or null. Only files this app created are visible. */
  async function find(s) {
    const q = encodeURIComponent(`appProperties has { key='${TAG}' and value='1' } and trashed=false`);
    const r = await api(s, `${API}/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=1&spaces=drive&fields=files(id,name,modifiedTime,size,appProperties)`);
    const f = ((await r.json()).files || [])[0];
    return f ? { id: f.id, modified: f.modifiedTime, size: Number(f.size) || 0, txns: Number((f.appProperties || {}).txns) || 0 } : null;
  }

  /** Create or overwrite the data file. Drive keeps earlier versions for about 30 days (Manage versions). */
  async function save(s, text, info, existingId) {
    const meta = { name: FILE_NAME, appProperties: { [TAG]: '1', txns: String(info.txns), people: String(info.people) } };
    if (!existingId) Object.assign(meta, { mimeType: 'application/json', description: 'Your Cash Flow data. The Cash Flow app keeps this file in sync; please do not edit or move it.' });
    const qs = 'fields=id,modifiedTime,size';
    const path = existingId ? `${UPLOAD}/files/${encodeURIComponent(existingId)}` : `${UPLOAD}/files`;
    const method = existingId ? 'PATCH' : 'POST';
    if (new TextEncoder().encode(text).length <= MULTIPART_MAX) {
      const b = 'cashflow' + Math.random().toString(36).slice(2);
      const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--`;
      return (await api(s, `${path}?uploadType=multipart&${qs}`, { method, headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body })).json();
    }
    const start = await api(s, `${path}?uploadType=resumable&${qs}`, { method, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json' }, body: JSON.stringify(meta) });
    const loc = start.headers.get('Location');
    if (!loc) throw err('http', 'Google Drive did not accept the upload.');
    return (await api(s, loc, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text })).json();
  }

  /* Admin-only private settings (the GoatCounter read key for the Insights page), kept in the admin's own Drive
     so it follows them to every device without ever being published. A separate file from the Cash Flow data. */
  const ADMIN_TAG = 'cashflowAdmin', ADMIN_NAME = 'Cash Flow admin settings.json';
  async function findAdmin(s) {
    const q = encodeURIComponent(`appProperties has { key='${ADMIN_TAG}' and value='1' } and trashed=false`);
    const r = await api(s, `${API}/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=1&spaces=drive&fields=files(id,modifiedTime)`);
    const f = ((await r.json()).files || [])[0];
    return f ? { id: f.id, modified: f.modifiedTime } : null;
  }
  async function saveAdmin(s, text, existingId) {
    const meta = { name: ADMIN_NAME, appProperties: { [ADMIN_TAG]: '1' } };
    if (!existingId) Object.assign(meta, { mimeType: 'application/json', description: 'Private settings for the Cash Flow Insights page (admin only). Keep this file private; do not share it.' });
    const b = 'cashflow' + Math.random().toString(36).slice(2);
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--`;
    const path = existingId ? `${UPLOAD}/files/${encodeURIComponent(existingId)}` : `${UPLOAD}/files`;
    return (await api(s, `${path}?uploadType=multipart&fields=id,modifiedTime`, { method: existingId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body })).json();
  }

  async function download(s, id) { return (await api(s, `${API}/files/${encodeURIComponent(id)}?alt=media`)).text(); }

  /** Move the data file to the Drive Bin (recoverable there for 30 days). Never touches other files. */
  async function trash(s, id) {
    await api(s, `${API}/files/${encodeURIComponent(id)}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ trashed: true }) });
  }

  return { configured, preload, signIn, valid, userInfo, find, save, download, trash, findAdmin, saveAdmin };
})();
