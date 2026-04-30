# DungKey UI Project

The new active project after CPU-reduction concluded. Source-of-truth working doc for UI changes — read alongside [HANDOFF.md](HANDOFF.md) (project-wide context, including the load-bearing UI invariants), [NEXT.md](NEXT.md) (current pickup point), and [OPTIMIZATION.md](OPTIMIZATION.md) (only relevant if a UI change has CPU implications — every code change still owes a CPU-impact note per HANDOFF rule #6).

## What this doc captures

This file is for UI work specifically: layout changes, tab restructuring, control additions, visual polish, mobile/window resize behaviour, settings ergonomics, accessibility, etc. Each piece of work gets its own phase entry below with scope, decisions, outcome.

CPU-reduction phases live in [OPTIMIZATION.md](OPTIMIZATION.md) and are concluded. UI changes that touch CPU (e.g., a new live-updating dashboard) still owe the CPU-impact note in their commits but don't go in OPTIMIZATION.md unless they're explicitly an optimization push.

## What's already in place — the existing UI architecture

Read [HANDOFF.md](HANDOFF.md) "Architecture at a glance" section first. Summary for orientation:

- **Plugin window is a 4-tab layout** (Tracker / Floors / Calibration / Settings). Tab visibility is CSS-driven via `#app[data-active-tab="..."]` selectors at [src/style.css](src/style.css). Tab nav is JS at [src/index.js](src/index.js) — search `setActiveTab` and `loadActiveTab`.
- **Header** holds the four tab buttons.
- **RoK warning banner** sits between the header and per-tab content. Dynamic — appears when a floor is active and the party panel hasn't been detected for ≥ 5 s.
- **Per-tab `.block` sections** hold each tab's content. Settings is now an inline pane (modal-* class names retained on the wrapper for legacy CSS scoping; pure naming debt, functional).
- **Markup lives at [src/index.html](src/index.html)** — webpack bundles + content-hashes it. Editing the bundled output won't propagate; edit `src/index.html` and rebuild.
- **Styling lives at [src/style.css](src/style.css)** — injected via `style-loader` at runtime. Critical: a top-level JS throw aborts the bundle BEFORE the style tags are appended → all CSS appears not to load (default browser styling everywhere). HANDOFF invariant #16 covers this.
- **`appconfig.json`** controls plugin window dimensions (`minWidth: 160` currently). Changes here only take effect on plugin re-install — HANDOFF invariant #17.

## Load-bearing UI invariants (carry from HANDOFF.md)

These bit prior UI attempts; do not violate without understanding why:

- **Invariant #11 — Tab nav `loadActiveTab` IIFE must run AFTER the RoK warning block** ([HANDOFF.md:122](HANDOFF.md)). `setActiveTab` calls `updateRokWarning()` which reads `_lastPartyPanelDetectedAt` (declared in the RoK block). Earlier placement caused a TDZ throw at startup that halted module evaluation, leaving the let permanently uninitialized — every subsequent tab click then re-threw.
- **Invariant #16 — `style-loader` injects CSS via JS at runtime** ([HANDOFF.md:127](HANDOFF.md)). A top-level JS throw aborts the bundle BEFORE style tags are appended; symptom is "all CSS appears not to load". Recognise it as: after Ctrl+R, headings render at default h2 size and buttons look unstyled. That's not your CSS — it's a JS throw at module top-level.
- **Invariant #17 — `appconfig.json` is read by Alt1 at install time, not Ctrl+R** ([HANDOFF.md:128](HANDOFF.md)). Width/height/permissions changes only take effect after the user removes + re-adds the plugin. Code-bundle changes propagate via Ctrl+R as normal — appconfig is the exception.
- **Invariant #18 — `renderCalibrationStatus()` calls from `runCalibrationForMetric` must be in `finally` AFTER `_calActive = false`** ([HANDOFF.md:129](HANDOFF.md)). Inline calls in the try body silently no-op due to the Phase 1 clobber guard. Touching calibration UI without re-reading invariant #18 reintroduces the symptom.

## Working-style flags (carry from HANDOFF.md)

1. **Discuss before code.** Plan + tradeoffs + lean → wait for explicit greenlight ("yes" / "go ahead" / "do it") before any Edit/Write tool call. Even small diffs.
2. **Confirm before code applies even to small diffs.** A 1-line CSS tweak still gets stated and confirmed.
3. **For UI changes, start the dev server and use the feature in a browser before reporting the task as complete.** Type checking and test suites verify code correctness, not feature correctness — if you can't test the UI, say so explicitly rather than claiming success.
4. **Test on dev server (`localhost:7290`) before commit.** Live deploy ships to all plugin users.
5. **No emojis** in files unless explicitly asked.
6. **Trust user bug reports.** Don't hypothesize user error. Investigate code/data directly.
7. **Pace control: don't pile sub-decisions.** Report results in 1-3 short paragraphs after each entry. No "what's next?" sections, no embedded greenlight requests for follow-on work — user paces.
8. **CPU note required in commit message** (HANDOFF rule #6). UI changes that add per-tick DOM writes or observers need a brief CPU note even when net-neutral.

## Phase status

### Phase 1 — Settings tab UX overhaul + diagnostic relocation (shipped 2026-04-30)

Compressed the Settings tab from 7 verbose rows (label + input + 2-3 line italic hint) to 4 active rows with hover-popover ⓘ icons. Migrated two former toggles out of user control. Added one new toggle.

**HTML / markup changes ([src/index.html](src/index.html)):**
- New `.setting-help` ⓘ icon pattern: `<span class="setting-help" data-help="...">&#9432;</span>` next to each label. Single source of truth for hint text via the `data-help` attribute (replaces both the `<small class="setting-hint">` and the input's `title="..."`).
- Renames: *Your name* → *In-game name*; *Max floors kept* → *Max floors logged*; *Show finish time* → *Show real-life time*; *Floor log webhook URL* gained "(optional)" suffix.
- New row: *Show previous floor keys* checkbox (default ON; controls `.history-block` visibility on the Tracker tab).
- Removed rows preserved verbatim as `REMOVED-2026-04-30` HTML comment block at the bottom of `<section class="block settings-block">`. Restoration instructions inline.

**JS changes ([src/index.js](src/index.js)):**
- `DEFAULT_SETTINGS.showPreviousFloorKeys: true` + typeof check in `loadSettings` + binding block alongside `showFinishTimeInput`.
- **Migration force-set:** after `loadSettings()` runs, `settings.timestampedChat = true` and `settings.showDebugPanel = false` overwrite any persisted value. `saveSettings()` immediately persists, so existing users get migrated on their next plugin load. To remove the migration in future, delete those two lines + the `saveSettings()` call.
- `timestampedChatInput` and `clearTeammatesBtn` binding blocks commented out with `// REMOVED-2026-04-30` markers and restoration pointers to the HTML comment block.

**CSS changes ([src/style.css](src/style.css)):**
- New `.setting-help` rule (small blue ⓘ glyph, `cursor: help`).
- New `.setting-help:hover::after` popover — `position: absolute; right: 0; left: auto; top: 100%;` anchored to the closest positioned ancestor's right edge. `width: max-content; max-width: min(240px, calc(100vw - 24px))` clamps so it never overflows narrow plugin windows. `pointer-events: none` to avoid hover-flicker. `z-index: 100`.

### Phase 2 — Tab strip compaction + Tracker tab cleanup (shipped 2026-04-30)

**Tab labels:**
- "Tracker" → "Doors/keys" (visible label only — internal id `tab-tracker` and `VALID_TABS = ['tracker', ...]` preserved, so `localStorage['dkt:activeTab:v1']` and every `setActiveTab` call site continue to work without migration).
- All four `title="..."` tab tooltips removed.

**Doors / Tracker tab:**
- Doors heading: ⓘ added with text *"Right click info on a key-door ingame to register it, along with a detected chat"*. Footer text *"Right-click Info on a locked door in-game to register it."* removed (redundant with the new ⓘ).
- Reset button `title=` simplified to *"Reset keydoors & keys"*.
- Previous Floor Keys: `history-toggle` button `title=` removed.
- **Party Slots block removed entirely** — preserved verbatim as `REMOVED-2026-04-30` HTML comment block at its old DOM location. Verified safe: `renderPartySlots` ([src/ui.js:179-235](src/ui.js)) early-returns at line 180 when `slotsListEl`/`slotsCountEl` are null. `renderSlotRow` builds no interactive elements (no click handlers / event listeners). The OCR + self-slot detection pipeline (`runPartyPanelRead` in index.js, `_lastPartyPanelResult`, `_partySize`, `_selfSlotColor`, `partyRoster`, `_panelStableOrigin`) is independent of the DOM block. Downstream consumers (`getSelfColor`, door-info pin attribution) read in-memory state, not DOM. CSS rules for `.slots-*` left intact for cheap restoration.

### Phase 3 — Calibration tab restructure (shipped 2026-04-30)

- **Instruction banner** at the top of the Calibration tab: *"The Ring of kinship party interface must be reopened upon entering a floor for the map overlay to work."* Styled `.cal-instruction` (subtle blue tint, info-note look). Distinct from the red `.rok-warning` banner above `#status` which is for active floor errors.
- **ⓘ icons on all four cal-row labels** (RoK / DG Map / Chat / Winterface). RoK and DG Map mention the 5s countdown explicitly; DG Map adds *"Make sure it's a large floor, it'll work for all sizes afterwards."* Winterface uses the user-provided wording.
- **`renderCalibrationStatus` state-4 winterface text** ([src/index.js:1085](src/index.js)) changed from `"⚠ never detected"` to `""` (empty string). Function and 4-state branch logic untouched; only the displayed string for state 4 differs. Comment notes the restoration path.
- **Calibrate button tooltips** ("3s each" → "5s each") for RoK and DG Map. Both calibrations already used `5000ms` in `captureMouseAfterDelay` — the tooltip text was just stale.
- **Debug section moved to Calibration tab** — DOM `<section class="block debug-block">` relocated to sit after the calibration block. Tab CSS updated: tracker hides `.debug-block`, calibration's `:not()` selector excepts it (so calibration shows both `.calibration-block` and `.debug-block`).
- **Show debug panel toggle** moved from Settings → Calibration tab's `<div class="diagnostics-row">`. Selector changed from `#settings-show-debug` to `#diag-show-debug`. ⓘ tooltip *"Enable only for troubleshooting reasons."*
- **`dbg()` gated at the ui.js level** — module-level `_dbgEnabled` flag + exported `setDebugEnabled(bool)`. `dbg()` first line now `if (!_dbgEnabled) return;`. Default true so module-init dbg calls aren't lost; index.js's showDebugInput binding flips it based on `settings.showDebugPanel` after load. Saves ~5 DOM ops per dbg() call when off.
- **`ensureDebugPanelVisible()`** upgraded to a full enable cascade: un-hide `<section id="debug-section">`, un-collapse `<ul id="debug-list">`, call `setDebugEnabled(true)`, sync the `#diag-show-debug` checkbox, persist `settings.showDebugPanel = true`. Fixes a latent bug where `runCalibration()` wrote to a hidden DOM node when the user had Show debug panel off.
- **Eyedrop + Run layout test buttons gated by Show debug panel toggle** via `#app[data-debug-mode="on"|"off"]` attribute selector. CSS rule `#app[data-debug-mode="off"] #eyedrop-btn, #app[data-debug-mode="off"] #calibrate-btn { display: none; }`. JS sets the attribute on init and on toggle change. Buttons stay in the DOM (no re-wiring needed); visibility is pure CSS so no risk to style-loader injection (invariant #16).

### Phase 4 — Visual polish (shipped 2026-04-30)

- **Custom thin scrollbar** — `::-webkit-scrollbar { width: 4px; height: 4px; }` + dark grey thumb (`#3a3a3a` → `#555` on hover) + transparent track. Reclaims ~11px of horizontal space versus default OS scrollbars and blends with the dark theme. Applies globally; Alt1's CEF supports the webkit pseudo-elements.
- **Popover positioning fixes** — added `position: relative` to `.setting-row`, `.diagnostics-row`, `.cal-row`, and `.block h2` so the `.setting-help::after` popover anchors to the row's right edge instead of `<body>` (which made the popover appear in the top-left of the viewport when there was no positioned ancestor nearby).

### Cumulative CPU impact

**Wins:**
- Party Slots removal eliminates per-panel-read DOM rebuild (innerHTML clear + appendChild loops + slot-row construction every successful confirmed panel read).
- `dbg()` short-circuit when toggle off skips `<li>` creation + appendChild + 250-line cap pruning + scrollTop write per call. Default OFF means most users get the win out of the box.
- Several `<small class="setting-hint">` DOM nodes eliminated (one-time cost reduction).

**Trade-off:**
- `timestampedChat` forced ON for everyone introduces a ~3.3 Hz pixel-scan over the calibrated dgMap region during active floors only (gated by `!alt1.permissionPixel`, `!calibration.dgMap`, `!selfColor`, tick interval). Zero cost outside DG runs. User explicitly accepted this trade after observing the fallback fired >1/floor on average — leaving users with it OFF caused unsatisfactory pin accuracy.

**Net:** the wins cover the trade for typical use. Slow CPUs may still feel the timestamped-chat work during active floors; if a tester complains, the deferred plan in [OPTIMIZATION.md](OPTIMIZATION.md) "Chat OCR" section is the next attack vector.

### Open follow-ups (deferred, not blocking)

- `slot1Y`/`slotsBlock`/`slotsListEl` references in [src/ui.js](src/ui.js) survive only as the null-safe early-return. Cosmetic cleanup if doing a CSS+JS pass: remove the variables + the `.slots-*` rules in style.css. Currently kept for cheap restoration.
- `.modal-body` / `.modal-subtitle` / `.modal-body .cal-row` class names persist on the inline settings + calibration panes (legacy from when those were modal). Pure naming debt; rename if doing a CSS pass.
- `clearTeammatesBtn` and `timestampedChatInput` commented blocks in [src/index.js](src/index.js) — remove fully if neither is restored within ~6 months.
- The migration force-set lines (`settings.timestampedChat = true; settings.showDebugPanel = false;`) can be replaced with default value flips after enough time has passed that all users have been through one migration cycle.

---

## Update protocol for the next agent

When picking up:
1. Read this file → identify the most recent active phase or, if none, ask the user what UI work they want to do.
2. Re-read [HANDOFF.md](HANDOFF.md) — particularly the UI invariants (#11, #16, #17, #18) and the architecture summary.
3. Re-read [src/index.html](src/index.html) and [src/style.css](src/style.css) to ground in the current markup/styling state — git history may have moved on between sessions.
4. Surface a plan to the user, wait for greenlight before any code change.

When wrapping up a phase:
- Update the Phase status block above with the phase entry.
- Append an Outcome subsection: actual result, commit hash, any surprises or scope creep.
- If a phase reveals work that should be its own phase, add it — don't bundle.
- Update [NEXT.md](NEXT.md) with a one-liner pointing here as the live working doc.
