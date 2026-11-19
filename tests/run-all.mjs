// Runs every Cash Flow test suite:  node tests/run-all.mjs   (or one suite: node tests/run-all.mjs t-sync)
// Starts headless Chrome with a throwaway profile, runs each suite in its own process, prints a summary, closes Chrome.
// Needs Node 22+ and Google Chrome (set CHROME=/path/to/chrome if it isn't in the usual place).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.CDP_PORT || '9333';
const ALL = ['t-merge', 't-sync', 't-insights', 't-invest', 't-update'];
const NEEDS_CHROME = new Set(['t-sync', 't-insights', 't-invest', 't-update']);
const pick = process.argv.slice(2);
const suites = pick.length ? ALL.filter(s => pick.includes(s)) : ALL;

function findChrome() {
  const candidates = [process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(c => c && fs.existsSync(c));
}

let chrome = null, profile = null;
async function startChrome() {
  const bin = findChrome();
  if (!bin) throw new Error('Google Chrome not found. Set CHROME=/path/to/chrome and try again.');
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-test-'));
  chrome = spawn(bin, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Chrome did not start.');
}
function stopChrome() {
  if (chrome) { chrome.kill(); chrome = null; }
  if (profile) { setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500); }
}

const results = [];
try {
  if (suites.some(s => NEEDS_CHROME.has(s))) await startChrome();
  for (const s of suites) {
    console.log(`\n━━ ${s} ━━`);
    const r = spawnSync(process.execPath, [path.join(DIR, s + '.mjs')], { stdio: 'inherit', env: { ...process.env, CDP_PORT: PORT } });
    results.push([s, r.status === 0]);
  }
} catch (e) {
  console.error('\n' + e.message);
  process.exitCode = 1;
} finally {
  stopChrome();
}
console.log('\n━━ Summary ━━');
for (const [s, ok] of results) console.log(`  ${ok ? '✓' : '✗'} ${s}`);
if (results.some(([, ok]) => !ok)) process.exitCode = 1;
