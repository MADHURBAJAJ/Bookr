# Bookr POS for Windows

The POS (https://pos.thebajajgroup.co) in its own full-screen window on a counter PC, printing each slip straight to its
own printer with no print window: bills to the bill printer, each station's KOTs to that station's printer. The printers
are chosen per PC under **Printers** (Ctrl+Shift+P, or Settings → This device → Choose printers). No password or key is
kept in the app; signing in works as in a browser.

## Keys
- **F11** full screen on or off · **Ctrl+Shift+P** Printers · **Ctrl+R** reload · **Ctrl+Q** quit

## Build and release a version
1. Raise `version` in `package.json` and push. GitHub Actions (workflow **Desktop app**) builds the installer on Windows.
2. Download the run's **bookr-pos-windows** files: `gh run download <run id> -n bookr-pos-windows -D desktop-release`.
3. Put them online, the installer first and `latest.yml` last (installed apps update from `latest.yml`):
   `npx wrangler r2 object put pos-demo-bills/desktop/<file> --file desktop-release/<file> --remote -c pos/wrangler.jsonc`
4. The installer is then at `https://pos.thebajajgroup.co/api/desktop/Bookr-POS-Setup-<version>.exe`.

## Try it on a computer
`npm install`, then `npm start` (or `BOOKR_POS_URL=http://localhost:8788/ npm start` against a local POS).

The installer is not signed: Windows shows "Windows protected your PC" once; choose **More info → Run anyway**.
