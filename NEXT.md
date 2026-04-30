# Pickup note — 2026-04-30 (post Phase 6)

You're continuing work on the DungKey Tracker Alt1 plugin. Read [HANDOFF.md](HANDOFF.md) first for project orientation, then this file for current state, then [OPTIMIZATION.md](OPTIMIZATION.md) for the active CPU-reduction project.

## Active project

**CPU reduction** — see [OPTIMIZATION.md](OPTIMIZATION.md) for the multi-phase plan. Phases 1-6 shipped; Phase 7 is the next active piece.

**Phase status:**
- Phase 1 — Calibration smoothness — VERIFIED & SHIPPED 2026-04-29.
- Phase 2 — Profiling instrumentation — VERIFIED 2026-04-30. `perf:` line in debug log every ~60 s.
- Phase 3 — Targeted reductions (RoK cheap pixel re-verification + provisional timestamp bump) — VERIFIED 2026-04-30.
- Phase 4 — Slow-CPU verification — READY (in tester hands; not blocking other work).
- Phase 5 — Winterface auto-probe reduction — VERIFIED 2026-04-30. Active-floor gate + two-stage capture. Established empirically that `alt1.bindRegion` cost is region-proportional — load-bearing finding for everything since.
- Phase 6 — `cheapPanelStillPresent` regional bind + verification cadence decoupling — VERIFIED 2026-04-30. Two parts: (a) regional bind (full-RS for 30×3 read → captureHold of just the 30×3 region — ~5 orders of magnitude pixel-data reduction per fire); (b) dual-cadence design — per-tick "trust" bump + verification only every ~10 s. Side-eliminates RS3 panel-flicker false absences.
- **Phase 7 — Remaining periodic full-screen captures. Active.**

## Findings worth knowing before you start

- **`alt1.bindRegion` is region-proportional in cost.** Phase 5 implied it from the user-felt "instant" result; Phase 6 confirmed it. Future region-bind optimizations are real wins, not speculative.
- **The trust-vs-verify decoupling pattern.** When state changes slowly (panel state, dgMap state), per-tick verification is wasted CPU AND occasionally samples sub-second RS3 render-flicker frames as false negatives. Decouple by trusting between checks and verifying on a slower cadence (10 s for panel; tunable per subsystem).
- **`toData` uses absolute coords** ([alt1/src/base/imgref.ts:31-33](node_modules/alt1/src/base/imgref.ts:31)) — `read(x - this.x, y - this.y, w, h)`. So `screen.toData(absX, absY, w, h)` works identically whether the bind is full-RS or regional. No caller-side change needed alongside a capture-call swap.
- **Alt1's "one bind per app" rule.** Each `captureHold*()` call replaces the previous bind. Subsystems are safe because they each capture-then-toData inside a single function call, with no holding of binds across subsystems. Don't break this pattern when refactoring.
- **Accepted residual edge case from Phase 6:** banner can flash twice (~1 s each) when user closes panel, waits for warning, then reopens it mid-floor. Cause: OCR cycles flap between found/miss while RS3 panel re-renders. Documented in OPTIMIZATION.md Phase 6 outcome section. Fix is OCR-miss tolerance but trades ~6 s slower close-detect — user judged the trade not worth it.

## Phase 7 active task: remaining periodic full-screen captures

Three targets remain. All apply the same Phase 5/6 region-bind pattern. Each should be a separate commit so regressions are bisectable.

### Target 1 — `readPartyPanel` ([src/partyPanel.js:931](src/partyPanel.js))

Highest yield ratio of the three.

- Fires every 30 ticks (~3 s) from `runPartyPanelRead`, gated to active-floor only (Phase 3).
- Inside, calls `captureHoldFullRs()`, then `screen.toData(0, 0, screen.width, screen.height)` to get full-screen pixel data, then reads from `panelScanRect` — the right ~40% × middle 70% of screen (~28% of total area).
- Regional bind: replace `captureHoldFullRs()` with `captureHold(panelScanRect.x0, panelScanRect.y0, panelScanRect.w, panelScanRect.h)`. The `screen.toData(0, 0, screen.width, screen.height)` call would now extract just the bound region — but downstream code in `partyPanel.js` reads pixels at ABSOLUTE coords inside the panelScanRect, so all the existing absolute-coord reads still work. Verify by reading partyPanel.js's `getPixel` / `toData` call sites.
- Calibrated regions (`calibration.partyPanel`) and default `panelScanRect` both work the same way — both produce a {x0, y0, w, h} rect that the bind can use.
- ~70% reduction in pixel-data per fire (28% of full → 100% of bind).

### Target 2 — `runDgMapRead` ([src/index.js:2711](src/index.js))

Similar shape, slightly lower yield.

- Fires every 30 ticks (~3 s). NO active-floor gate currently — runs even outside dungeons. Scope question: is the active-floor gate something to add too, or out of scope for Phase 7?
- Calls `captureHoldFullRs()`, passes `screen` into `findDgMap` which does `screen.toData(0, 0, screen.width, screen.height)` then reads pixels inside the calibrated dgMap region or the default left-half (~50% of screen).
- Regional bind: replace `captureHoldFullRs()` with `captureHold(scanRegion.x, scanRegion.y, scanRegion.w, scanRegion.h)`. Need to thread the scan region into the runDgMapRead site.
- ~50% reduction per fire (default left-half) or more (calibrated rect, often smaller).

### Target 3 — `findTrianglePx` ([src/dgMap.js:953](src/dgMap.js))

Lower priority. Called from:
- Solo-pin cascade on door-info events (event-driven, sparse).
- `runTriangleSnapshot` every 3 ticks (~300 ms) when `settings.timestampedChat === true`. Off by default for current user.

If user opts into `timestampedChat` later, this becomes a hot path. Worth doing for correctness even if cold for current user.

### Suggested order

Target 1 first — highest yield, well-isolated change in a small file. Target 2 second — touches more of `runDgMapRead`'s state machine but same pattern. Target 3 third — opt-in, low priority unless user enables `timestampedChat`.

Each target is a separate commit. CPU note in commit message per HANDOFF rule #6.

## Working-style flags (carry from HANDOFF.md)

1. **Discuss before code.** Plan + tradeoffs + lean → wait for explicit greenlight ("yes" / "go ahead" / "do it") before any Edit/Write tool call. Even small diffs.
2. **Confirm before code applies even to small diffs.** A 1-line capture-call swap still gets stated and confirmed.
3. **Test on dev server (`localhost:7290`) before commit.** Live deploy ships to all plugin users.
4. **No emojis** in files unless explicitly asked.
5. **Trust user bug reports.** Don't hypothesize user error. Investigate code/data directly.
6. **Pace control: don't pile sub-decisions.** Report results in 1-3 short paragraphs after each entry. No "what's next?" sections, no embedded greenlight requests for follow-on work — user paces.
7. **CPU note required in commit message** (HANDOFF rule #6).

## State of local repo

`main` is up to date with `origin/main` after Phase 6 push. No uncommitted changes (Phase 6 + this NEXT.md update were committed together as the post-Phase-6 ship).

## First moves

1. Read this file (you're here).
2. Read [HANDOFF.md](HANDOFF.md) for project orientation, working-style rules, and the 17 load-bearing invariants.
3. Read [OPTIMIZATION.md](OPTIMIZATION.md) Phases 5 and 6 (the proven patterns you're replicating) and the Phase 7 candidate enumeration.
4. Skim user memory in `C:\Users\Aari Jabar\.claude\projects\C--Users-Aari-Jabar-Desktop-rs-scripts\memory\`. Especially `feedback_pace_control.md`, `feedback_confirm_before_code.md`.
5. Greet the user, summarize state in 2-3 sentences, propose Target 1 (`readPartyPanel`) with the precise diff. Wait for greenlight.
6. After user verifies in-game (Ctrl+R + a floor with RoK panel open + watch banner stays clean), commit + push as Phase 7 part 1, update OPTIMIZATION.md.
7. Move on to Target 2 only when user signals.

## Out of scope for Phase 7

- Cadence changes (Phase 5/6 deferred this; same here — region bind is orthogonal).
- Chat-signal triggers (boss-drop "received item:" / outfit-bonus discussed and tabled in Phase 5).
- Phase 2 perf scaffolding removal — that's project-completion work (see OPTIMIZATION.md Phase 2 "REMOVE AT PROJECT COMPLETION reminder").
- OCR-miss tolerance for the panel-reopen-flicker case — user explicitly accepted that as cosmetic edge case (Phase 6 outcome).
- Anything about chat OCR `reader.read()` — the dominant CPU consumer per Phase 2, separate problem space.
