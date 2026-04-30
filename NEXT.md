# Pickup note — 2026-04-30 (post Phase 7)

You're continuing work on the DungKey Tracker Alt1 plugin. Read [HANDOFF.md](HANDOFF.md) first for project orientation, then this file for current state, then [OPTIMIZATION.md](OPTIMIZATION.md) for the multi-phase CPU-reduction project (now wrapped).

## Active project

**CPU reduction is complete through Phase 7.** Phase 4 (slow-CPU tester verification) is the only remaining piece, and it's in tester hands — not blocking other work.

**Phase status:**
- Phase 1 — Calibration smoothness — VERIFIED & SHIPPED 2026-04-29.
- Phase 2 — Profiling instrumentation — VERIFIED 2026-04-30. `perf:` line in debug log every ~60 s.
- Phase 3 — Targeted reductions (RoK cheap pixel re-verification + provisional timestamp bump) — VERIFIED 2026-04-30.
- Phase 4 — Slow-CPU verification — READY (in tester hands; not blocking other work).
- Phase 5 — Winterface auto-probe reduction — VERIFIED 2026-04-30. Active-floor gate + two-stage capture. Established empirically that `alt1.bindRegion` cost is region-proportional — load-bearing finding for everything since.
- Phase 6 — `cheapPanelStillPresent` regional bind + verification cadence decoupling — VERIFIED 2026-04-30.
- Phase 7 — Remaining periodic full-screen captures — VERIFIED 2026-04-30. All three targets shipped:
    - Target 1 (`readPartyPanel`) — panel-bucket max ~10-15× lower on detection events.
    - Target 2 (`runDgMapRead` + dgMap.js helpers) — dgmap-bucket avg ~11× lower (5.5 → 0.5 ms), max ~10× lower (~165 → 16.8 ms).
    - Target 3 (`findTrianglePx`) — regional self-bind on solo-pin Tier 2 fall-through and `runTriangleSnapshot` (off by default).

## Findings worth carrying forward

- **`alt1.bindRegion` is region-proportional in cost.** Phase 5 implied it; Phase 6 confirmed it; Phases 7 Targets 1/2 produced empirical reductions matching the proportion. Future region-bind optimizations are real wins, not speculative.
- **The trust-vs-verify decoupling pattern.** When state changes slowly (panel state, dgMap state), per-tick verification is wasted CPU AND occasionally samples sub-second RS3 render-flicker frames as false negatives. Decouple by trusting between checks and verifying on a slower cadence (10 s for panel; tunable per subsystem).
- **`toData` uses absolute coords** ([alt1/src/base/imgref.ts:31-33](node_modules/alt1/src/base/imgref.ts:31)) — `read(x - this.x, y - this.y, w, h)`. So `screen.toData(absX, absY, w, h)` works identically whether the bind is full-RS or regional.
- **`getPixel` uses LOCAL data-buffer coords** ([alt1/src/base/imagedata-extensions.ts:194](node_modules/alt1/src/base/imagedata-extensions.ts:194)) — `i = x*4 + y*4*this.width`. After a regional bind, the resulting `screenData` is region-sized, so existing `screenData.getPixel(absX, absY)` calls in caller code WILL break — they need `getPixel(absX - x0, absY - y0)` translation, with bounds adjusted from `[0..screenData.width-1]` to `[x0..x0+screenData.width-1]`. Plan for caller-side translation work in any future region-bind that has downstream getPixel-on-absolute-coords reads.
- **Helpers that internally call `resolveScanRect`-style logic with `screen.width`/`.height` clamps must be made offset-aware** (use `screen.x + screen.width - 1` for upper bound, `screen.x || 0` for lower bound). Symptom of forgetting: detection silently fails fast, perf line shows the bucket max collapsing far below normal — feels like a CPU win but is actually a fast-bail on garbage data. Bit Phase 7 Target 1 once.
- **Alt1's "one bind per app" rule.** Each `captureHold*()` call replaces the previous bind. Subsystems are safe because they each capture-then-toData inside a single function call, with no holding of binds across subsystems. Don't break this pattern when refactoring.
- **Accepted residual edge case from Phase 6:** banner can flash twice (~1 s each) when user closes panel, waits for warning, then reopens it mid-floor. Cause: OCR cycles flap between found/miss while RS3 panel re-renders. Documented in OPTIMIZATION.md Phase 6 outcome section. Fix is OCR-miss tolerance but trades ~6 s slower close-detect — user judged the trade not worth it.

## What's available next

No active CPU-reduction task. Available follow-ups, none urgent:

1. **Phase 4 verification** — push to main is done; ask original slow-CPU testers to retest. Their feedback determines whether the project closes (verified) or reopens for further iteration. Currently in tester hands.
2. **Phase 2 perf scaffolding removal** — project-completion work. Once Phase 4 verifies, the perf instrumentation has done its job and can come out (it itself adds CPU work). Grep `_perf` and `T0 = performance.now()` for removal targets per OPTIMIZATION.md Phase 2 reminder.
3. **Cold-start detection latency** — flagged in OPTIMIZATION.md Deferred section with open questions. ~10 s delay between Ctrl+R + immediate floor entry and door-info events successfully self-pinning. Out of scope for Phase 7 (was about per-fire bind cost, not detection cadence/gates). Tackle when ready.
4. **Solo-pin Tier 1 regional bind** — `findDgMap` self-bind path at [src/index.js:3223](src/index.js:3223) and the calibration self-test at [src/index.js:684](src/index.js:684) still use full-RS bind. Threading the regional bind into solo-pin's Tier 1 would shave the `pin=*/139` max we still see on door-info events (verified in Phase 7 Target 2 perf line). Small follow-up; same pattern as Targets 1/2/3.

## Working-style flags (carry from HANDOFF.md)

1. **Discuss before code.** Plan + tradeoffs + lean → wait for explicit greenlight ("yes" / "go ahead" / "do it") before any Edit/Write tool call. Even small diffs.
2. **Confirm before code applies even to small diffs.** A 1-line capture-call swap still gets stated and confirmed.
3. **Test on dev server (`localhost:7290`) before commit.** Live deploy ships to all plugin users.
4. **No emojis** in files unless explicitly asked.
5. **Trust user bug reports.** Don't hypothesize user error. Investigate code/data directly.
6. **Pace control: don't pile sub-decisions.** Report results in 1-3 short paragraphs after each entry. No "what's next?" sections, no embedded greenlight requests for follow-on work — user paces.
7. **CPU note required in commit message** (HANDOFF rule #6).

## State of local repo

`main` is up to date with `origin/main` after Phase 7 part 3 push (final Target 3 commit).

## First moves on a fresh session

1. Read this file (you're here).
2. Read [HANDOFF.md](HANDOFF.md) for project orientation, working-style rules, and the 17 load-bearing invariants.
3. Read [OPTIMIZATION.md](OPTIMIZATION.md) — particularly the "Findings worth carrying forward" above and the Deferred section.
4. Skim user memory in `C:\Users\Aari Jabar\.claude\projects\C--Users-Aari-Jabar-Desktop-rs-scripts\memory\`. Especially `feedback_pace_control.md`, `feedback_confirm_before_code.md`.
5. Greet the user, summarize that Phase 7 is complete, ask what they'd like to tackle next from the "What's available next" list above (or something new entirely).
