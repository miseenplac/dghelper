# Pickup note — 2026-04-30 (post Phase 7 Target 2)

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
- Phase 7 Target 1 — `readPartyPanel` regional bind — VERIFIED 2026-04-30. Threaded (x0, y0) through every helper for absolute→local translation. Bug fix: `resolveScanRect`/`panelScanRect` clamps now offset-aware. Empirical: panel-bucket max ~150-200 ms → 13.9 ms (~10-15× reduction on detection events). Steady-state unchanged (Phase 6 cache absorbs normal play).
- Phase 7 Target 2 — `runDgMapRead` regional bind + dgMap.js helper threading — VERIFIED 2026-04-30. `runDgMapRead` pre-resolves scanRegion per-path, captureHold of just that rect. dgMap helpers (`findDgMap`, `scanBeigeInRegion`, `clusterHits`, `hasGapBetween`, `classifyCellContents`, `classifyAllCells`) all received `(x0, y0)` for absolute→local translation. `defaultLeftRegion` made offset-aware preemptively. Empirical: dgmap-bucket avg ~11× lower (5.5 → 0.5 ms) and max ~10× lower (~165 → 16.8 ms). Bigger steady-state win than Target 1 because dgmap fires unconditionally every 30 ticks.
- **Phase 7 Target 3 — `findTrianglePx`. Active. Final piece of Phase 7.**

## Findings worth knowing before you start

- **`alt1.bindRegion` is region-proportional in cost.** Phase 5 implied it from the user-felt "instant" result; Phase 6 confirmed it. Future region-bind optimizations are real wins, not speculative.
- **The trust-vs-verify decoupling pattern.** When state changes slowly (panel state, dgMap state), per-tick verification is wasted CPU AND occasionally samples sub-second RS3 render-flicker frames as false negatives. Decouple by trusting between checks and verifying on a slower cadence (10 s for panel; tunable per subsystem).
- **`toData` uses absolute coords** ([alt1/src/base/imgref.ts:31-33](node_modules/alt1/src/base/imgref.ts:31)) — `read(x - this.x, y - this.y, w, h)`. So `screen.toData(absX, absY, w, h)` works identically whether the bind is full-RS or regional.
- **`getPixel` uses LOCAL data-buffer coords** ([alt1/src/base/imagedata-extensions.ts:194](node_modules/alt1/src/base/imagedata-extensions.ts:194)) — `i = x*4 + y*4*this.width`. After a regional bind, the resulting `screenData` is region-sized, so existing `screenData.getPixel(absX, absY)` calls in caller code WILL break — they need `getPixel(absX - x0, absY - y0)` translation, with bounds adjusted from `[0..screenData.width-1]` to `[x0..x0+screenData.width-1]`. The Target 1 ship discovered this the hard way; NEXT.md previously claimed no caller-side change was needed, which was wrong. Plan for caller-side translation work in any future region-bind that has downstream getPixel-on-absolute-coords reads.
- **Alt1's "one bind per app" rule.** Each `captureHold*()` call replaces the previous bind. Subsystems are safe because they each capture-then-toData inside a single function call, with no holding of binds across subsystems. Don't break this pattern when refactoring.
- **Accepted residual edge case from Phase 6:** banner can flash twice (~1 s each) when user closes panel, waits for warning, then reopens it mid-floor. Cause: OCR cycles flap between found/miss while RS3 panel re-renders. Documented in OPTIMIZATION.md Phase 6 outcome section. Fix is OCR-miss tolerance but trades ~6 s slower close-detect — user judged the trade not worth it.

## Phase 7 active task: remaining periodic full-screen captures

One target remains. Same Phase 5/6 region-bind pattern. Targets 1 + 2 shipped — see OPTIMIZATION.md Phase 7 Outcome subsections for diff shape and lessons.

### Target 3 — `findTrianglePx` ([src/dgMap.js:953](src/dgMap.js))

Lower priority. Called from:
- Solo-pin cascade on door-info events (event-driven, sparse).
- `runTriangleSnapshot` every 3 ticks (~300 ms) when `settings.timestampedChat === true`. Off by default for current user.

If user opts into `timestampedChat` later, this becomes a hot path. Worth doing for correctness even if cold for current user.

### Lesson carried forward from Targets 1 & 2 (apply to Target 3)

When swapping a `captureHoldFullRs()` → `captureHold(rect)` and the downstream code reads `getPixel(absX, absY)` against the resulting `screenData`, every read site needs absolute→local translation. Plus any helper that internally calls `resolveScanRect`-style logic with `screen.width`/`.height` clamps must be made offset-aware (use `screen.x + screen.width - 1` for upper bound). Symptom of forgetting: detection silently fails fast, perf line shows the bucket max collapsing far below normal — feels like a CPU win but is actually a fast-bail on garbage data.

## Working-style flags (carry from HANDOFF.md)

1. **Discuss before code.** Plan + tradeoffs + lean → wait for explicit greenlight ("yes" / "go ahead" / "do it") before any Edit/Write tool call. Even small diffs.
2. **Confirm before code applies even to small diffs.** A 1-line capture-call swap still gets stated and confirmed.
3. **Test on dev server (`localhost:7290`) before commit.** Live deploy ships to all plugin users.
4. **No emojis** in files unless explicitly asked.
5. **Trust user bug reports.** Don't hypothesize user error. Investigate code/data directly.
6. **Pace control: don't pile sub-decisions.** Report results in 1-3 short paragraphs after each entry. No "what's next?" sections, no embedded greenlight requests for follow-on work — user paces.
7. **CPU note required in commit message** (HANDOFF rule #6).

## State of local repo

`main` is up to date with `origin/main` after Phase 7 part 2 push (Target 2 commit).

## First moves

1. Read this file (you're here).
2. Read [HANDOFF.md](HANDOFF.md) for project orientation, working-style rules, and the 17 load-bearing invariants.
3. Read [OPTIMIZATION.md](OPTIMIZATION.md) Targets 1 + 2 Outcome subsections (the proven patterns you're replicating) and the Target 3 enumeration.
4. Skim user memory in `C:\Users\Aari Jabar\.claude\projects\C--Users-Aari-Jabar-Desktop-rs-scripts\memory\`. Especially `feedback_pace_control.md`, `feedback_confirm_before_code.md`.
5. Greet the user, summarize state in 2-3 sentences, propose Target 3 (`findTrianglePx`) with the precise diff. Wait for greenlight.
6. After user verifies in-game (Ctrl+R + a floor with door-info events to exercise solo-pin's findTrianglePx fall-through), commit + push as Phase 7 part 3, update OPTIMIZATION.md.

## Out of scope for Phase 7

- Cadence changes (Phase 5/6 deferred this; same here — region bind is orthogonal).
- Chat-signal triggers (boss-drop "received item:" / outfit-bonus discussed and tabled in Phase 5).
- Phase 2 perf scaffolding removal — that's project-completion work (see OPTIMIZATION.md Phase 2 "REMOVE AT PROJECT COMPLETION reminder").
- OCR-miss tolerance for the panel-reopen-flicker case — user explicitly accepted that as cosmetic edge case (Phase 6 outcome).
- Anything about chat OCR `reader.read()` — the dominant CPU consumer per Phase 2, separate problem space.
