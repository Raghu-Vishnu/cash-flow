# Cash Flow: personal income & expense tracker

An installable app (PWA) for Android, iPhone/iPad, macOS and Windows. Your statements are processed on your
device. Nothing is uploaded, unless you choose to back up to your own Google Drive. The design follows Google's Material Design 3, with Apple's iOS guidelines for phones.

## Open it
| How | Works offline | Can install as an app |
|---|---|---|
| Double-click `index.html` | ✓ (after first load of fonts) | ✗ |
| **Mac:** double-click `Start Cash Flow.command` · **Windows:** double-click `Start Cash Flow (Windows).bat` (needs Python) | ✓ | ✓ (Chrome / Edge → install icon in the address bar) |
| Host the folder on any HTTPS site (e.g. GitHub Pages, Netlify) and open the link on your phone | ✓ | ✓ (Android: "Install app"; iPhone: Share → Add to Home Screen) |

> The copy kept on a device is per browser *and* per address (file, localhost and a hosted link are separate). Sign in
> with the same Google account and **Sync** to bring the same data to any of them.

## Using it
0. **Sign in with Google** the first time you open Cash Flow on a device. Your data is saved in your own Google Drive and kept in step
   across devices. Tick **Remember this device** on your own phone or laptop to keep a copy there (opens instantly, works offline).
1. **Settings → People & accounts:** add people (you, family) and their bank accounts.
2. **Upload** (the button at the top of the left rail on desktop, the round button at the bottom-right on phones): pick the account and drop CSV/Excel/PDF statements.
   Every file is checked against the account number, and its running balance is verified so missing transactions are flagged.
3. **Dashboard:** year & month, last 30 days / 3 / 6 months, financial year, or custom dates. Tap a bar or a category to drill in.
4. **Transactions:** tap any transaction to change its category (remembered for that merchant) or delete it (with undo).
5. **Settings → Google account & Drive:** sync status and **Sync now**, Remember this device, Delete Drive copy,
   Change Google account (your data moves with you), Sign out. The ☁ button in the header shows the sync state.
6. **Settings → Your data → Download transactions:** CSV, Excel or a PDF statement for any person, account and period.
7. **Settings → Statement diagnostics:** creates an anonymised report if a statement isn't read correctly.

## Google sign-in & Drive (one-time setup)
Sign-in and backup run in the browser. There is no Cash Flow server or account database. Scopes: `openid email profile`
(who is signed in) and `drive.file` (only the files the app created, nothing else in the Drive).
Without a client ID, sign-in is skipped and the app works as a single local store.

**How syncing works.** The Drive file is the main copy. Each change is saved to Drive about 2 seconds later while a Google
session is active (Google's sign-in lasts about an hour, and with no server it can't be renewed without a tap, so the app
asks you to tap **Sync** when needed). `sync.js` does a 3-way merge against the last synced version, so changes from two
devices are combined: both sides' additions are kept, deletions stick, and for an item changed on both, the newer edit wins.
The sign-in token is kept in memory for about an hour and is never saved.

Google needs to know which website is allowed to ask for sign-in. Do this once:
1. Go to **console.cloud.google.com** and create a project (for example "Cash Flow").
2. **APIs & Services → Library**: search for **Google Drive API** and click **Enable**.
3. **Google Auth Platform → Branding** (older consoles call it "OAuth consent screen"): fill in the app name "Cash Flow" and your support email. Audience: **External**.
4. **Data access → Add or remove scopes**: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `.../auth/drive.file`, then save.
5. **Audience**: click **Publish app**. `drive.file` is a non-sensitive scope, so Google doesn't need to review it.
   If you leave it in "Testing", only the Google accounts you add as test users can sign in.
6. **Clients → Create client** → type **Web application**. Under **Authorized JavaScript origins**, add
   `https://raghu-vishnu.github.io` and `http://localhost:8765`. Leave redirect URIs empty, then click Create.
7. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`). There is no client secret to keep: the app doesn't use one.
   Never put a client secret in this project.

### Where the Client ID goes (never in the source code)
| Where | Put it in | Committed? |
|---|---|---|
| Your computer | `.env`: copy `.env.example` to `.env` and set `GOOGLE_CLIENT_ID=…` | No (`.gitignore`) |
| Live site | GitHub → repo **Settings → Secrets and variables → Actions → Variables** → `GOOGLE_CLIENT_ID` | No |

`scripts/make-config.py` writes `config.js` from these values. `config.js` is generated and never committed. The Mac/Windows
start scripts run it for you, and the GitHub Actions workflow (`.github/workflows/pages.yml`) runs it on every push.
For this to work, set **Settings → Pages → Source** to **GitHub Actions**.

> A browser app can't hide values from its users: the Client ID is visible in the published `config.js`, as on every site
> that uses Google sign-in. That's safe by design, because Google only accepts it from the Authorized JavaScript origins above.
> Keeping it in env keeps it out of the code and the git history, and lets you change it without a code change.

With no `GOOGLE_CLIENT_ID` set, Google Drive backup is simply turned off.

Restoring works on any device with the same Google account. Drive keeps earlier versions of the backup file for
about 30 days: right-click the file in Drive, then choose **Manage versions**.

## For developers
- `parser.js`: statement reading (CSV/Excel/PDF with layout detection), verification, categorisation, anonymiser
- `config.js`: generated settings (see above), never edited by hand · `scripts/make-config.py` builds it
- `gdrive.js`: Google sign-in + Drive REST API (no server) · `sync.js`: 3-way merge of device and Drive data
- `vendor/jspdf*.js`: jsPDF 2.5.1 + AutoTable 3.8.2 (MIT) for PDF statements, loaded only when needed
- `app.js`: UI logic · `styles.css`: Material 3 theme · `sw.js`: offline cache · `manifest.webmanifest`: app install info
- `vendor/`: Chart.js 4.4.1, SheetJS 0.18.5, pdf.js 3.11.174 (bundled so the app works offline)
- **When you change any file, bump `VERSION` in `sw.js`** so installed apps pick up the update.
