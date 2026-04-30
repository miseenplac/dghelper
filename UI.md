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

No phases yet. The user is starting fresh on UI work; gather requirements before planning.

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
