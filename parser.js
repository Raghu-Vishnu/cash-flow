/* Statement parsing, verification and categorisation.
   Works in the browser (window.FT) and in Node (module.exports) so it can be tested. */
(function (root) {
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const round2 = n => Math.round(n * 100) / 100;
  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(y, m, d) {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, m, d));
    if (isNaN(dt) || dt.getUTCMonth() !== m || y < 1990 || y > 2100) return null;
    return `${y}-${pad(m + 1)}-${pad(d)}`;
  }

  /** Returns 'YYYY-MM-DD' or null. Indian banks use day-first dates. */
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date && !isNaN(v)) {
      // round to the nearest day: spreadsheet libraries can return 23:51 of the previous day in IST
      const r = new Date(v.getTime() + 12 * 3600e3);
      return iso(r.getFullYear(), r.getMonth(), r.getDate());
    }
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) { // Excel serial date (time of day ignored)
        const dt = new Date(Math.floor(v - 25569) * 86400000);
        return iso(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
      }
      return null;
    }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return iso(+m[1], +m[2] - 1, +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/.\s](\d{1,2})[-\/.\s](\d{2,4})\b/))) return iso(+m[3], +m[2] - 1, +m[1]);
    if ((m = s.match(/^(\d{1,2})[-\/.\s]?([A-Za-z]{3,9})[-\/.,\s]*(\d{2,4})\b/))) {
      const mo = MONTHS[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
      if (mo != null) return iso(+m[3], mo, +m[1]);
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/))) {
      const mo = MONTHS[m[1].toLowerCase().slice(0, 3)];
      if (mo != null) return iso(+m[3], mo, +m[2]);
    }
    return null;
  }

  /** "₹1,23,456.78 Cr", "(500.00)", "-20" → number (NaN if not a number). */
  function parseAmount(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    let s = String(v).trim();
    if (!s || s === '-') return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/(INR|Rs\.?|₹|\s|,)/gi, '').replace(/(cr|dr)\.?$/i, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (!/^\d*\.?\d+$/.test(s)) return NaN;
    const n = parseFloat(s);
    return neg ? -n : n;
  }

  /* ---------------- account number detection ---------------- */
  const ACCT_RE = /(?:a\/?c|acct|account)\s*(?:no|number|num|#)?\.?\s*[:\-]?\s*['"=]?\s*([0-9Xx*][0-9Xx*\s-]{3,26}[0-9])/i;
  /** Looks through the header text of a statement for its account number. Returns {last4, display} or null. */
  function detectAccountNumber(lines) {
    for (const raw of lines.slice(0, 80)) {
      const line = String(raw);
      if (/customer\s*id|cust\s*id|crn|ifsc|micr/i.test(line) && !/a\/?c|account/i.test(line)) continue;
      const m = line.match(ACCT_RE);
      if (!m) continue;
      const digits = m[1].replace(/[^0-9]/g, '');
      if (digits.length < 4) continue;
      const last4 = digits.slice(-4);
      return { last4, display: 'XXXX' + last4 };
    }
    return null;
  }

  /* ---------------- CSV / Excel ---------------- */
  const H = {
    date: /^(txn\.?|tran\.?|transaction|trans\.?|posting|post|value)?\s*date$|^date$/i,
    desc: /narration|description|particulars|remarks|details|transaction\s*details|merchant|payee/i,
    debit: /debit|withdrawal|dr\.?\s*amount|^dr\.?$|paid\s*out|money\s*out/i,
    credit: /credit|deposit|cr\.?\s*amount|^cr\.?$|paid\s*in|money\s*in/i,
    amount: /^(transaction\s*)?amount(\s*\(.*\))?$|^amt$|^inr$/i,
    type: /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|txn\s*type|transaction\s*type|debit\s*\/\s*credit)$/i,
    balance: /balance/i,
  };

  function findColumns(row) {
    const c = {};
    row.forEach((cell, i) => {
      const h = String(cell == null ? '' : cell).replace(/\s+/g, ' ').trim();
      if (!h || h.length > 40) return;
      if (H.balance.test(h)) { if (c.balance == null) c.balance = i; return; }
      if (H.date.test(h)) { if (c.date == null || /value/i.test(String(row[c.date]))) c.date = i; return; }
      if (H.type.test(h)) { c.type = i; return; }
      if (H.debit.test(h) && c.debit == null) { c.debit = i; return; }
      if (H.credit.test(h) && c.credit == null) { c.credit = i; return; }
      if (H.amount.test(h) && c.amount == null) { c.amount = i; return; }
      if (H.desc.test(h) && c.desc == null) { c.desc = i; return; }
    });
    return c.date != null && ((c.debit != null && c.credit != null) || c.amount != null) ? c : null;
  }

  const SUMMARY_ROW = /opening\s*balance|closing\s*balance|total|statement\s*summary|carried\s*forward|brought\s*forward|end\s*of\s*statement/i;

  /** rows: array of arrays (from CSV / Excel). */
  function rowsToTransactions(rows) {
    let hi = -1, cols = null;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      cols = findColumns(rows[i] || []);
      if (cols) { hi = i; break; }
    }
    const header = rows.slice(0, Math.max(hi, 0) + 1).map(r => (r || []).join(' '));
    const accountNo = detectAccountNumber(header.length > 1 ? header : rows.slice(0, 40).map(r => (r || []).join(' ')));
    if (!cols) return { transactions: [], unparsed: [], accountNo, opening: null, warnings: ['Could not find a header row with Date and Debit/Credit (or Amount) columns.'] };

    const out = [], unparsed = [];
    let opening = null;
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const text = r.filter(x => x !== '' && x != null).join(' | ');
      if (!text) continue;
      if (/opening\s*balance|balance\s*b\/?f/i.test(text) && opening == null) {
        const b = parseAmount(r[cols.balance]); if (!isNaN(b)) opening = b;
        continue;
      }
      const date = parseDate(r[cols.date]);
      const desc = String(cols.desc != null ? (r[cols.desc] ?? '') : '').replace(/\s+/g, ' ').trim();
      let amount, type;
      if (cols.debit != null && cols.credit != null) {
        const d = parseAmount(r[cols.debit]), cr = parseAmount(r[cols.credit]);
        if (!isNaN(cr) && cr !== 0) { amount = Math.abs(cr); type = 'credit'; }
        else if (!isNaN(d) && d !== 0) { amount = Math.abs(d); type = 'debit'; }
      } else {
        const a = parseAmount(r[cols.amount]);
        if (!isNaN(a) && a !== 0) {
          amount = Math.abs(a);
          const t = cols.type != null ? String(r[cols.type] || '') : String(r[cols.amount] || '');
          if (/\bcr|credit|deposit/i.test(t)) type = 'credit';
          else if (/\bdr|debit|withdraw/i.test(t)) type = 'debit';
          else type = a < 0 ? 'debit' : 'credit';
        }
      }
      if (!date || !amount) {
        // a row with a date OR an amount that we couldn't use is worth showing to the user
        if ((date || amount) && !SUMMARY_ROW.test(text)) unparsed.push(text.slice(0, 200));
        continue;
      }
      const bal = cols.balance != null ? parseAmount(r[cols.balance]) : NaN;
      out.push({ date, desc, amount: round2(amount), type, balance: isNaN(bal) ? null : bal });
    }
    return { transactions: out, unparsed, accountNo, opening, warnings: [] };
  }

  /** Parse a CSV string into rows. Handles quotes and auto-detects , ; or tab. */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/).slice(0, 30).join('\n');
    const delim = ['\t', ';', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell.trim()); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell.trim()); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
    return rows;
  }

  /* ---------------- PDF ---------------- */
  const AMT_RE = /\(?-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}\)?(?:\s?(?:Cr|Dr|CR|DR)\b\.?)?/g;
  // optional serial number, then a date at the start of the line
  const DATE_START = /^\s*(?:\d{1,4}\s+(?=\d{1,2}[-\/.]))?(\d{1,2}[-\/.\s](?:\d{1,2}|[A-Za-z]{3,9})[-\/.,\s]*\d{2,4}|\d{4}-\d{2}-\d{2})/;
  const DATE_ANY = /\b\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4}\b|\b\d{1,2}[-\s](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s,]*\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/gi;
  const STOP_LINE = /opening\s*balance|closing\s*balance|statement\s*summary|carried\s*forward|brought\s*forward|end\s*of\s*statement|^page\s*\d|page\s*\d+\s*of\s*\d+|^total\b|grand\s*total|generated\s*(by|on)\b|computer[\s-]*generated|registered\s*office|^\*/i;
  const HEADER_WORDS = /\b(date|narration|description|particulars|withdrawals?|deposits?|debits?|credits?|balance|chq|cheque|ref)\b/gi;
  // words that typically START a bank narration (used to decide which row a wrapped line belongs to)
  const NARR_START = /^(upi|neft|imps|rtgs|ach|nach|ecs|pos|atw|nwd|eaw|atm|chq|cheque|cash|ib|mb|inb|bil|bill|emi|ft|tpt|int|interest|rev|reversal|sal|salary|by|to|trf|transfer|cms|clg|mmt|vps|ips|ecom|onl|fd|rd|sweep|chrg|charges|gst|dc|cc|loan|refund)\b[\s\/:\-*.]/i;
  const countAmts = s => (s.replace(DATE_ANY, ' ').match(AMT_RE) || []).length;
  // a wrapped table-header line such as "Amt. Amt. Balance" (only column-title words, no digits)
  const HEADER_TOKENS = new Set('amt amount amounts balance closing opening no ref dt date value withdrawal withdrawals deposit deposits narration description particulars debit debits credit credits chq cheque txn tran transaction details remarks inr rs cr dr s sl sr of in type'.split(' '));
  const isHeaderOnly = s => !/\d/.test(s) && s.split(/[\s.\/()*:#-]+/).filter(Boolean).every(w => HEADER_TOKENS.has(w.toLowerCase()));

  /**
   * lines: the PDF's visual lines — plain strings, or {text, y, page} (y = vertical position, larger = higher on the page).
   * Each transaction starts at a line that begins with a date. Narrations that wrap are re-attached:
   *  - top-aligned tables: extra lines belong to the row ABOVE them;
   *  - vertically-centred tables (e.g. HDFC): extra lines sit above AND below the date line, so each goes to the
   *    nearest row by position (ties: a line starting with UPI-/NEFT/… begins the next row's narration).
   * Debit vs credit comes from the change in running balance; Dr/Cr markers and keywords are fallbacks.
   */
  function pdfLinesToTransactions(input) {
    const L = (input || []).map((l, i) => typeof l === 'string' || l == null
      ? { text: String(l == null ? '' : l), y: null, page: 0, i }
      : { text: l.text != null ? String(l.text) : (l.items || []).join(' '), y: typeof l.y === 'number' ? l.y : null, x: typeof l.x === 'number' ? l.x : null, page: l.page || 0, i });
    const accountNo = detectAccountNumber(L.map(l => l.text));
    const hasY = L.length > 0 && L.every(l => l.y != null);
    // Where does the Date column start? (most common x of date-led lines that carry amounts)
    const xs = {};
    for (const l of L) if (l.x != null && DATE_START.test(l.text) && countAmts(l.text)) { const k = Math.round(l.x / 4); xs[k] = (xs[k] || 0) + 1; }
    const xKey = Object.keys(xs).sort((a, b) => xs[b] - xs[a])[0];
    const dateColX = xKey != null ? +xKey * 4 : null;
    /** Is this date-led line a real transaction row, or a narration line that happens to start with a date? */
    const isRow = (l, rest) => {
      if (dateColX != null && l.x != null) return Math.abs(l.x - dateColX) <= 12;
      return countAmts(l.text) > 0 || /[a-z]{3}/i.test(rest.replace(DATE_ANY, ' ').replace(/\bto\b/gi, ' '));
    };
    let opening = null, seg = 0, cur = null;
    const recs = [], orphans = [];
    for (const l of L) {
      const line = l.text.replace(/\s+/g, ' ').trim();
      if (!line) continue;
      if (opening == null && /opening\s*balance|balance\s*b\/?f|brought\s*forward/i.test(line)) {
        const a = line.replace(DATE_ANY, ' ').match(AMT_RE);
        if (a) opening = parseAmount(a[a.length - 1]) * (/dr\.?$/i.test(a[a.length - 1]) ? -1 : 1);
      }
      const dm = line.match(DATE_START);
      const date = dm && parseDate(dm[1]);
      if (date && !STOP_LINE.test(line) && isRow(l, line.slice(dm[0].length))) {
        cur = { date, y: l.y, page: l.page, seg, parts: [{ i: l.i, y: l.y, text: line.slice(dm[0].length) }] };
        recs.push(cur);
        for (let k = orphans.length - 1; k >= 0 && orphans[k].seg === seg && !orphans[k].next; k--) orphans[k].next = cur;
        continue;
      }
      if (STOP_LINE.test(line) || (line.match(HEADER_WORDS) || []).length >= 3 || isHeaderOnly(line)) { seg++; cur = null; continue; }
      orphans.push({ i: l.i, y: l.y, page: l.page, seg, text: line, prev: cur, next: null });
    }

    // lines between a table header and the first row => the table is vertically centred
    const middle = orphans.some(o => !o.prev && o.next);
    // Centred tables with positions: between two rows, the widest vertical gap is the cell border/padding,
    // so lines above it belong to the upper row and lines below it to the lower row.
    if (middle && hasY) {
      const groups = new Map();
      for (const o of orphans) if (o.prev && o.next && o.page === o.prev.page && o.page === o.next.page) {
        const k = recs.indexOf(o.prev); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o);
      }
      for (const g of groups.values()) {
        g.sort((a, b) => b.y - a.y);
        const pos = [g[0].prev.y, ...g.map(o => o.y), g[0].next.y];
        const gaps = pos.slice(1).map((p, j) => pos[j] - p);
        const max = Math.max(...gaps);
        const cands = gaps.map((v, j) => j).filter(j => max - gaps[j] < 1.5);
        const cut = cands.find(j => j < g.length && NARR_START.test(g[j].text)) ?? cands[0]; // orphans [0, cut) go up
        g.forEach((o, j) => { o.side = j < cut ? 'prev' : 'next'; });
      }
    }
    for (const o of orphans) {
      let t = null;
      if (!middle) t = o.prev;
      else if (!o.prev || !o.next) t = o.prev || o.next;
      else if (o.side) t = o[o.side];
      else t = NARR_START.test(o.text) ? o.next : o.prev;
      if (!t || t.closed || t.parts.length >= 12) continue;
      if (countAmts(o.text) && countAmts(t.parts.map(p => p.text).join(' ')) >= 2) { if (!middle) t.closed = true; continue; } // not part of this row
      t.parts.push({ i: o.i, y: o.y, text: o.text });
    }

    for (const r of recs) {
      r.parts.sort((a, b) => (hasY && a.y !== b.y ? b.y - a.y : a.i - b.i)); // top to bottom
      r.raw = r.date + ' ' + r.parts.map(p => p.text).join(' / ');
      const text = r.parts.map(p => p.text).join(' ').replace(DATE_ANY, ' ');
      r.amts = text.match(AMT_RE) || [];
      r.desc = text.replace(AMT_RE, ' ').replace(/\s+/g, ' ').trim();
    }
    const withAny = recs.filter(r => r.amts.length >= 1).length;
    const hasBal = recs.filter(r => r.amts.length >= 2).length >= withAny * 0.5;
    if (recs.length > 1 && recs[0].date > recs[recs.length - 1].date) recs.reverse(); // newest-first statements

    const out = [], unparsed = [];
    let prevBal = opening;
    for (const r of recs) {
      if (!r.amts.length) continue;
      if (hasBal && r.amts.length < 2) { unparsed.push(r.raw.slice(0, 200)); continue; }
      let amount, type, bal = null;
      const toks = hasBal ? r.amts.slice(0, -1) : r.amts;
      if (hasBal) {
        const bt = r.amts[r.amts.length - 1];
        bal = parseAmount(bt) * (/dr\.?$/i.test(bt) ? -1 : 1);
      }
      const cands = toks.map((tk, i) => ({ tk, i, v: Math.abs(parseAmount(tk)) })).filter(c => c.v > 0);
      if (!cands.length) { unparsed.push(r.raw.slice(0, 200)); continue; }
      if (hasBal && prevBal != null) {
        const delta = round2(bal - prevBal);
        const hit = cands.find(c => Math.abs(c.v - Math.abs(delta)) < 0.011);
        if (hit) { amount = hit.v; type = delta > 0 ? 'credit' : 'debit'; }
      }
      if (!type) {
        const c = cands[cands.length - 1];
        amount = c.v;
        if (/cr\.?$/i.test(c.tk)) type = 'credit';
        else if (/dr\.?$/i.test(c.tk)) type = 'debit';
        else if (toks.length === 2) type = c.i === 0 ? 'debit' : 'credit'; // "withdrawal deposit balance" with 0.00 in the unused column
        else type = /salary|neft\s*cr|imps\s*cr|upi\/cr|\bcr\b|credit|refund|interest|int\.?\s*pd|cashback|deposit|received/i.test(r.desc) ? 'credit' : 'debit';
      }
      out.push({ date: r.date, desc: r.desc.slice(0, 200), amount: round2(amount), type, balance: bal });
      if (bal != null && !isNaN(bal)) prevBal = bal;
    }
    const warnings = out.length ? [] : ['No transactions found in this PDF. If it is a scanned image, download the CSV/Excel version from your bank instead.'];
    return { transactions: out, unparsed, accountNo, opening, warnings };
  }

  /**
   * Verifies a statement using its running balance: previous balance ± amount must equal the next balance.
   * Any jump that no transaction explains is reported as a gap (= something was missed or misread).
   */
  function reconcile(txns, opening) {
    let list = txns.slice();
    if (list.length > 1 && list[0].date > list[list.length - 1].date) list.reverse();
    let prev = opening != null && !isNaN(opening) ? opening : null, prevDate = null, checked = 0;
    const gaps = [];
    for (const t of list) {
      if (t.balance == null || isNaN(t.balance)) continue;
      if (prev != null) {
        const expected = prev + (t.type === 'credit' ? t.amount : -t.amount);
        const diff = round2(t.balance - expected);
        checked++;
        if (Math.abs(diff) > 0.01) gaps.push({ from: prevDate, to: t.date, amount: Math.abs(diff), kind: diff > 0 ? 'credit' : 'debit', near: t.desc.slice(0, 80) });
      }
      prev = t.balance; prevDate = t.date;
    }
    return { verified: checked > 0, checked, gaps };
  }

  /* ---------------- categorisation ---------------- */
  // Order matters: the first matching category wins.
  const DEFAULT_CATEGORIES = [
    { name: 'Self Transfer', type: 'any', keywords: ['self transfer', 'own account', 'to self', 'from self', 'sweep'] },
    { name: 'Salary', type: 'credit', keywords: ['salary', 'sal', 'payroll', 'stipend'] },
    { name: 'Interest & Dividends', type: 'credit', keywords: ['interest', 'int pd', 'int cr', 'dividend', 'div'] },
    { name: 'Refunds & Cashback', type: 'credit', keywords: ['refund', 'cashback', 'reversal', 'reversed', 'chargeback'] },
    { name: 'Other Income', type: 'credit', keywords: [], fallback: true },
    { name: 'Investments', type: 'debit', keywords: ['sip', 'mutual fund', 'mf', 'zerodha', 'groww', 'upstox', 'kuvera', 'angel one', 'nps', 'ppf', 'recurring deposit', 'rd', 'smallcase', 'indmoney', 'paytm money', 'bse ltd', 'nse clearing'] },
    { name: 'Insurance', type: 'debit', keywords: ['lic', 'insurance', 'policy', 'premium', 'acko', 'hdfc life', 'icici pru', 'max life', 'star health'] },
    { name: 'Food & Dining', type: 'debit', keywords: ['swiggy', 'zomato', 'restaurant', 'cafe', 'coffee', 'starbucks', 'domino', 'pizza', 'kfc', 'mcdonald', 'burger', 'eatsure', 'biryani', 'bakery', 'tea', 'chai'] },
    { name: 'Groceries', type: 'debit', keywords: ['bigbasket', 'blinkit', 'zepto', 'instamart', 'dmart', 'grofers', 'more retail', 'reliance fresh', 'spencer', 'grocery', 'supermarket', 'kirana', 'jiomart', 'milk', 'dairy'] },
    { name: 'Shopping', type: 'debit', keywords: ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'nykaa', 'tata cliq', 'lifestyle', 'decathlon', 'ikea', 'croma', 'reliance digital', 'trends'] },
    { name: 'Transport & Fuel', type: 'debit', keywords: ['uber', 'ola', 'rapido', 'irctc', 'redbus', 'metro', 'petrol', 'fuel', 'diesel', 'hpcl', 'bpcl', 'iocl', 'indian oil', 'fastag', 'parking', 'indigo', 'air india', 'makemytrip', 'goibibo', 'cleartrip'] },
    { name: 'Bills & Utilities', type: 'debit', keywords: ['electricity', 'bescom', 'tneb', 'tangedco', 'msedcl', 'bses', 'tata power', 'water bill', 'gas bill', 'indane', 'bharat gas', 'airtel', 'jio', 'vodafone', 'bsnl', 'broadband', 'act fibernet', 'recharge', 'dth', 'tata play', 'postpaid', 'bill pay'] },
    { name: 'Rent', type: 'debit', keywords: ['rent', 'nobroker', 'landlord', 'maintenance', 'society'] },
    { name: 'Credit Card Bills', type: 'debit', keywords: ['credit card', 'cc payment', 'card payment', 'cred'] },
    { name: 'EMI & Loans', type: 'debit', keywords: ['emi', 'loan', 'nach', 'ach', 'ecs', 'bajaj fin', 'home credit'] },
    { name: 'Health', type: 'debit', keywords: ['pharmacy', 'apollo', 'medplus', '1mg', 'netmeds', 'pharmeasy', 'hospital', 'clinic', 'diagnostic', 'doctor', 'medical', 'chemist'] },
    { name: 'Entertainment', type: 'debit', keywords: ['netflix', 'prime video', 'hotstar', 'spotify', 'youtube', 'bookmyshow', 'pvr', 'inox', 'zee5', 'sonyliv', 'jiocinema', 'google play'] },
    { name: 'Education', type: 'debit', keywords: ['school', 'college', 'tuition', 'course', 'udemy', 'coursera', 'fees', 'exam'] },
    { name: 'Cash Withdrawal', type: 'debit', keywords: ['atm', 'cash wdl', 'cash withdrawal', 'nwd', 'atw'] },
    { name: 'Charges & Fees', type: 'debit', keywords: ['charges', 'fee', 'gst', 'penalty', 'annual fee', 'sms alert', 'min bal'] },
    { name: 'UPI / Others', type: 'debit', keywords: [], fallback: true },
  ];
  const FALLBACK = { credit: 'Other Income', debit: 'UPI / Others' };
  const EXCLUDED = 'Self Transfer';

  function kwRegex(kw) {
    const k = kw.trim().toLowerCase();
    if (!k) return null;
    const body = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._/-]*');
    // short keywords must be whole words ("ola" must not match "Motorola")
    return k.length <= 4 ? `(?<![a-z0-9])${body}(?![a-z0-9])` : body;
  }
  /** Compile user-editable categories into matchers. */
  function compileCategories(cats) {
    return cats.filter(c => !c.fallback && c.keywords && c.keywords.length).map(c => {
      const parts = c.keywords.map(kwRegex).filter(Boolean);
      return { name: c.name, type: c.type, re: parts.length ? new RegExp(parts.join('|'), 'i') : null };
    }).filter(c => c.re);
  }
  const DEFAULT_COMPILED = compileCategories(DEFAULT_CATEGORIES);

  const STOP = new Set(['UPI', 'DR', 'CR', 'IMPS', 'NEFT', 'RTGS', 'POS', 'ECOM', 'TO', 'FROM', 'BY', 'TRANSFER', 'TRF', 'MB', 'IB', 'INB', 'P2A', 'P2M', 'PAYMENT', 'PAY', 'SENT', 'RECEIVED', 'VIA', 'REF', 'NA', 'INR', 'MOB', 'BIL', 'ONL', 'ACH', 'NACH', 'VPS', 'IPS', 'D', 'C']);
  /** Best-effort counterparty from a narration, e.g. "UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl" → "Swiggy". */
  function extractMerchant(desc) {
    if (!desc) return 'Unknown';
    if (/\batm\b|\batw\b|\bnwd\b|cash\s*w/i.test(desc)) return 'ATM Cash';
    const parts = desc.split(/[\/\-|:*]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const w = p.replace(/@.*$/, '').split(/\s+/).filter(x => !STOP.has(x.toUpperCase()) && !/\d{3,}|X{4,}/i.test(x)).join(' ').trim();
      if (w.length < 3) continue;
      if (/^(billdesk|razorpay|payu|paytm|cashfree|ccavenue|phonepe|gpay|bharatpe)$/i.test(w)) continue;
      if (/^[A-Z]{4}0?[A-Z0-9]{0,7}$/.test(w) && w.length <= 11 && /\d/.test(w)) continue;
      if (/^(YESB|HDFC|ICIC|SBIN|UTIB|KKBK|PUNB|BARB|AXIS|IDFB|INDB|YBL|OKAXIS|OKSBI|OKHDFCBANK|OKICICI|IBL|APL|AXL)$/i.test(w)) continue;
      return w.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40);
    }
    return /[a-z]{3}/i.test(desc) ? desc.slice(0, 40) : 'Unknown'; // only numbers/references: no usable name
  }

  /** merchantRules: { merchantLowercase: category } learned from the user's edits; compiled: from compileCategories. */
  function categorize(t, merchantRules, compiled) {
    const m = (t.merchant || extractMerchant(t.desc)).toLowerCase();
    if (merchantRules && merchantRules[m]) return merchantRules[m];
    for (const c of compiled || DEFAULT_COMPILED) {
      if (c.type !== 'any' && c.type !== t.type) continue;
      if (c.re.test(t.desc)) return c.name;
    }
    return FALLBACK[t.type];
  }

  /**
   * Salary often arrives without "SALARY" or the employer's name in the narration (e.g. a plain UPI/IMPS credit).
   * Finds income still in the fallback category that looks like an already-recognised salary in the same account:
   * amount within 15%, at least ₹5,000, received in the first or last week of a month, in a month with no salary yet.
   * Transactions the user categorised themselves (userSet/manual) or that have a merchant rule are never touched.
   * Returns the ids to mark as Salary.
   */
  function findSalaryLike(txns, merchantRules) {
    const out = [], byAcct = {};
    for (const t of txns) (byAcct[t.accountId] = byAcct[t.accountId] || []).push(t);
    for (const list of Object.values(byAcct)) {
      const sal = list.filter(t => t.type === 'credit' && t.category === 'Salary' && !t.autoSalary);
      if (!sal.length) continue;
      const months = new Set(list.filter(t => t.type === 'credit' && t.category === 'Salary').map(t => t.date.slice(0, 7)));
      for (const t of list) {
        if (t.type !== 'credit' || t.category !== FALLBACK.credit || t.manual || t.userSet || t.amount < 5000) continue;
        if (merchantRules && merchantRules[String(t.merchant || '').toLowerCase()]) continue;
        const day = +t.date.slice(8, 10);
        if (day > 7 && day < 25) continue;
        if (months.has(t.date.slice(0, 7))) continue;
        if (sal.some(s => Math.abs(t.amount - s.amount) <= 0.15 * s.amount)) { out.push(t.id); months.add(t.date.slice(0, 7)); }
      }
    }
    return out;
  }

  /** Stable fingerprint used to skip the same transaction when statements overlap. */
  function baseKey(t) {
    return [t.date, t.type, t.amount.toFixed(2), String(t.desc).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)].join('|');
  }

  /* ---------------- anonymised diagnostics ---------------- */
  // Words that are safe to keep because they describe the statement's structure, not the person.
  // Every other word is replaced, so unknown names and addresses are hidden by default.
  const KEEP_WORDS = new Set(`upi imps neft rtgs nach ach ecs pos atm atw nwd dr cr debit credit to by from transfer trf inb mb ib
    p2a p2m ref no chq cheque date value dt txn tran transaction transactions narration description particulars details remarks
    withdrawal withdrawals deposit deposits amt amount amounts balance closing opening total page of statement account acct ac a c
    period salary sal interest int pd refund cashback charges charge gst fee fees emi loan sip mf payment pay paid bill bills recharge
    self sweep cash bank ltd limited pvt private india in on at the and for carried forward brought summary grand end online mobile
    banking branch ifsc micr customer cust id name address email phone type savings current joint nominee holder number num rs inr
    sb ca od fd tax tds reversal rev ecom bil onl vps ips mmt nfs card visa rupay mastercard utr sent received via na clearing clg
    inward outward return rtn auto autopay mandate si standing instruction generated report sl s no serial opening pan birth dob
    jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december
    hdfc icic icici sbi sbin axis utib kkbk kotak yesb yes punb pnb barb bob idfb idfc indb canara cnrb ioba iob ubin bkid boi
    federal fdrl rbl ratn paytm ybl okaxis oksbi okhdfcbank okicici ibl apl axl ptys ptyes pthdfc ptaxis ptsbi gpay phonepe
    bharatpe razorpay billdesk payu cashfree ccavenue amazonpay`.split(/\s+/).filter(Boolean));
  DEFAULT_CATEGORIES.forEach(c => c.keywords.forEach(k => k.split(/\s+/).forEach(w => KEEP_WORDS.add(w))));
  const MONTH_ALT = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
  const TOKEN_RE = new RegExp(
    `(\\d{1,2}[-\\/.]\\d{1,2}[-\\/.]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[-\\s]?(?:${MONTH_ALT})[a-z]*[-\\s,]*\\d{2,4})` + // date
    `|((?:\\d{1,3}(?:,\\d{2,3})+|\\d+)\\.\\d{2}(?!\\d))` +                                                           // amount
    `|([A-Za-z0-9._%+]+@[A-Za-z0-9]+(?:\\.[A-Za-z0-9]+)*)` +                                                         // email / UPI id
    `|([A-Za-z0-9]+)`, 'gi');                                                                                          // word / number
  const SAFE_DOMAIN = /^(com|in|net|org|co|gov|gmail|yahoo|outlook|hotmail|rediffmail|icloud)$/i;

  /** Returns {line(text), cell(value)} that hide personal details but keep dates, amounts and statement structure. */
  function makeAnonymizer() {
    const names = new Map();
    const pseudo = w => { const k = w.toUpperCase(); if (!names.has(k)) names.set(k, 'W' + (names.size + 1)); return names.get(k); };
    const word = w => {
      if (/^\d+$/.test(w)) return w.replace(/\d/g, '0');                       // account / ref / phone numbers
      if (/\d/.test(w)) {                                                        // IFSC, PAN, masked cards, refs
        const m = w.match(/^([A-Za-z]+)(\d.*)$/);
        const head = m && KEEP_WORDS.has(m[1].toLowerCase()) ? m[1] : (m ? m[1].replace(/[A-Za-z]/g, 'X') : '');
        return head + (m ? m[2] : w).replace(/[A-Za-z]/g, 'X').replace(/\d/g, '0');
      }
      if (w.length <= 1 || KEEP_WORDS.has(w.toLowerCase())) return w;
      return pseudo(w);
    };
    function line(s) {
      s = String(s == null ? '' : s);
      const dob = /birth|\bdob\b|d\.o\.b/i.test(s);
      return s.replace(TOKEN_RE, (m, date, amt, email, w) => {
        if (date) {
          const y = +((date.match(/(\d{2,4})\s*$/) || [])[1] || 0), yy = y < 100 ? 2000 + y : y;
          return dob || yy < 2010 ? date.replace(/\d/g, '0') : date;              // birth dates hidden
        }
        if (amt) return amt;
        if (email) {
          const [local, dom] = email.split('@');
          return (KEEP_WORDS.has(local.toLowerCase()) ? local : 'user') + '@' +
            dom.split('.').map(p => KEEP_WORDS.has(p.toLowerCase()) || SAFE_DOMAIN.test(p) ? p : 'xx').join('.');
        }
        return word(w);
      }).replace(/[^\x00-\x7F₹]+/g, '…');                                       // any non-English script
    }
    function cell(v) {
      if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) >= 1e8 ? String(Math.abs(v)).replace(/\d/g, '0') : v; // 9+ digit integers are account/ref numbers, not amounts
      if (v instanceof Date) return v;                                           // Excel dates
      const s = String(v == null ? '' : v).trim();
      if (/^\(?-?\s*(?:₹|rs\.?|inr)?\s*(?:\d{1,3}(?:,\d{2,3})+|\d{1,8})(?:\.\d{1,2})?\s*\)?\s*(?:cr|dr)?\.?$/i.test(s)) return s; // a plain amount
      return line(s);
    }
    return { line, cell, count: () => names.size };
  }

  const n2 = n => (n == null || isNaN(n) ? '' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const sig = r => r.transactions.map(t => `${t.date}|${t.type}|${t.amount}|${t.balance}`).join('\n');

  /**
   * Builds a shareable, anonymised troubleshooting report.
   * input: { fileType, pdfLines: [{page, items: [text]}] } or { fileType, rows: [[cells]] }
   */
  function diagnose(input) {
    const an = makeAnonymizer();
    let res, anonRes;
    const raw = [];
    if (input.pdfLines) {
      const geo = l => ({ y: typeof l.y === 'number' ? l.y : null, x: typeof l.x === 'number' ? l.x : null, page: l.page });
      res = pdfLinesToTransactions(input.pdfLines.map(l => Object.assign({ text: l.items.join(' ') }, geo(l))));
      const anonItems = input.pdfLines.map(l => l.items.map(an.line));
      anonRes = pdfLinesToTransactions(anonItems.map((a, i) => Object.assign({ text: a.join(' ') }, geo(input.pdfLines[i]))));
      let pg = 0;
      input.pdfLines.forEach((l, i) => {
        if (l.page !== pg) { pg = l.page; raw.push(`--- page ${pg} ---`); }
        raw.push(String(i + 1).padStart(4, '0') + (typeof l.y === 'number' ? ` y${Math.round(l.y)}` : '') + (typeof l.x === 'number' ? ` x${Math.round(l.x)}` : '') + ': ' + anonItems[i].join(' ¦ '));
      });
    } else {
      res = rowsToTransactions(input.rows);
      const arows = input.rows.map(r => (r || []).map(an.cell));
      anonRes = rowsToTransactions(arows);
      arows.forEach((r, i) => raw.push(String(i + 1).padStart(4, '0') + ': ' + r.map(c => c instanceof Date ? c.toISOString() : String(c)).join(' ¦ ')));
    }
    const same = sig(res) === sig(anonRes);
    const tx = res.transactions, chk = reconcile(tx, res.opening);
    const credits = tx.filter(t => t.type === 'credit'), dates = tx.map(t => t.date).sort();
    const months = {};
    for (const t of tx) {
      const m = months[t.date.slice(0, 7)] || (months[t.date.slice(0, 7)] = { n: 0, inc: 0, exp: 0 });
      m.n++; t.type === 'credit' ? (m.inc += t.amount) : (m.exp += t.amount);
    }
    const out = [];
    out.push('CASH FLOW: ANONYMISED STATEMENT DIAGNOSTICS');
    out.push(`Created: ${new Date().toISOString().slice(0, 10)} | File type: ${input.fileType}` +
      (input.pdfLines ? ` | Pages: ${new Set(input.pdfLines.map(l => l.page)).size} | Text lines: ${input.pdfLines.length}` : ` | Rows: ${input.rows.length}`));
    out.push('Personal details were replaced: names/words -> W1, W2... (same word = same code), account/reference/phone numbers -> 0000,');
    out.push('UPI IDs -> user@bank, birth dates -> 00/00/0000. Dates, amounts and balances are kept so the reader can be checked.');
    out.push('Please read through it before sharing.');
    out.push('', '== SUMMARY ==');
    out.push(`Account number found in file: ${res.accountNo ? 'yes (hidden)' : 'no'}`);
    out.push(`Opening balance found: ${res.opening != null ? n2(res.opening) : 'no'}`);
    out.push(`Transactions read: ${tx.length} (${credits.length} income, ${tx.length - credits.length} expense)` + (tx.length ? `, ${dates[0]} to ${dates[dates.length - 1]}` : ''));
    Object.keys(months).sort().forEach(k => out.push(`  ${k}: ${String(months[k].n).padStart(4)} txns | in ${n2(months[k].inc).padStart(14)} | out ${n2(months[k].exp).padStart(14)}`));
    out.push(`Balance check: ${chk.verified ? `${chk.checked} checked, ${chk.gaps.length} gap(s)` : 'not possible (no running balance found)'}`);
    chk.gaps.forEach(g => out.push(`  - ${g.from || '?'} to ${g.to}: ${n2(g.amount)} more ${g.kind === 'credit' ? 'came in' : 'went out'} than the transactions show (near "${an.line(g.near)}")`));
    out.push(`Lines that looked like transactions but could not be read: ${res.unparsed.length}`);
    res.unparsed.slice(0, 30).forEach(u => out.push('  ' + an.line(u)));
    out.push(`Anonymised copy reads the same as the original: ${same ? 'YES' : 'NO (some details below may differ from what the app read)'}`);
    res.warnings.forEach(w => out.push('Warning: ' + w));
    out.push('', '== TRANSACTIONS AS READ ==', 'date       | type   |         amount |        balance | description');
    tx.forEach(t => out.push(`${t.date} | ${t.type.padEnd(6)} | ${n2(t.amount).padStart(14)} | ${n2(t.balance).padStart(14)} | ${an.line(t.desc)}`));
    out.push('', `== RAW TEXT (anonymised${input.pdfLines ? '; ¦ separates text pieces on a line' : '; ¦ separates cells'}) ==`);
    out.push(...raw);
    return { text: out.join('\n'), summary: { count: tx.length, income: credits.length, gaps: chk.gaps.length, verified: chk.verified, unparsed: res.unparsed.length, same, accountFound: !!res.accountNo } };
  }

  const api = {
    parseDate, parseAmount, parseCSV, rowsToTransactions, pdfLinesToTransactions, reconcile, detectAccountNumber,
    categorize, compileCategories, extractMerchant, baseKey, findSalaryLike, makeAnonymizer, diagnose, DEFAULT_CATEGORIES, FALLBACK, EXCLUDED,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FT = api;
})(this);
