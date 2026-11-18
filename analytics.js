/* Cash Flow: anonymous usage counts (GoatCounter), so the product owner can see how the app is used.
   PRIVACY RULES, enforced here:
   - Only fixed event names chosen in the code are ever sent (for example "download-pdf" or "import-ok-csv").
     Nothing typed or uploaded by the user is sent: no names, emails, Google IDs, amounts, transactions,
     merchants, descriptions, bank or account numbers, or file names.
   - No cookies and no ID of any kind. Requests are sent without a referrer.
     GoatCounter does not store IP addresses (it keeps an 8-hour in-memory visit counter only).
   - On by default with a switch in Settings. Off by default when the browser asks not to be tracked
     (Do Not Track / Global Privacy Control). Off entirely when no GoatCounter code is configured,
     and on localhost.
   Setup: GOATCOUNTER_CODE in .env / the GitHub repository variable → config.js (scripts/make-config.py). */
window.CFStats = (function () {
  const cfg = window.CF_CONFIG || {};
  const CODE = String(cfg.goatcounterCode || '').trim().toLowerCase();
  const PREF = 'cashflow.stats';
  const isLocal = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(location.hostname) && !cfg.goatcounterAllowLocal;
  const configured = () => /^[a-z0-9][a-z0-9-]{1,48}$/.test(CODE);
  const privacySignal = () => navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
  const pref = () => { try { return localStorage.getItem(PREF); } catch (e) { return null; } };
  /** Is counting on for this browser? */
  function enabled() {
    if (!configured() || isLocal) return false;
    const p = pref();
    return p === null ? !privacySignal() : p === 'on';
  }
  function setEnabled(on) { try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch (e) { /* ignore */ } }
  // event names are code-chosen; this also strips anything unexpected, so free text could never slip through
  const clean = s => String(s).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  function send(p, isEvent) {
    if (!enabled() || !p) return;
    const q = new URLSearchParams({ p, t: p, rnd: Math.random().toString(36).slice(2, 8) });
    if (isEvent) q.set('e', 'true');
    try {
      fetch(`https://${CODE}.goatcounter.com/count?${q}`, { mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true }).catch(() => {});
    } catch (e) { /* counting must never break the app */ }
  }
  const sent = new Set();
  return {
    configured, enabled, setEnabled, privacySignal, code: CODE,
    /** Count an event, e.g. event('download-pdf'). */
    event: name => send(clean(name), true),
    /** Count an event at most once per app session (for things that can repeat a lot, like syncing). */
    once: name => { const n = clean(name); if (!n || sent.has(n)) return; sent.add(n); send(n, true); },
    /** Count a screen view, e.g. page('dashboard'). */
    page: name => { const n = clean(name); if (n) send('/' + n, false); },
  };
})();
