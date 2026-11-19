# Cash Flow – Smart Finance Manager

Track income, expenses and investments from your own bank statements (CSV, Excel or PDF). An installable web app (PWA)
for Android, iPhone/iPad, Mac and Windows. Statements are read on your device; your data is kept in **your own Google
Drive**. There is no Cash Flow server.

## Using it
1. **Sign in with Google.** Tick **Remember this device** on your own phone or laptop to keep a copy there (opens
   instantly, works offline). Leave it off on shared computers.
2. **Profile** (tap your initial, top right) → **People & bank accounts:** add people (you, family) and their accounts.
3. **Upload** statements into an account. Each file's account number is checked and its running balance verified, so
   missing transactions are flagged.
4. **Dashboard:** Income · Expenses · **Invested** · Left over, by month, year, financial year or custom dates. Tap a
   bar or category to drill in. **Transactions:** tap one to change its category (remembered for that merchant) or delete it.
5. **Investments** (Mutual funds / SIP, Stocks, Gold, Other investments) count as Invested, not as spending. Money coming
   back (redemptions, maturity) goes to **From investments**.
6. **Settings:** appearance, categories and merchant rules, **Download transactions** (CSV, Excel or a PDF statement for
   any person, account and period), usage counts switch, delete all data.
7. **Profile:** Sync now, Remember this device, **Help & support** (contact support, statement diagnostics, privacy),
   Change Google account, Delete Drive copy, Sign out. The ☁ button in the header shows the sync state.

## Running it
| How | Offline | Installable |
|---|---|---|
| The live site, or any HTTPS host (GitHub Pages, Netlify) | ✓ | ✓ Android: "Install app" · iPhone: Share → Add to Home Screen |
| **Mac:** `Start Cash Flow.command` · **Windows:** `Start Cash Flow (Windows).bat` (needs Python) → `http://localhost:8765` | ✓ | ✓ |

The copy on a device is per browser *and* per address. Sign in with the same Google account to get the same data anywhere.

## Settings (never in the source code)
All settings come from `.env` on your computer (copy `.env.example`) and from the GitHub repo
(**Settings → Secrets and variables → Actions**) for the live site. `scripts/make-config.py` writes them into the
generated `config.js`. The start scripts and the GitHub Actions deploy (`.github/workflows/pages.yml`) run it. For the
deploy, set **Settings → Pages → Source** to **GitHub Actions**.

| Name | GitHub type | What it is | Needed for |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | variable | OAuth "Web application" client ID | Sign-in and Drive. Without it, the app keeps data in the browser only |
| `GOATCOUNTER_CODE` | variable | GoatCounter site code, e.g. `my-cashflow` | Anonymous usage counts |
| `ADMIN_EMAILS` | **secret** | Admin Gmail addresses, comma-separated (published only as SHA-256 fingerprints) | Insights tab |
| `SUPPORT_EMAIL` | variable | Support Google Group address | Contact support |

Everything in `config.js` is visible to visitors, as on any website. That's fine for these values: the Client ID only works
from your authorised addresses, and the GoatCounter code can't read stats. Never put a client secret or an API key there.

### Google sign-in (once)
1. **console.cloud.google.com:** create a project, then **APIs & Services → Library → Google Drive API → Enable**.
2. **Google Auth Platform → Branding:** app name "Cash Flow", support email, home page and privacy policy links
   (`…/cash-flow/` and `…/cash-flow/privacy.html`), authorised domain `raghu-vishnu.github.io`. Leave the logo empty.
3. **Data access:** add `openid`, `userinfo.email`, `userinfo.profile` and `drive.file`. **Audience:** External → **Publish app**.
4. **Clients → Create client → Web application**, Authorized JavaScript origins `https://raghu-vishnu.github.io` and
   `http://localhost:8765`. Copy the Client ID into `GOOGLE_CLIENT_ID`.

### Usage counts and Insights (optional)
Sign up at goatcounter.com, set `GOATCOUNTER_CODE` and `ADMIN_EMAILS`, and push. Sign in with an admin Gmail and open
**Insights**. Paste a GoatCounter API key that has only *Read statistics* for this site. It's saved in the admin's own Drive
("Cash Flow admin settings.json"), so other devices pick it up, and never goes into `config.js` or GitHub.

### Contact support (optional)
Set `SUPPORT_EMAIL`. The form opens the user's email app with a template (topic, what happened, steps, app version,
device type). In Google Groups, set **Who can post → Anyone on the web**. Ticket tracking is a future item.

## How it works
- **Privacy:** scopes are `openid email profile` and `drive.file` (only the file the app created). Google's access token
  lives in memory for about an hour and is never saved.
- **Sync:** the Drive file is the main copy. Changes save to Drive about 2 seconds later while a Google session is active.
  Without a server, the session can't renew without a tap, so the app asks you to tap **Sync** when needed. `sync.js`
  merges against the last synced version: both devices' additions are kept, deletions stick, and the newer edit wins.
- **Usage counts:** `analytics.js` sends fixed event names only (e.g. `download-pdf`), never personal or financial data.
  Users can turn it off in Settings; it starts off with Do Not Track / Global Privacy Control and never runs on localhost.
- **Updates:** a new version installs in the background and takes over by itself; the page reloads once (or offers
  **Reload** if a dialog is open).

## For developers
| File | What it does |
|---|---|
| `app.js` | UI: dashboard, transactions, imports, settings, profile, sync, downloads, Insights |
| `parser.js` | Reads statements (CSV/Excel/PDF layout detection), verifies balances, categorises, anonymises |
| `gdrive.js` · `sync.js` | Google sign-in and Drive REST calls · 3-way merge of device and Drive data |
| `analytics.js` | Anonymous usage counts (GoatCounter) |
| `sw.js` · `manifest.webmanifest` | Offline cache and automatic updates · install info |
| `styles.css` | Material 3 theme, light/dark, phone layout |
| `vendor/` | Chart.js 4.4.1, SheetJS 0.18.5, pdf.js 3.11.174, jsPDF 2.5.1 + AutoTable 3.8.2 (bundled for offline use) |
| `icons/` | App icons; `icon.svg` and `maskable.svg` are the sources of the PNGs |
| `tests/` | Automated tests (see below) |

### Tests
```
node tests/run-all.mjs            # everything (about 3 minutes)
node tests/run-all.mjs t-sync     # one suite
```
Needs Node 22+ and Google Chrome (set `CHROME=/path/to/chrome` if it's elsewhere). The tests drive the real app in headless
Chrome with fake Google sign-in, Drive and GoatCounter (`tests/harness.mjs`), so no accounts are needed.
Screenshots and downloads go to `tests/.output/` (not committed).

| Suite | Covers |
|---|---|
| `t-merge` | 3-way merge rules |
| `t-sync` | Sync across devices, remember device, offline, delete Drive copy, sign out, change account, CSV/Excel/PDF |
| `t-insights` | Usage counts privacy (every request checked), opt-out, Do Not Track, admin Insights, API key in Drive |
| `t-invest` | Investments, dashboard totals, Profile/Settings, contact support |
| `t-update` | Real offline cache: new versions take over by themselves, fresh files, offline, waits when a dialog is open |

**Releasing:** run the tests, bump `APP_VERSION` in `app.js` and `VERSION` in `sw.js` together, then push. Installed apps
update by themselves.
