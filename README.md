# DungKey Tracker

Alt1 Toolkit overlay for RuneScape 3 that tracks Dungeoneering keys and locked key-doors and matches them up automatically.

## What it does

Watches the game chat for three message types and keeps a live list:

| Chat line | Effect |
|---|---|
| `Your party found a key: <Color> <shape> key` | Adds the key to the party's inventory. |
| `<Player>: Key required: <Color> <shape> key` (appears when any party member right-clicks **Info** on a locked door) | Registers the door. Records which player info'd it; keeps full history per door, newest first. |
| `Your party used a key: <Color> <shape> key` | Removes the matching key and door (door opened). |

The window shows two sections:

- **Doors** — all doors that have been info'd, with swatch, name, status (`OPEN` if you hold the key, `need` if you don't), and the last player who info'd it. Hover that player-name chip to see the full info history for that door. Doors you can't open yet are sorted to the top.
- **Unmatched Keys** — keys you've picked up that no-one has info'd a door for yet.

## Install & build

### Prerequisites
- [Alt1 Toolkit](https://runeapps.org/alt1) installed and running
- [Node.js 18+](https://nodejs.org) and npm

### Setup
```bash
cd dungkey-tracker
npm install
```

### Run in dev mode (hot-reload)
```bash
npm start
```
Dev server runs at `http://localhost:7290`.

### Add to Alt1
With the dev server running, open (in any browser):
```
alt1://addapp/http://localhost:7290/appconfig.json
```
Alt1 will prompt to add the app. Grant the **pixel** permission when asked.

### Production build
```bash
npm run build
```
Outputs a static site in `dist/` — host it anywhere, then install via
`alt1://addapp/<your-url>/appconfig.json`.

### Icon (optional)
Drop a `icon.png` (64x64 recommended) in the project root (next to `appconfig.json`). It will be copied into the build and used as the Alt1 tile icon. If missing, Alt1 will still run the app with a default icon.

## Usage

1. Launch RS3 via Alt1.
2. Open the DungKey Tracker from the Alt1 apps panel.
3. Make sure the in-game chat is visible (the chatbox reader needs to see it on screen). The first time each session, the app auto-calibrates to find the chat.
4. Play normally. Entries update as keys and doors appear in chat.
5. Click **Reset** when starting a new Dungeoneering floor.
6. Click **Recal** if you moved/resized the chatbox and tracking stops.

## UI testing without the game

Open DevTools in the app window and call:
```js
DEBUG_TRIGGER('door-info', 'Purple', 'diamond', 'Aari the Iceborn');
DEBUG_TRIGGER('door-info', 'Purple', 'diamond', 'Someone Else');
DEBUG_TRIGGER('key-found', 'Green',  'rectangle');
DEBUG_TRIGGER('key-used',  'Purple', 'diamond');
```

## Files

```
dungkey-tracker/
├── appconfig.json        # Alt1 app manifest
├── package.json          # Deps + build scripts
├── webpack.config.js     # Bundler config
├── src/
│   ├── index.html        # App window markup
│   ├── index.js          # Entry point — Alt1 init, poll loop
│   ├── parser.js         # Regex for the three chat events
│   ├── tracker.js        # State + per-door info history
│   ├── ui.js             # DOM rendering
│   └── style.css         # Dark overlay theme
└── README.md
```

## Notes / limitations

- The chatbox reader relies on screen OCR. If the chat is hidden, minimised, or heavily themed, lines may be missed. Keeping chat in its default game-chat tab with legible text is most reliable.
- Key identity is `<color> <shape>` (lowercased). If a dungeon ever contains two separate keys/doors of the same colour+shape, they'll collapse into one row.
- Reset is currently manual (no auto-detection of floor completion).
