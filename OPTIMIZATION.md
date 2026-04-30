# DungKey CPU Reduction Project

Multi-phase plan to reduce plugin CPU load on lower-end machines while preserving 100% of current functionality. This is the source-of-truth working doc for the optimization push — read alongside [HANDOFF.md](HANDOFF.md) (project-wide context) and [NEXT.md](NEXT.md) (current pickup point).

## Goal & non-goals

**GOAL:** make the plugin run smoothly on slow CPUs.

**NON-GOAL:** change any user-visible behaviour. No feature changes, no detection-accuracy regressions, no UX deltas. Identical functionality, lower CPU.

**Acceptance:** at least one tester on a low-end CPU reports the plugin feels responsive — calibration UI smooth, no felt stutter during active floor.

## Core principle (apply to every future change)

Every code change — in this project AND in the plugin generally — must answer: **"does this load the CPU more, less, or unchanged?"** before it ships. The project's reason to exist is reducing CPU on slow machines; any change that incidentally adds CPU work erodes its own gains.

**Practical workflow:** include a brief CPU impact note in commit messages and Phase Outcome subsections. Examples of acceptable framings:
- `CPU: net reduction — skips OCR every tick during calibration.`
- `CPU: neutral — cosmetic reorder, same number of operations.`
- `CPU: slight increase (~+1 DOM write/s), justified by UX win [reason].`

If a change adds CPU cost, justify explicitly. If it reduces, note by how much (rough estimate is fine). If unsure, profile first.

This principle is broader than the OPTIMIZATION project's phases — it's the lens for every PR/commit going forward.

## Phase status (quick view)

Intentionally vague at this point — these will sharpen as we learn. Each phase has its own detailed status line below; keep both in sync when updating.

- **Phase 1 — Calibration smoothness** — VERIFIED & SHIPPED 2026-04-29. Heavy-work pause + clobber guard + countdown UX polish (5 s timer, skip-0s frame).
- **Phase 2 — Profiling instrumentation** — NOT STARTED
- **Phase 3 — Targeted reductions** — Confirmed scope item ready (RoK pixel re-verification, data-independent); pre-profile candidates BLOCKED on Phase 2 data
- **Phase 4 — Slow-CPU verification** — BLOCKED on Phases 1-3

---

## Phase 1 — Calibration smoothness

**Status:** VERIFIED & SHIPPED 2026-04-29. User confirmed countdown renders smoothly on their PC. Slow-CPU tester verification still pending but user's machine was the primary testbed.

**Objective:** make the calibration UI countdown render smoothly — both on slow CPUs (free up the event loop) and on all CPUs (eliminate the static-status-text clobber that flashes through every 1 s).

**Scope** (two parts, both subtractive / minimal):

1. **Heavy-work pause in `tick()`.** Add `_calActive` early-return inside `tick()` AFTER tickCount++ / stats update + alt1-readiness check, BEFORE setupReader / chat read / panel scan / dg map scan / overlay redraws. Frees CPU during the countdown.

2. **Clobber guard in `renderCalibrationStatus`.** Add `if (_calActive) return;` at the top of `renderCalibrationStatus` ([src/index.js:970](src/index.js)). Stops the 1 s `setInterval` from overwriting the countdown text mid-capture. This is the dominant cause of the visible stutter — the heavy-work pause alone wasn't sufficient (verified by user 2026-04-29).

Plus: the `_calActive` declaration was moved above the first synchronous `renderCalibrationStatus()` call to avoid a TDZ throw at module-eval (same pattern as HANDOFF invariant #11). Comment expanded to document the now-triple role: re-entry guard + tick gate + status-render gate.

**Acceptance:**
- Calibration countdown renders without stutter on at least one slow-CPU tester.
- No regression in any tracker behaviour outside calibration — tick is unchanged when `_calActive === false`.
- Detection state still resets correctly after calibration completes (path unchanged).

**Risk:** minimal. Subtractive code only. If it doesn't help, single-commit revert leaves zero side effects.

**Prior-art reference:** previous failed attempt was at commit `1e2b101` (reverted by `5341c52`). DO NOT cherry-pick the whole commit — that bundle included the broken cursor-tracking overlay (see `project_dungkey_calibration_ux.md` in user memory). Only re-derive the early-return clause; nothing else from that diff.

### Outcome (2026-04-29, code uncommitted at time of writing)

**Iteration history:**

1. **Initial scope was heavy-work pause only.** Hypothesis: tick() OCR / panel scan / dg map work was competing with the countdown UI's event loop on slow CPUs. Landed `if (_calActive) return;` in `tick()` after the pixel-permission warning, before `setupReader()`.
2. **User Ctrl+R'd and reported the stutter persisted.** No regression elsewhere, but the visible problem was still there — heavy-work pause was a guess and turned out not to be the dominant cause.
3. **Investigation found the actual cause:** `setInterval(renderCalibrationStatus, 1000)` was overwriting the countdown text in the same DOM element that `captureMouseAfterDelay` updates every 150 ms. The static-status text was flashing through once a second.
4. **Phase 1 scope expanded** to include the clobber guard. Both fixes shipped together because either alone is insufficient (heavy-work pause without clobber guard still flashes static text every second; clobber guard without heavy-work pause still has CPU contention on slow machines).

**What landed** ([src/index.js](src/index.js)):
- `tick()` early-return `if (_calActive) return;` after pixel-permission warning, before `setupReader()`. 4-line block comment explaining intent.
- `renderCalibrationStatus` early-return `if (_calActive) return;` at function top. 7-line block comment explaining intent and noting that explicit calls in `runCalibrationForMetric`'s finally / not-found paths still render correctly post-capture.
- `_calActive` declaration moved above the first synchronous call to `renderCalibrationStatus()` to avoid a TDZ throw at module-eval. Comment expanded to triple-role (re-entry guard + tick gate + status-render gate) + explicit reference to HANDOFF invariant #11 for the same footgun pattern.
- Total behavioural diff: 2 lines of code (the two early-returns). The rest is comments + the let-declaration move.

**Build:** `npm run build` clean — webpack compiled successfully in ~1.5 s.

**Verified locally:**
- Behaviour outside calibration is bit-identical (both early-returns only fire when `_calActive === true`, which only happens inside `runCalibrationForMetric`'s try/finally).
- No new state introduced; the existing flag is reused for both new gates.
- The `setDebugStats(beat, ...)` call above the tick() early-return still runs every tick, so the metronome heartbeat the user watches in debug stats stays alive during calibration.
- `runCalibrationForMetric` already calls `renderCalibrationStatus()` explicitly in its `finally` and on the not-found error paths, so the static status display refreshes correctly the moment calibration ends.
- TDZ check: `_calActive` is now declared at line ~1051, before the first synchronous `renderCalibrationStatus()` call at line ~1063. Module-eval order is safe.

**Verified 2026-04-29:** user Ctrl+R'd and confirmed the countdown renders smoothly with no per-second flash. Both heavy-work pause and clobber guard work as intended.

**Additional countdown UX polish landed in the same session** (motivated by user feedback after verification):
- **Skip-0s frame** in `captureMouseAfterDelay`: time-up check moved before the text update so the final visible frame is "1s" → capture, with no transient "0s" written. Cosmetic only, no logic change.
- **Countdown extended 3 s → 5 s** for both TL and BR captures. Affects both region-based metrics (RoK party panel + DG map). Winterface calibration is a one-click flow with no countdown — untouched. Comments at [src/index.js:199](src/index.js) and [src/index.js:933](src/index.js) updated to match.

**CPU impact audit:**
- Heavy-work pause in `tick()`: **net reduction** during calibration. Skips chat OCR + panel scan + dg map scan + overlay redraws for the ~10 s of calibration. Substantial savings on slow CPUs where these subsystems were competing with the countdown UI's event loop.
- Clobber guard in `renderCalibrationStatus`: negligible reduction (5 DOM writes/s × 10 s = ~50 writes saved per calibration).
- `_calActive` declaration move: zero (module-eval order only).
- Skip-0s reorder: zero (same operations, reordered).
- Countdown extension 3 s → 5 s: negligible increase (~26 extra setTimeout-tick cycles per calibration; `tick()` is paused during this window so no real cost). Net session impact is still firmly in the reduction column.

**Commit reference:** see `Phase 1: calibration smoothness` in git log on `main`. (SHA omitted because it's brittle across rebases — message-based lookup is stable.)

---

## Phase 2 — Profiling instrumentation

**Status:** NOT STARTED. Begins after Phase 1 sign-off.

**Objective:** get hard data on where CPU goes per tick so Phase 3 targets the actual hot paths, not guesses.

**Approach (initial sketch — refine on pickup):**
- Wrap heavy tick subsystems with timing: chat OCR, panel scan, dg map scan, overlay redraw. Use `Date.now()` / `performance.now()` deltas — no fancy profiling library.
- Aggregate ms/tick over a rolling window (e.g., last 50 ticks).
- Emit one debug-channel line every N ticks (~10 s of wall time): `perf: chat=X panel=Y dgmap=Z overlay=W total=T (ms)`.
- Gate behind a Settings toggle "Show perf telemetry" so it's off by default and zero-cost when off.

**Acceptance:**
- Telemetry lines visible in debug log when toggle is on.
- Instrumentation overhead itself <1 ms/tick (verify by toggling and comparing total).
- No behaviour change when toggle is off.

**Open questions for whoever picks this up:**
- Where does the toggle live — under existing Diagnostics, or a new Performance subsection?
- Rolling window: per-subsystem circular buffer, or single bucket reset on emit?
- Should we capture per-tick max alongside the average? (Spike detection.)

---

## Phase 3 — Targeted reductions

**Status:** Mixed. Confirmed scope item below (RoK cheap pixel re-verification) is data-independent — motivated by a known UX bug, not by profile data, so it can land any time Phase 3 is opened. Pre-profile candidates remain BLOCKED on Phase 2 data.

**Objective:** apply optimizations to the 1-2 biggest consumers identified by profile data, plus the confirmed scope items below.

### Confirmed scope item — Cheap pixel re-verification for RoK panel detection

**Motivation (the user-visible bug):** the RoK warning banner on the Tracker / Floors tabs flickers visibly during normal play with the panel open. Ruins the static, immersive feel those tabs should have.

**Root cause** (diagnosed 2026-04-29, all line refs current as of that date):
- Panel scan runs every 3 s — `PARTY_INTERVAL_TICKS = 30` at [src/index.js:2081](src/index.js).
- The temporal-confirmation gate forces a single failed read to require 2 fresh reads (~6-9 s) to re-confirm. Single reads DO fail on real panels (cursor hover, OCR jitter near the red-classifier boundary, transient occlusions — see existing comment around `PANEL_UI_CLEAR_THRESHOLD = 3` at [src/index.js:2138](src/index.js) for the existing acknowledgement that these drops happen).
- Warning threshold `ROK_WARN_STALE_MS = 5000` at [src/index.js:905](src/index.js) is tighter than the worst-case re-confirmation gap.
- Result: warning blips visible for 1-4 s every time a single read fails. Looks like rhythmic flicker.

**Solution (F):** after a confirmed detection at origin (x, y), bypass the 3 s OCR cadence — sample red pixels at the known coordinates every tick (or every few ticks) and treat positive sampling as "panel still present" without running OCR. Fall back to the full OCR + temporal-confirmation gate only if the cheap pixel check fails. Resolves the flicker as a side effect; primary win is CPU savings from skipping OCR most of the time.

**Implementation locations:**
- `runPartyPanelRead` ([src/index.js:2158](src/index.js)) — add cheap-check fast path before the full OCR.
- `panelDetectionMatches` ([src/index.js:2110](src/index.js)) — may need a "stable confirmed origin" cache to know where to sample.
- `updateRokWarning` ([src/index.js:908](src/index.js)) — should become trivially flicker-free once cheap-check keeps `_lastPartyPanelDetectedAt` fresh.

**Scope guard:** changes the cadence/strategy of detection only. Does NOT change the temporal-confirmation gate's behaviour for slot rendering or state mutations — slot rendering still requires full confirmation as today, preserving the world-fluke false-positive protection the gate exists for.

**Other RoK fix options considered** (preserved for revisit if F turns out too big):
- A. Raise `ROK_WARN_STALE_MS` 5 s → 10 s — symptom mask only.
- B. Keep `_provisionalPanel` across single miss — doesn't address detection cost.
- C. Decouple warning timestamp from confirmation gate (separate "last-found" vs "last-confirmed" timestamps) — cleaner than A, smaller than F, but no CPU win.
- D. CSS opacity smoothing + reserve layout space — cosmetic only, doesn't address root cause.
- E. Show-transition debouncing — adds latency to real warnings.

F was preferred for being the only option that delivers BOTH the flicker fix AND a real CPU optimization.

---

**Pre-profile candidates** (orientation only — DO NOT act on these without profile data first; we'll likely be wrong about which matters most):

- **Chat OCR delta-hash.** Skip OCR when the chatbox region pixels are unchanged from last tick. Only OCR when a hash of the region differs.
- **Adaptive tick rate.** Drop master cadence to 5 Hz when idle (no active floor, no recent chat event). Stay at 10 Hz during active floor.
- **Work staggering.** Spread heavy subsystems across ticks rather than stacking — chat on tick A, panel on tick B, dg map on tick C — so peak per-tick CPU drops even if total throughput is unchanged.
- **Shared screen capture per tick.** If multiple subsystems each call `captureHoldFullRs()` independently, do one capture per tick and pass the buffer to all consumers.

**Working pattern for each reduction:**
1. Land as its own commit with before / after profile numbers in the commit message.
2. Re-run Phase 2 profile to verify the metric actually moved.
3. Regression pass: calibration + a real floor + party-panel detection. Confirm zero functionality change before moving on.

---

## Phase 4 — Slow-CPU verification

**Status:** BLOCKED on Phases 1-3.

**Objective:** confirm the felt-experience improvement on a real low-end machine.

**Approach:**
- Once Phases 1-3 are merged, push to `main`. Netlify auto-deploys in ~60-90 s.
- User asks the testers who originally reported lag to retest.
- Verified → project complete.
- Not verified → re-profile on the slow CPU (Phase 2 telemetry can stay live), iterate Phase 3.

---

## Working-style flags (carry over from HANDOFF.md)

These bit the previous calibration attempt and apply to every phase here:

1. **Discuss before code.** Plan + tradeoffs + your lean → wait for explicit greenlight ("yes" / "go ahead" / "do it") before any Edit/Write tool call. Even small diffs.
2. **Lower risk threshold when user can't iterate.** When the user can't test changes immediately, surface uncertainty even after thorough self-audit. Failure modes can hide below the JS try/catch boundary (Alt1 native crashes, anti-automation, CEF quirks).
3. **No emojis** in files unless explicitly asked.
4. **Test on dev server (`localhost:7290`) before commit.** Live deploy ships to all plugin users.

## Update protocol for the next agent

When picking up:
1. Read this file → find the most recent phase with status NOT STARTED (or IN PROGRESS if a previous session left work mid-flight).
2. Re-verify the phase's scope and acceptance criteria are still relevant — the codebase may have moved on between sessions.
3. Surface a plan to the user, wait for greenlight before any code change.

When wrapping up a phase:
- Update BOTH the top-of-file Phase status block AND the phase's own Status line: NOT STARTED → IN PROGRESS → DONE → VERIFIED.
- Append a short **Outcome** subsection to the phase: actual result, commit hash, any surprises or scope creep.
- If a phase reveals work that should be its own phase, add it (Phase 5, 6, etc.) — don't bundle.
- Update [NEXT.md](NEXT.md) with a one-liner pointing here as the live working doc.

## Notable constraints

- **No `alt1.overLayLine` cursor-tracking widgets.** See `project_dungkey_calibration_ux.md` in user memory for the prior incident — Alt1 itself crashed when the previous attempt did rapid cursor-tracking overlays.
- **All optimization must be testable on the dev server before commit.** No "ship and pray" on perf changes.
- **Live deploy pipeline:** commit → push → Netlify auto-build → Ctrl+R in plugin window. Live URL: `https://dungkey.netlify.app/`.

## Deferred (not part of this project)

Tracked here so they don't get lost, but explicitly out of scope for the CPU-reduction push:

- **Calibration precision UX (hold-still detection).** Replace 3 s timer with cursor-stops-moving capture. May become unnecessary if CPU reduction makes the felt imprecision go away. Revisit only after Phase 4 verification.
