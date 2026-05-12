# dghelper

Alt1 Toolkit overlay for RuneScape 3 that tracks Dungeoneering floor times. Each time you finish a floor, the plugin reads the timer off the end-of-dungeon dialog and appends a row to a persistent log.

## What it does

- Polls three small pixel zones at the title-bar Y of the end-of-dungeon dialog.
- When all three zones match the "CONGRATULATIONS" gold palette, the dialog is open — fires a single timer OCR at the bottom-left clock and records the floor.
- Maintains a rolling log (max 1000 floors) with an 11-floor average display.

## Build & install

### Prerequisites
- [Alt1 Toolkit](https://runeapps.org/alt1)
- [Node.js 18+](https://nodejs.org) and npm

### Setup
```bash
cd dghelper
npm install
```

### Dev mode (hot-reload)
```bash
npm run dev
```
Server runs at `http://localhost:7290`.

### Add to Alt1
With the dev server running, open this URL **in your regular browser** (not Alt1's CEF — clicks must come from an external browser):
```
alt1://addapp/http://localhost:7290/appconfig.json
```
Grant the **pixel** permission when asked.

### Production build
```bash
npm run build
```
Outputs a static site in `dist/`. Host it anywhere, then install via `alt1://addapp/<your-url>/appconfig.json`.

## Usage

1. Launch RS3 via Alt1.
2. Open dghelper from the Alt1 apps panel (or pin it to the game as an overlay).
3. Play Dungeoneering. When you finish a floor, the end-of-dungeon dialog appears — the plugin detects it within ~250ms and logs the timer.
4. Click **Show** to expand the floor list. **Export CSV** copies the log to your clipboard. **Clear** wipes the log (click twice within 3s to confirm).

### Settings

- **Max floors logged** — the log keeps the most recent N floors. Default + hard cap is 1000.
- **Winterface detection — Calibrate** — overrides the built-in sentinel-pixel RGBs with values eyedropped from your current screen. Only needed if detection fails with the defaults (e.g. on a non-standard UI scale or unusual monitor calibration). To use: open the end-of-dungeon dialog in-game, **then** click Calibrate. **Reset** discards the override.

## Requirements / limitations

- **RS3 Interface Scale must be 100%.** The sentinel positions and timer offset are calibrated for default UI scale.
- **Dialog must be roughly centered in the RS view.** HUD overlays or sidebars that shift the dialog away from center may break sentinel detection. Workaround: use the Calibrate button when the dialog is open in your setup.
- **No chat reading.** If a floor's dialog is closed before the plugin polls (very rare — dialog usually stays open for seconds), that floor is silently not logged.

## Files

```
dghelper/
├── appconfig.json        Alt1 app manifest
├── package.json          deps + build scripts
├── webpack.config.js     bundler config
├── _headers              Cloudflare cache rules (deployed alongside dist/)
├── install.html          standalone install page
├── icon.png              Alt1 tile icon
└── src/
    ├── index.html        single-screen compact layout
    ├── index.js          sentinel poll loop + triggered OCR + UI bindings
    ├── floor.js          persistent floor log (CSV export, 11-floor avg)
    └── style.css         dark amber theme
```

Reference material for the original plugin's calibration history, palettes, and shelved OCR code lives at the sibling `dghelper-archive/` directory.
