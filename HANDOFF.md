# DungKey Tracker — debug-phase hand-off

Context for whoever is picking this up after 2026-04-29. Read this plus `MEMORY.md` in the user's home dir before touching code.

---

## What this is

An Alt1 Toolkit plugin for RS3 Dungeoneering. Watches the chatbox for key/door events, tracks state, renders key icons as an Alt1 overlay on the in-game DG map widget at the cell where each door was info'd. Works in solo AND multi-party.

**UI is organised into 4 tabs** in the plugin window: Tracker (full UI), Floors (stream-friendly view of floor times only), Calibration (one-time setup of scan regions + diagnostics), Settings (form/prefs). A dynamic red banner on Tracker/Floors prompts the user to open the Ring of Kinship when a floor is active and the party panel hasn't been detected for ≥ 5 s. See `project_dungkey_ui_tabs.md` in memory for the full tab-system rundown.

**Shipped and live** at `https://dungkey.netlify.app`. Private GitHub repo `miseenplac/dungkey-tracker`. Netlify auto-rebuilds on `git push origin main`.

## Critical working-style rules (user has flagged these repeatedly)

1. **Discuss before code.** State a plan with X/Y/Z options + tradeoffs + your lean. Wait for explicit greenlight ("yes", "go ahead", "do it") before any Edit/Write tool call, even small diffs.
2. **Accuracy over heuristics.** Prefer silent non-firing to guessing. Don't introduce probabilistic fallbacks on features that should be deterministic.
3. **Trust the user's bug reports.** Don't hypothesize user error. Investigate code/data directly. Ask for specific data (logs, eyedrops, screenshots) rather than "did you do X earlier?".
4. **Palette widenings must be eyedrop-driven.** The user has an Eyedrop button in Settings → Diagnostics. Never widen an RGB range without sampled evidence.
5. **No emojis in files unless asked.** User is terse; match the tone.
6. **Evaluate CPU impact on every change.** Before shipping, answer: does this load the CPU more, less, or unchanged? Include a brief CPU note in commit messages and (when relevant) Phase Outcome sections — e.g. `CPU: net reduction — skips OCR every tick during calibration` / `CPU: neutral — cosmetic reorder` / `CPU: slight increase (~+1 DOM write/s), justified by [reason]`. The plugin runs on slow CPUs in production; reducing CPU load is a project-level vision, not just one project's goal. See `OPTIMIZATION.md` for the deeper context.

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
├── index.js       entry — 100ms tick loop, chat dispatch, self-pin cascade, overlay draws, all UI wiring, tab nav, RoK banner, settings form bindings
├── parser.js      chat-line parsing, fuzzy canonical snap, signature computation
├── tracker.js     state machine: doorsPending / keysFound / keyHistory. first-info-wins on pin location
├── floor.js       floor log persistence (dkt:floors:v1)
├── timer.js       post-dungeon winterface OCR. Takes optional calibratedAnchor.
├── partyPanel.js  RoK panel detection + per-slot name OCR via chatbox_12pt + slot-specific palettes
├── dgMap.js       map widget locator + classifyCellContents (per-cell triangle/icon counts), findTrianglePx({color})
├── keyIcon.js     SVG icons — filled body + chartreuse backdrop/halo for ready state
├── overlay.js     icon pre-render → BGRA-base64 → alt1.overLayImage
├── ui.js          DOM rendering for Doors list, Party Slots, Previous Floor Keys, etc.
├── index.html     UI layout. 4 tab buttons in <header>, then RoK warning banner, then per-tab .block sections. Settings is now an inline pane (not a modal).
└── style.css      all styling. Tab visibility via #app[data-active-tab="..."] selectors. Modal-* class names retained on the settings pane wrapper for legacy CSS scoping.
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
11. **Tab nav `loadActiveTab` IIFE must run AFTER the RoK warning block.** `setActiveTab` calls `updateRokWarning()` which reads `_lastPartyPanelDetectedAt` (a `let` declared in the RoK block). Earlier placement caused a TDZ throw at startup that halted module evaluation, leaving the let permanently uninitialized — every subsequent tab click then re-threw the same error. See `project_dungkey_ui_tabs.md` in memory.
12. **Party panel scan is gated to active-floor only.** `runPartyPanelRead()` early-returns if `floor.current()` is null or `ended === true`. Outside dungeons, no panel scanning happens (CPU saving, user-requested). `nextPartyTick` is NOT advanced during the gated period, so the next read fires on the first tick after a floor starts. Side effect: party slots in Tracker tab don't update outside an active floor.
13. **RoK warning banner timestamp bumps on PROVISIONAL detection too** (changed 2026-04-30, was previously confirmed-only). `_lastPartyPanelDetectedAt = Date.now()` is set inside `runPartyPanelRead` BOTH on the first provisional detection (one OCR cycle, ~3 s) and on confirmed detection (~6 s). State mutations (slot UI, party size, self-slot, cheap-check cache) are still gated by the temporal-confirmation gate — only the warning timestamp moved earlier. Trade-off: a world-fluke single-tick false-positive clears the banner for ~5 s (ROK_WARN_STALE_MS) before re-appearing when the next OCR fails to confirm. Accepted because flukes are rare (1-2 per session) and the user prioritized the lag fix when opening the panel mid-floor.
14. **`formatFloorTime(t)` is display-only.** Compact-minimal form: M:SS under 10 min, MM:SS up to 1h, H:MM:SS up to 10h, HH:MM:SS beyond. So `"00:07:45" → "7:45"`, `"00:12:34" → "12:34"`, `"01:02:33" → "1:02:33"`. Storage (`f.time`, CSV export, webhook payload) stays HH:MM:SS — only the floor-list cell uses the trimmed form.
15. **`formatAvgTime(seconds)` keeps tenth-second precision.** AVG pill reads e.g. `"avg 7:52.5"`. Implementation rounds to tenths *first* before splitting into minutes/seconds, so 59.95 → 60.0 carries cleanly into the next minute. To bump precision: `sec.toFixed(1)` → `.toFixed(2)` and `padStart(4, '0')` → `padStart(5, '0')` in [src/index.js:749](src/index.js).
16. **Webpack uses `style-loader`** ([webpack.config.js:24](webpack.config.js)) — it injects CSS via JS at runtime. **A top-level JS throw aborts the bundle BEFORE the style tags are appended, so all CSS appears not to load** (default browser styling everywhere). This is what regressed the earlier scroll-arrow tab attempt. If you add JS that runs at module top level (event listeners, `new ResizeObserver(...)`, observer chains), null-check or try/catch defensively. Symptom to recognise: after Ctrl+R, headings render at default h2 size and buttons look unstyled — that's style-loader injection failing, not your CSS.
17. **`appconfig.json` is read by Alt1 at install time, not Ctrl+R.** Changes to `minWidth` / `maxWidth` / `defaultWidth` / `permissions` only take effect after the user removes + re-adds the plugin (or re-hits the `alt1://addapp/...` install URL). Code-bundle changes propagate via Ctrl+R as normal — appconfig is the exception. Currently `minWidth: 160`.

## Known open issues (low priority)

1. **Sticky teammate-unlocked door** — sometimes a door that a teammate unlocked doesn't clear from the tracker. Likely chat OCR fidelity on `"Your party used a key: X Y key"` broadcasts. If user reports this, ask for the raw OCR + MATCH line at the moment of the unlock. Fix path: palette tuning for broadcast-body colour, or canonical-snap threshold relaxation for that pattern.
2. **Stale comments** in `parser.js` and `tracker.js` mentioning removed `slotAssignMap`. Not load-bearing, pure cleanup.
3. **Overlay dump diagnostic** in `drawPinnedOverlays` still emits on state change. Can be removed after another few sessions with no bugs.
4. **Modal-* class names persist on the settings pane wrapper.** `.modal-body` / `.modal-subtitle` / `.modal-body .cal-row` are still used on the inline settings + calibration sections (the modal scaffolding was removed in 2026-04-29 but the CSS class names were kept to avoid HTML/CSS churn). Pure naming debt; functional. Rename if doing a CSS pass.

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
