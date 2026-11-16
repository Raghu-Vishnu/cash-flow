# Cash Flow: personal income & expense tracker

An installable app (PWA) for Android, iPhone/iPad, macOS and Windows. Your statements are processed on your
device and never uploaded anywhere. The design follows Google's Material Design 3, with Apple's iOS guidelines for phones.

## Open it
| How | Works offline | Can install as an app |
|---|---|---|
| Double-click `index.html` | ✓ (after first load of fonts) | ✗ |
| **Mac:** double-click `Start Cash Flow.command` · **Windows:** double-click `Start Cash Flow (Windows).bat` (needs Python) | ✓ | ✓ (Chrome / Edge → install icon in the address bar) |
| Host the folder on any HTTPS site (e.g. GitHub Pages, Netlify) and open the link on your phone | ✓ | ✓ (Android: "Install app"; iPhone: Share → Add to Home Screen) |

> Data is stored per browser *and* per address. Opening via a file, localhost or a hosted link gives three separate
> data stores. Use **Settings → Your data → Back up / Restore** to move your data between them or to another device.

## Using it
1. **Settings → People & accounts:** add people (you, family) and their bank accounts.
2. **Upload** (the button at the top of the left rail on desktop, the round button at the bottom-right on phones): pick the account and drop CSV/Excel/PDF statements.
   Every file is checked against the account number, and its running balance is verified so missing transactions are flagged.
3. **Dashboard:** year & month, last 30 days / 3 / 6 months, financial year, or custom dates. Tap a bar or a category to drill in.
4. **Transactions:** tap any transaction to change its category (remembered for that merchant) or delete it (with undo).
5. **Settings → Statement diagnostics:** creates an anonymised report if a statement isn't read correctly.

## For developers
- `parser.js`: statement reading (CSV/Excel/PDF with layout detection), verification, categorisation, anonymiser
- `app.js`: UI logic · `styles.css`: Material 3 theme · `sw.js`: offline cache · `manifest.webmanifest`: app install info
- `vendor/`: Chart.js 4.4.1, SheetJS 0.18.5, pdf.js 3.11.174 (bundled so the app works offline)
- **When you change any file, bump `VERSION` in `sw.js`** so installed apps pick up the update.
