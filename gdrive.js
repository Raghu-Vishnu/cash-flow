/* Cash Flow: optional backup to the user's OWN Google Drive.
   - Runs entirely in the browser. The backup goes straight from this device to Google; Cash Flow has no server.
   - Scope "drive.file": the app can see ONLY the files it created itself, not the rest of the user's Drive.
   - The access token lives in memory only (about 1 hour) and is never written to storage.
   Setup: the OAuth client ID comes from GOOGLE_CLIENT_ID in .env (locally) or the GitHub repository variable
   (live site), written into config.js by scripts/make-config.py. See README.md → "Google Drive backup". */
window.CFDrive = (function () {
  const CLIENT_ID = String((window.CF_CONFIG && window.CF_CONFIG.googleClientId) || '');
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FILE_NAME = 'Cash Flow backup.json';
  const TAG = 'cashflowBackup';
  const API = 'https://www.googleapis.com/drive/v3', UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const MULTIPART_MAX = 4 * 1024 * 1024; // larger backups use a resumable upload
  let token = null, tokenExp = 0, gis = null;

  const configured = () => !!CLIENT_ID;

  /** Load Google's sign-in library. Call early (not inside a click) so the sign-in popup isn't blocked later. */
  function preload() {
    if (!configured()) return Promise.reject(err('not-configured'));
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (!gis) gis = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = () => res();
      s.onerror = () => { gis = null; s.remove(); rej(err('offline')); };
      document.head.appendChild(s);
    });
    return gis;
  }
  function err(code, detail) { const e = new Error(detail || code); e.code = code; return e; }

  /** Get an access token. Must be called directly from a click, because it may open Google's popup. */
  function signIn(hint) {
    if (token && Date.now() < tokenExp - 60000) return Promise.resolve(token);
    if (!(window.google && google.accounts && google.accounts.oauth2)) return Promise.reject(err(navigator.onLine === false ? 'offline' : 'not-loaded'));
    return new Promise((res, rej) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPE, login_hint: hint || undefined,
        callback: r => {
          if (r.error) return rej(err(r.error === 'access_denied' ? 'denied' : 'auth', r.error_description || r.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return rej(err('scope'));
          token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000; res(token);
        },
        error_callback: e => rej(err(e && e.type === 'popup_failed_to_open' ? 'popup-blocked' : 'cancelled')),
      });
      client.requestAccessToken({ prompt: '' });
    });
  }

  async function api(url, opts = {}) {
    if (!token) throw err('auth');
    let r;
    try { r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers) })); }
    catch (e) { throw err('offline'); }
    if (r.status === 401) { token = null; throw err('auth'); }
    if (!r.ok) {
      let m = ''; try { m = (await r.json()).error.message; } catch (e) { /* not JSON */ }
      throw err(r.status === 403 && /quota|storage/i.test(m) ? 'drive-full' : 'http', `Google Drive error ${r.status}${m ? ': ' + m : ''}`);
    }
    return r;
  }

  /** Who is signed in (works with the drive.file scope; no extra permission needed). */
  async function whoAmI() {
    const u = (await (await api(`${API}/about?fields=user(emailAddress,displayName)`)).json()).user || {};
    return { email: u.emailAddress || '', name: u.displayName || '' };
  }

  /** The newest Cash Flow backup in Drive, or null. Only files this app created are visible. */
  async function find() {
    const q = encodeURIComponent(`appProperties has { key='${TAG}' and value='1' } and trashed=false`);
    const r = await api(`${API}/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=1&spaces=drive&fields=files(id,name,modifiedTime,size,appProperties)`);
    const f = ((await r.json()).files || [])[0];
    return f ? { id: f.id, modified: f.modifiedTime, size: Number(f.size) || 0, txns: Number((f.appProperties || {}).txns) || 0 } : null;
  }

  /** Create or overwrite the backup file. Drive keeps earlier versions for about 30 days (Manage versions). */
  async function save(text, info, existingId) {
    const meta = { name: FILE_NAME, appProperties: { [TAG]: '1', txns: String(info.txns), people: String(info.people) } };
    if (!existingId) Object.assign(meta, { mimeType: 'application/json', description: 'Backup from the Cash Flow app. Restore it in Cash Flow → Settings → Google Drive backup.' });
    const qs = 'fields=id,modifiedTime,size';
    const path = existingId ? `${UPLOAD}/files/${encodeURIComponent(existingId)}` : `${UPLOAD}/files`;
    const method = existingId ? 'PATCH' : 'POST';
    const bytes = new TextEncoder().encode(text).length;
    if (bytes <= MULTIPART_MAX) {
      const b = 'cashflow' + Math.random().toString(36).slice(2);
      const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--`;
      return (await api(`${path}?uploadType=multipart&${qs}`, { method, headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body })).json();
    }
    const start = await api(`${path}?uploadType=resumable&${qs}`, { method, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json' }, body: JSON.stringify(meta) });
    const loc = start.headers.get('Location');
    if (!loc) throw err('http', 'Google Drive did not accept the upload.');
    return (await api(loc, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text })).json();
  }

  async function download(id) { return (await api(`${API}/files/${encodeURIComponent(id)}?alt=media`)).text(); }

  /** Forget the token and remove Cash Flow's access to Drive. The backup file itself stays in Drive. */
  function disconnect() {
    const t = token; token = null; tokenExp = 0;
    try { if (t && window.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ }
  }

  return { configured, preload, signIn, whoAmI, find, save, download, disconnect, FILE_NAME };
})();
