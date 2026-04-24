# DungKey Tracker — debug-phase hand-off

Context for whoever is picking this up after 2026-04-24. Read this plus `MEMORY.md` in the user's home dir before touching code.

---

## What this is

An Alt1 Toolkit plugin for RS3 Dungeoneering. Watches the chatbox for key/door events, tracks state, renders key icons as an Alt1 overlay on the in-game DG map widget at the cell where each door was info'd. Works in solo AND multi-party.

**Shipped and live** at `https://dungkey.netlify.app`. Private GitHub repo `miseenplac/dungkey-tracker`. Netlify auto-rebuilds on `git push origin main`.

## Critical working-style rules (user has flagged these repeatedly)

1. **Discuss before code.** State a plan with X/Y/Z options + tradeoffs + your lean. Wait for explicit greenlight ("yes", "go ahead", "do it") before any Edit/Write tool call, even small diffs.
2. **Accuracy over heuristics.** Prefer silent non-firing to guessing. Don't introduce probabilistic fallbacks on features that should be deterministic.
3. **Trust the user's bug reports.** Don't hypothesize user error. Investigate code/data directly. Ask for specific data (logs, eyedrops, screenshots) rather than "did you do X earlier?".
4. **Palette widenings must be eyedrop-driven.** The user has an Eyedrop button in Settings → Diagnostics. Never widen an RGB range without sampled evidence.
5. **No emojis in files unless asked.** User is terse; match the tone.

## Build / dev / reload cycle

Working dir: `C:\Users\Aari Jabar\Desktop\rs scripts\dungkey-tracker`

- `npm run build` — production build. Tail for `webpack compiled successfully`.
- `npm run dev` — webpack-dev-server on `localhost:7290`. User has this open while testing.
- After code changes, user must **Ctrl+R in the Alt1 plugin window** to reload. Confirm reload by watching for `overlay: pre-rendered 128 key icons @ 16 px (need-key + key-ready halo variants)` in the debug log.

After code changes that need shipping:
- `git commit -am "..."` + `git push` → Netlify auto-rebuilds (~60-90s).
- Users on the public plugin pick up the new bundle when they next Ctrl+R.

## Architecture at a glance

```
src/
├── index.js       entry — 100ms tick loop, chat dispatch, self-pin cascade, overlay draws, all UI wiring, settings modal
├── parser.js      chat-line parsing, fuzzy canonical snap, signature computation
├── tracker.js     state machine: doorsPending / keysFound / keyHistory. first-info-wins on pin location
├── floor.js       floor log persistence (dkt:floors:v1)
├── timer.js       post-dungeon winterface OCR. Takes optional calibratedAnchor.
├── partyPanel.js  RoK panel detection + per-slot name OCR via chatbox_12pt + slot-specific palettes
├── dgMap.js       map widget locator + classifyCellContents (per-cell triangle/icon counts), findTrianglePx({color})
├── keyIcon.js     SVG icons — filled body + chartreuse backdrop/halo for ready state
├── overlay.js     icon pre-render → BGRA-base64 → alt1.overLayImage
├── ui.js          DOM rendering for Doors list, Party Slots, Previous Floor Keys, etc.
├── index.html     UI layout. Settings modal at bottom, opened via header button.
└── style.css      all styling. Modal styles at the bottom.
```

## Debug log channels (dbg kind)

The user pastes debug logs. Expect:
- `raw` — raw OCR'd chat line + fragment breakdown
- `match` — parser produced an event (door-info, key-found, key-used, floor-start/end)
- `miss` — line looked interesting but didn't parse, OR a self-pin attempt failed
- `info` — lifecycle (panel detected, self-slot set, pinned to cell, etc.)
- `error` — unexpected exceptions

Debug panel in the plugin window shows the last 250 lines. User toggles it via Settings → Show debug panel.

## Most important log patterns + how to read them

### Door info event flow
```
OCR: [HH:MM:SS] Aar i·Key required: Gold diamond key
  frags: "[" [white] | "HH:MM:SS" [blue] | "Aar i" [white] | "·" [grey-placeholder] | "Key required:" [blue] | "Gold diamond key" [gold]
MATCH door-info: gold diamond by Aar i
  pinned to cell (col, row) cx=X.X cy=Y.Y p=Z red=N (runner-up M) [fresh|cached|triangle-scan|timestamp-match]
overlay dump: N pinned door(s)
  gold diamond: cell(c,r) cellPx(x,y,p) triPx(x,y) →overlay(x,y) slot=0 draw=ok
```

If `pinned to cell` is missing after a door-info MATCH, the self-pin augmentation skipped the event. Possible reasons:
- `_partySize === 'UNKNOWN'` (no RoK panel read yet).
- `getSelfColor()` returned null (MULTI, self-slot not detected — check if roster has teammates for elimination).
- `isSelfEvent(ev)` returned false (signature alias mismatch + fuzzy roster match also failed).

### Self-slot detection
```
PARTY PANEL [bg-text]: 3/5 filled — slot1 (x,y) text h=N bg=100% slots=5/5
  slot 1: RED — "Aar i" | (OCR unreadable)
  slot 2: TEAL — "ironbergy"
  ...
auto-roster: added N teammate name(s): <names>
self-slot: unknown → <color> (primary: roster[0] matched slot N | elimination: N teammate(s) matched, 1 slot left)
```

`(OCR unreadable)` on the user's own slot is expected — clan icon splits the name. Elimination handles that case.

### Winterface / timer OCR
```
Winterface AUTO-detected (hits=N @ (x,y))
FLOOR END (auto) — floor #N marked ended
TIMER OCR (auto): 00:04:27 (267s) via pixel_8px_digits
```

If timer OCR keeps failing:
```
auto-probe: peek hits=N @ (x,y) but timer OCR failed (rect WxH @ (x,y)); floor untouched
  <font_name> @ rel(X,Y): "<garbled>"
```
User can calibrate the winterface anchor via Settings → Calibration → Winterface → Calibrate (with dialog open), which stabilises the anchor position.

## Load-bearing invariants

Do not violate these without understanding why they exist:

1. **First-info-wins** on `cellCoords` / `cellPx` / `trianglePx` in tracker entries. Re-info events don't move the pin. The `pinned to cell` log fires every event regardless — it does NOT imply the tracker applied the update.
2. **Red triangle classifier range** in `dgMap.js`: `r 100-185, g 20-50, b ≤ 5, r > g*2`. Don't narrow — widened iteratively from eyedrops.
3. **Opened-cell beige palette** in `dgMap.js` is tight on purpose (r 123-140, g 91-105, b 45-52). One dim floor missed; user accepted.
4. **Overlay grouping** keys on BUCKETED ABSOLUTE `cellPx` (10 px bucket), NOT `cellCoords`. `cellCoords` is local to findDgMap's origin which can shift.
5. **Event-driven overlay redraw** via state fingerprint + 2s keep-alive heartbeat + 6s overlay duration = 4s buffer. Don't revert to per-tick redraws.
6. **Anchor synthesis for non-red self-slot:** `computeOverlaySlotPos` uses actual `trianglePx` when selfColor=red, synthesises `(cellPx.cx - pitch/3, cellPx.cy - pitch/3)` otherwise. Keeps icon positioning consistent across slot colours.
7. **`isSelfEvent` fuzzy fallback** is a safety net (handles stale alias bindings + unbound sigs). Strict signature check stays primary.
8. **Chat username OCR is unreliable on this user's client** — their own name garbles to "Aar i" (with clan-icon placeholder), OCR drops it entirely on some lines. Fuzzy roster match + aliasMap signature binding handle attribution. Teammate OCR is more reliable.
9. **Alt1 `appconfig.json` permissions must be comma-STRING**, not array. Array fails silently. See `reference_alt1_plugin_publishing.md` in memory.
10. **Webpack bundle is content-hashed.** Anyone editing `index.html` inline won't propagate — edit `src/index.html` + rebuild.

## Known open issues (low priority)

1. **Sticky teammate-unlocked door** — sometimes a door that a teammate unlocked doesn't clear from the tracker. Likely chat OCR fidelity on `"Your party used a key: X Y key"` broadcasts. If user reports this, ask for the raw OCR + MATCH line at the moment of the unlock. Fix path: palette tuning for broadcast-body colour, or canonical-snap threshold relaxation for that pattern.
2. **Stale comments** in `parser.js` and `tracker.js` mentioning removed `slotAssignMap`. Not load-bearing, pure cleanup.
3. **Overlay dump diagnostic** in `drawPinnedOverlays` still emits on state change. Can be removed after another few sessions with no bugs.

## Memory system

`C:\Users\Aari Jabar\.claude\projects\C--Users-Aari-Jabar-Desktop-rs-scripts\memory\`. Auto-loaded at session start. Index is `MEMORY.md`. Individual files cover user profile, feedback preferences, project phase log, and Alt1 publishing gotchas.

**Before recommending any file path, function name, or flag from memory, VERIFY it exists in the current code** (grep or Read). Memory is frozen in time; code may have moved on.

## When the user pastes a debug log

1. **Don't speculate.** Parse the log lines against the patterns above.
2. **Identify the subsystem.** Chat parser (parser.js)? Self-pin cascade (index.js tick dispatch)? OCR (partyPanel.js / timer.js / dgMap.js)? Overlay render (index.js drawPinnedOverlays)?
3. **Locate the exact code path.** Grep or Read the file at the lines producing the logged message.
4. **Propose a fix with alternatives and a lean.** Wait for greenlight before Edit/Write.
5. **After code change:** `npm run build`, tell user to Ctrl+R, ask for fresh log paste to verify.

## Publish pipeline reminder

- Local commit + `git push` → Netlify auto-deploys in ~60-90s.
- Live URL: `https://dungkey.netlify.app/install.html`.
- User's own install is at that URL — pushing to main ships to them AND everyone else using the plugin.
- For risky changes, test locally first (dev server on :7290, reload in Alt1) before committing.

---

You are now briefed. Acknowledge this hand-off and wait for the user's log paste.
