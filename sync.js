/* Cash Flow: merging this device's data with the Google Drive copy.
   3-way merge: "base" is a fingerprint of the last version both sides agreed on (the last successful sync).
   - an item changed on one side only → that side's version
   - changed on both sides → the side with the newer edit (localNewer)
   - deleted on one side and unchanged on the other → deleted
   - deleted on one side but edited on the other → the edit is kept (nothing is lost silently)
   - never synced (no base) → union of both sides, nothing deleted
   Transaction IDs are built from the transaction itself, so the same statement imported on two devices merges cleanly. */
window.CFSync = (function () {
  const LISTS = ['profiles', 'accounts', 'statements', 'txns'];

  /** Short, fast fingerprint of any JSON value (FNV-1a 32-bit). Used only to detect changes, not for security. */
  function fp(v) {
    const s = JSON.stringify(v === undefined ? null : v);
    let x = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); }
    return (x >>> 0).toString(36);
  }
  /** What a synced version looked like: a fingerprint per item. Small enough to keep next to the data. */
  function fingerprint(d) {
    const f = { categories: fp(d.categories || []), rules: {} };
    for (const c of LISTS) { f[c] = {}; for (const it of d[c] || []) f[c][it.id] = fp(it); }
    for (const k in d.rules || {}) f.rules[k] = fp(d.rules[k]);
    return f;
  }
  /** Decide one item. l / r: the local / remote item (undefined = absent); b: its base fingerprint (undefined = not in base). */
  function pick(l, r, b, localNewer) {
    if (l !== undefined && r !== undefined) {
      const hl = fp(l), hr = fp(r);
      if (hl === hr) return l;
      if (b !== undefined && hl === b) return r;   // only remote changed
      if (b !== undefined && hr === b) return l;   // only local changed
      return localNewer ? l : r;                   // both changed (or both added): newer edit wins
    }
    if (l !== undefined) return b === undefined || fp(l) !== b ? l : undefined;  // remote deleted it; keep only if edited here
    if (r !== undefined) return b === undefined || fp(r) !== b ? r : undefined;  // local deleted it; keep only if edited there
    return undefined;
  }
  function mergeList(L, R, B, localNewer) {
    const lm = new Map(L.map(x => [x.id, x])), rm = new Map(R.map(x => [x.id, x]));
    const out = [], seen = new Set();
    for (const id of [...lm.keys(), ...rm.keys()]) {
      if (seen.has(id)) continue; seen.add(id);
      const v = pick(lm.get(id), rm.get(id), B[id], localNewer);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  /** Merge local and remote data. base: fingerprint() of the last synced version, or null if never synced. */
  function merge(local, remote, base, localNewer) {
    const clone = o => JSON.parse(JSON.stringify(o));
    if (!remote) return clone(local);
    if (!local) return clone(remote);
    const B = base || null;
    const out = Object.assign({}, remote, local, { version: 2 });
    for (const c of LISTS) out[c] = mergeList(local[c] || [], remote[c] || [], (B && B[c]) || {}, localNewer);
    out.categories = pick(local.categories || [], remote.categories || [], B ? B.categories : undefined, localNewer) || local.categories || [];
    out.rules = {};
    const lr = local.rules || {}, rr = remote.rules || {}, br = (B && B.rules) || {};
    for (const k of new Set([...Object.keys(lr), ...Object.keys(rr)])) {
      const v = pick(lr[k], rr[k], br[k], localNewer);
      if (v !== undefined) out.rules[k] = v;
    }
    // keep the data consistent: everything must belong to something that still exists
    if (!out.profiles.length) out.profiles = clone(local.profiles && local.profiles.length ? local.profiles : remote.profiles || []);
    const people = new Set(out.profiles.map(p => p.id));
    out.accounts = out.accounts.filter(a => people.has(a.profileId));
    const accts = new Set(out.accounts.map(a => a.id));
    out.statements = out.statements.filter(s => accts.has(s.accountId));
    out.txns = out.txns.filter(t => accts.has(t.accountId));
    return clone(out);
  }
  /** True when two data sets hold the same content (ignores order). */
  function same(a, b) {
    const fa = fingerprint(a), fb = fingerprint(b);
    if (fa.categories !== fb.categories) return false;
    for (const c of [...LISTS, 'rules']) {
      const x = fa[c], y = fb[c], kx = Object.keys(x);
      if (kx.length !== Object.keys(y).length || kx.some(k => x[k] !== y[k])) return false;
    }
    return true;
  }

  return { fp, fingerprint, merge, same };
})();
