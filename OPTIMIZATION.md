# DungKey CPU Reduction Project

Multi-phase plan to reduce plugin CPU load on lower-end machines while preserving 100% of current functionality. This is the source-of-truth working doc for the optimization push — read alongside [HANDOFF.md](HANDOFF.md) (project-wide context) and [NEXT.md](NEXT.md) (current pickup point).

## Goal & non-goals

**GOAL:** make the plugin run smoothly on slow CPUs.

**NON-GOAL:** change any user-visible behaviour. No feature changes, no detection-accuracy regressions, no UX deltas. Identical functionality, lower CPU.

**Scope:** comprehensive efficiency review. Every subsystem is in scope, not just the named candidates in Phase 3. The pre-profile candidate list is starting orientation, not a ceiling — anything in the codebase that's wasting CPU is fair game during this push.

**Acceptance:** at least one tester on a low-end CPU reports the plugin feels responsive — calibration UI smooth, no felt stutter during active floor.

## Core principle (apply to every future change)

Every code change — in this project AND in the plugin generally — must answer: **"does this load the CPU more, less, or unchanged?"** before it ships. The project's reason to exist is reducing CPU on slow machines; any change that incidentally adds CPU work erodes its own gains.

**Practical workflow:** include a brief CPU impact note in commit messages and Phase Outcome subsections. Examples of acceptable framings:
- `CPU: net reduction — skips OCR every tick during calibration.`
- `CPU: neutral — cosmetic reorder, same number of operations.`
- `CPU: slight increase (~+1 DOM write/s), justified by UX win [reason].`

If a change adds CPU cost, justify explicitly. If it reduces, note by how much (rough estimate is fine). If genuinely unsure after reasoning, surface for discussion before shipping.

This principle is broader than the OPTIMIZATION project's phases — it's the lens for every PR/commit going forward.

## Phase status (quick view)

Intentionally vague at this point — these will sharpen as we learn. Each phase has its own detailed status line below; keep both in sync when updating.

- **Phase 1 — Calibration smoothness** — VERIFIED & SHIPPED 2026-04-29. Heavy-work pause + clobber guard + countdown UX polish (5 s timer, skip-0s frame).
- **Phase 2 — Profiling instrumentation** — VERIFIED 2026-04-30. Lightweight always-on perf line in debug log, once per minute. Confirmed emitting clean lines on user's machine; first data point flagged chat OCR (`reader.read()`) as the dominant CPU consumer.
- **Phase 3 — Targeted reductions** — VERIFIED 2026-04-30. RoK cheap pixel re-verification (Solution F) shipped — banner no longer flickers on/off during a floor; OCR is skipped while the cached origin's red pixels still pass the classifier. Provisional-bump tweak halved open-the-panel-during-floor latency from ~6 s to ~3 s.
- **Phase 4 — Slow-CPU verification** — READY. Push to main + ask original slow-CPU testers to retest.
- **Phase 5 — Winterface auto-probe reduction** — VERIFIED 2026-04-30. Active-floor gate + two-stage capture (cheap region bind for peek, full bind only on confirmed peek hit). User-confirmed felt-instant winterface registration on test deploy.
- **Phase 6 — `cheapPanelStillPresent` regional bind + verification cadence decoupling** — VERIFIED 2026-04-30. Part 1: regional bind in `cheapPanelStillPresent` (full-RS bind for a 30×3 read → captureHold of just the 30×3 region). Part 2: dual-cadence design — per-tick "trust" bump + verification only every ~10 s. Side-eliminates RS3 panel-flicker false absences. User-confirmed clean across multi-floor runs with panel open.

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

**Status:** VERIFIED 2026-04-30. Code landed, built clean, perf line confirmed emitting on user's machine.

### Outcome (2026-04-30)

**First data point** (user idle outside a dungeon, ~150 s wall window):
```
perf: chatRead=195.1/1160.0 parser=0.1/1.9 pin=0.0/0.0 panel=6.0/184.3 dgmap=5.9/183.3 overlay=0.0/0.4 total=299.9/2490.5 (ms, avg/max over 600 ticks)
```

**Key findings:**
- Chat block (`reader.read()` Alt1 OCR) dominates by orders of magnitude — 195 ms avg per tick, 84% of total tick CPU. Tick is running back-to-back at ~4 Hz instead of idling at 10 Hz between fires.
- `parser` and `pin` near-zero as expected when idle (no chat lines, no door-info events).
- `panel` and `dgmap` modest at ~6 ms avg (mostly cadence-gated early-returns; max ~180 ms is the per-OCR-run cost).
- `overlay` is negligible.

**Iteration history:**
1. Initial implementation had a single `chat` bucket lumping `reader.read()` + parser loop + door-info self-pin cascade together. 215 ms avg was hard to interpret without splitting.
2. Split `chat` into `chatRead` / `parser` / `pin` so the dominant cost could be isolated. Confirmed `reader.read()` is the hot path.
3. **Bug fix:** when splitting `PERF_BUCKETS`, the emit-line template still referenced the old `chat` bucket name → `fmt('chat')` returned undefined → crash on first emit (~1 minute after Ctrl+R). Fixed: updated template to new bucket names + added a defensive guard in `fmt` so a future bucket-name typo can't crash the plugin again.

**Implication for Phase 3:** chat OCR delta-hash (skip OCR when chatbox region pixels unchanged from last tick) is the highest-value pre-profile candidate. Confirmed empirically, not just by reasoning.

**REMOVE AT PROJECT COMPLETION reminder:** the perf code is scaffolding. Both because (1) it adds CPU work itself, contradicting the project goal, and (2) it's diagnostic-only with no user value. Grep `_perf` + `T0 = performance.now()` to find every removal target. The debug panel infrastructure stays.

**Decision history:** the original Phase 2 plan was a Settings-gated profiling toggle. That was reconsidered (2026-04-30): a Settings toggle is the wrong frame for diagnostics-only instrumentation, and per-change CPU impact is already decidable by reasoning + HANDOFF rule #6 — so a heavy gate is overkill. We briefly marked Phase 2 SKIPPED on that basis. User then course-corrected: profile data IS valuable as a baseline (regression detection, before/after numbers on Phase 3 ships), just not behind a Settings toggle and not as a strict per-change gate. Final shape below reflects that: lightweight, always-on, no UI surface.

**What landed:**
- `_perfStats` accumulator with 5 buckets (`chat`, `panel`, `dgmap`, `overlay`, `total`). Each bucket holds `{sum, count, max}`.
- 4 measurement points wrapping `performance.now()` deltas around chat OCR + parser, `runPartyPanelRead()`, `runDgMapRead()`, `drawPinnedOverlays()`. The `total` bucket times the full tick body (post-early-returns).
- Always-on. Skips ticks that early-return before the full work runs (no alt1, chatbox not found, `_calActive`) so averages reflect real work, not stalls.
- Emits one debug-log line every 600 ticks (~60 s wall at 100 ms tick) via `dbg('info', 'perf: chat=avg/max panel=avg/max dgmap=avg/max overlay=avg/max total=avg/max (ms, …)')`.
- Buckets reset on each emit — each line represents the most recent minute, not a session-cumulative average.
- No Settings toggle. No flag.

**Self-overhead audit:** ~5 `performance.now()` calls/tick, sub-microsecond each. Negligible against the ms-scale subsystem times being measured. If the reported `total` ever shows a meaningful jump after this lands, the instrumentation itself is the suspect.

**How to read the line:**
- `chat=2.1/8.4` means: across the last minute, chat OCR + parser averaged 2.1 ms per tick, with the worst single tick at 8.4 ms.
- If `chat+panel+dgmap+overlay << total`, the gap is in unmeasured subsystems (`runAutoWinterfaceProbe`, `runTriangleSnapshot`, `updateRokWarning`).
- Per-subsystem buckets count EVERY tick that reached the relevant call site, including the cadence-gated early-returns inside `runPartyPanelRead` / `runDgMapRead`. So the avg reflects per-tick CPU pressure, not per-actual-OCR-run cost. Max is the real heavy-work cost.

**Acceptance:**
- `perf:` lines appear in the debug panel approximately once per minute.
- No regression in any tracker behaviour — instrumentation is purely additive (timing wrappers + accumulator + emit).
- Total reads aren't wildly higher than the sum of measured subsystems (sanity check on instrumentation overhead).

**Implication for Phase 3:** pre-profile candidates aren't a hard gate on profile data, but the perf line IS available as a passive baseline. Standard practice for each Phase 3 ship: capture a `perf:` line before and after, include the delta in the commit message alongside the reasoning-based CPU-impact note (HANDOFF rule #6).

---

## Phase 3 — Targeted reductions

**Status:** Confirmed scope item (RoK cheap pixel re-verification) VERIFIED 2026-04-30 — see Outcome below. Pre-profile candidates follow; chat OCR delta-hash is the highest-value next move per Phase 2 data. Each ship should include before/after `perf:` lines from the Phase 2 instrumentation as supporting data alongside the reasoning-based CPU-impact note.

### Outcome — RoK cheap pixel re-verification (2026-04-30)

**What landed:**
- New `cheapPanelStillPresent(origin)` helper in [src/index.js](src/index.js) — scans a 30×3 px region around the cached origin, counts pixels passing the same red classifier the OCR uses (`r > 60 && g < 60 && b <= 10 && r > g && r > b * 2`), returns true on ≥3 hits. Microsecond cost.
- New `_panelStableOrigin` state — set to `{x, y}` after confirmed temporal-confirmation, cleared on cheap-check failure or absence-streak crossing `PANEL_UI_CLEAR_THRESHOLD`.
- `runPartyPanelRead` fast path: while `_panelStableOrigin` is set and the cheap check passes, skip the OCR cadence entirely and just bump `_lastPartyPanelDetectedAt`. Banner stays clear.
- **Provisional timestamp bump** (added 2026-04-30 after initial ship): `_lastPartyPanelDetectedAt` now also bumps on the first provisional OCR detection, not just after temporal-confirmation. Halves the open-the-panel-during-floor → banner-clears latency from ~6 s (one cadence + one confirmation cycle) to ~3 s (one cadence). State mutations still gated by confirmation. Updated HANDOFF invariant #13 to reflect.

**Iteration history:**
1. Initial cheap check sampled 3 single pixels at offsets +0, +5, +10 from origin with 2/3 hit threshold. Worked outside floors but flickered inside floors: anti-aliased letter rendering has near-black gaps between glyphs, so fixed-offset sampling could fall below threshold even with the panel present, dropping back to OCR cadence and re-creating the original flicker.
2. Swapped to 30×3 region scan with ≥3 hit threshold (mirrors `hasSlotColor`'s pattern in partyPanel.js). Robust against sub-pixel jitter, anti-aliasing gaps, and minor cursor occlusion. User confirmed flicker resolved.
3. User flagged 6 s lag when opening the panel mid-floor. Added the provisional-bump tweak above to halve it. Trade-off (world-fluke single-tick false-positive could clear the banner for ~5 s before re-appearing) accepted given fluke rarity.

**CPU impact:**
- Net reduction during steady-state play with panel open. Today panel bucket avg = 6 ms/tick (mostly the once-per-3 s OCR amortized across 30 ticks). With cache valid + cheap check passing, OCR is skipped → that 6 ms/tick avg drops to near-zero. Cheap check itself is microseconds.
- Modest in absolute terms — panel isn't the dominant consumer (chat is). The flicker fix is the primary win; CPU saving is the bonus.

**Touchpoints:** [src/index.js](src/index.js) `runPartyPanelRead`, `panelDetectionMatches`, `cheapPanelStillPresent` (new), `_panelStableOrigin` (new state); [HANDOFF.md](HANDOFF.md) invariant #13.

**Acceptance:** banner doesn't flicker during a floor with panel open ✓, banner clears within ~3 s of opening the panel mid-floor ✓, slot rendering / party size / self-slot detection unchanged ✓.

**Objective:** apply optimizations to the 1-2 biggest consumers (identified by reasoning + Phase 2 perf-line baseline), plus the confirmed scope items below.

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

**Pre-profile candidates** (tackled by reasoning + the CPU-impact principle question, with the Phase 2 perf line as a passive baseline; attack whichever subsystem the perf line shows is heaviest):

- **Chat OCR delta-hash.** Skip OCR when the chatbox region pixels are unchanged from last tick. Only OCR when a hash of the region differs.
- **Adaptive tick rate.** Drop master cadence to 5 Hz when idle (no active floor, no recent chat event). Stay at 10 Hz during active floor.
- **Work staggering.** Spread heavy subsystems across ticks rather than stacking — chat on tick A, panel on tick B, dg map on tick C — so peak per-tick CPU drops even if total throughput is unchanged.
- **Shared screen capture per tick.** If multiple subsystems each call `captureHoldFullRs()` independently, do one capture per tick and pass the buffer to all consumers.

**Working pattern for each reduction:**
1. Capture a baseline `perf:` line before any change (let it run a couple of minutes for stability).
2. Land as its own commit. Commit message must include the CPU impact note (HANDOFF rule #6) — reasoning-based, with the perf-line delta cited as supporting evidence.
3. Capture an after-change `perf:` line, confirm the targeted subsystem actually moved.
4. Regression pass: calibration + a real floor + party-panel detection. Confirm zero functionality change before moving on.

---

## Phase 4 — Slow-CPU verification

**Status:** READY 2026-04-30. Phases 1-3 all verified locally; awaiting push to main + slow-CPU tester retest.

**Objective:** confirm the felt-experience improvement on a real low-end machine.

**Approach:**
- Once Phases 1-3 are merged, push to `main`. Netlify auto-deploys in ~60-90 s.
- User asks the testers who originally reported lag to retest.
- Verified → project complete.
- Not verified → re-examine Phase 3 candidates (revisit the reasoning, consider candidates we deferred), iterate.

---

## Phase 5 — Winterface auto-probe reduction

**Status:** VERIFIED 2026-04-30. User-confirmed felt-instant winterface registration; two floors tested clean.

**Objective:** reduce CPU spent by `runAutoWinterfaceProbe`. Pre-Phase-5 the probe fired every 1.8 s while ANY plugin state allowed it, including outside dungeons entirely, and each fire bound the full RS window before peeking — paying full-screen capture cost for a peek that only sampled the title band. Two-part reduction.

### Outcome (2026-04-30)

**Part 1 — Active-floor gate.**
- Old: `if (cur && cur.time) return;` — bailed only when "already captured timer for this floor."
- New: `if (!cur || cur.time) return;` — also bails when no current floor exists at all.
- Removed the now-unreachable "plugin booted mid-dungeon" hint code + `_loggedMidDungeonBootHint` state. The hint paid full capture cost for a one-shot diagnostic — exactly the kind of waste this project targets.
- `cur.ended` INTENTIONALLY left unguarded so floors closed via Tier-2 outfit-bonus chat can still recover their timer if the winterface is on screen.
- `nextAutoPeekTick` advances after the gate, so the first probe after a floor-start fires immediately (no missed-timer risk from gate latency).

**Part 2 — Two-stage capture.**
- Old: every probe tick bound the full RS window (`captureHoldFullRs()`) before peeking.
- New: stage 1 binds a narrow X-clipped column (520 px × full RS height) via `a1lib.captureHold(peekX0, 0, peekW, alt1.rsHeight)`. Most probe ticks bottom out at stage 1's threshold check. Stage 2 (only on peek hit ≥ AUTO_PEEK_HIT_THRESHOLD) re-binds full RS so timer-digit OCR can reach pixels outside the title band — fires roughly once per floor.
- Why X-clipped column rather than Y-clipped band: `peekForWinterface` uses `screen.height * 0.15 / 0.55` internally to scope its Y scan; Y-clipping the bind would map those fractions to the wrong physical Y range. Keeping full height preserves the existing fraction math.
- Confirmed safe vs other subsystems: alt1's "one bind per app" replacement happens BETWEEN subsystem calls (each captures-then-uses inside its own function), not during them — DG map / RoK panel scans unaffected.

**CPU impact:**
- Outside dungeons → zero probe work (was ~33 captures/min).
- In-floor → cheap region bind per probe tick instead of full RS bind. Full RS bind only fires on actual peek hits, ~once per floor.
- Empirical evidence on `alt1.bindRegion` cost: meaningfully region-proportional. The user-felt result ("feels literally instant" on test deploy) implies a much larger reduction than the conservative pre-ship range (0-73%); the actual delta is closer to the high end. This answers the F/R question that was open during planning.

**Iteration history:**
1. **Active-floor gate first.** Landed standalone, verified 2026-04-30 (two floors finished cleanly). User then asked about further winterface CPU reduction options.
2. **Considered chat-signal triggers** (boss-drop "received item:" / outfit-bonus). Outfit-bonus rejected — fires post-winterface, no useful pre-trigger value. Boss-drop window assumed a fixed timeout that turned out to be a fragile judgment call (player can take 30+ min after boss kill). Tabled in favour of region-based attack.
3. **Region-based capture explored.** alt1's `captureHold(x, y, w, h)` binds only a region. Verified other subsystems (DG map, RoK panel) wouldn't break — each captures-then-uses inside its own function call.
4. **Two-stage shape settled.** Cheap region bind for peek (frequent), full bind only on hit (rare). Shipped at current 1.8 s cadence — deferred cadence increase pending empirical R/F data, which the user-felt result then provided.

**Touchpoints:** [src/index.js](src/index.js) `runAutoWinterfaceProbe`, removed `_loggedMidDungeonBootHint` state.

**Acceptance:** floor-end timer captures correctly ✓ (user verified two floors); felt-CPU improvement at floor-end moment ✓ (user reported "feels literally instant").

---

## Phase 6 — `cheapPanelStillPresent` regional bind + verification cadence decoupling

**Status:** VERIFIED 2026-04-30. Two-part change shipped; user-confirmed clean behaviour across multi-floor runs.

**Objective:** apply the Phase 5 finding (alt1's `bindRegion` cost is region-proportional) to the plugin's most egregious full-screen-for-tiny-read site, and resolve a residual flicker in the RoK warning banner.

### Outcome (2026-04-30)

**Part 1 — Regional bind in `cheapPanelStillPresent`** ([src/index.js](src/index.js)).
- Old: `captureHoldFullRs()` then `screen.toData(x0, y0, 30, 3)` — full-screen capture for a 90-pixel read, every tick the RoK cache was valid.
- New: `captureHold(x0, y0, 30, 3)` — bind only the 30×3 region. `screen.toData(x0, y0, 30, 3)` unchanged because toData uses absolute coords and converts internally (verified at [alt1/src/base/imgref.ts:31-33](node_modules/alt1/src/base/imgref.ts:31)).
- Pixel-data per fire: dropped from ~2 M (1920×1080) to 90. ~5 orders of magnitude reduction. Highest savings ratio of any change in the project.

**Part 2 — Dual-cadence verification.**
After Part 1 shipped, user reported a residual issue: the RoK warning banner flickered a couple of times at floor-start, even with the panel open and steady. Investigation traced this to two interacting problems:
1. `_panelStableOrigin` survives across the inter-floor gap. At floor-start, the cheap-check ran every tick on those (potentially-stale-or-flickering) coords.
2. RS3's panel UI itself flickers for a few ms during state transitions (the panel re-anchors). During those frames, slot-1 red text is genuinely absent → cheap-check saw 0 hits → failed → cleared `_panelStableOrigin` → forced a full OCR re-detect cycle.

The fix decouples the per-tick "trust" cadence from the verification cadence:
- New constant `PANEL_VERIFY_INTERVAL_TICKS = 100` (~10 s).
- New state `nextPanelVerifyTick`.
- While `_panelStableOrigin` is set, every tick bumps `_lastPartyPanelDetectedAt` (banner stays cleared). `cheapPanelStillPresent` fires only every 10 s as a periodic verification. On pass: continue trust window. On fail: clear origin, fall through to OCR cadence.
- First verification scheduled a full interval out from a freshly-cached origin, so newly-confirmed panels get a 10 s "trust" window before any verification.

**Findings worth preserving:**
- `alt1.bindRegion` cost is meaningfully region-proportional. Phase 5 implied it; Phase 6 confirmed via the user-felt result. Future region-bind optimizations are real wins, not speculative.
- RS3's RoK panel UI flickers for ms during state transitions. Per-tick cheap-checks would occasionally sample those frames as false absences. Slow verification cadence (10 s vs ms-scale flicker) statistically dodges them.
- The trust-vs-verify decoupling is the design language: when state changes slowly, trust between checks rather than verify every tick.

**Accepted residual edge case:**
After closing the panel mid-floor, waiting for the warning, then reopening it, the banner can flash twice (~1 s each) before settling. Cause: OCR cycles flap between found/not-found while RS3's panel re-render animation completes. Each found→miss→found pattern interrupts temporal-confirmation and produces a brief banner flash (3 s OCR cadence + 5 s stale → 6 s gap when bumps are interleaved with misses → banner shows for ~1 s in between). Fixable with OCR-miss tolerance (mirror of cheap-check tolerance), but cost is ~6 s slower close-panel detection. User accepted as cosmetic edge case (rare flow, brief visual artifact, no functional impact).

**Touchpoints:** [src/index.js](src/index.js) — `cheapPanelStillPresent`, `runPartyPanelRead`, `_panelStableOrigin` declaration block.

**Acceptance:** banner stays cleared throughout multi-floor runs with panel open ✓; floor-start flicker resolved ✓; regional bind compiles cleanly and behaviour matches expectations ✓.

---

## Phase 7 candidate — Remaining periodic full-screen captures

**Status:** OPEN. Three more periodic `captureHoldFullRs()` callers remain, each amenable to the Phase 5/6 region-bind pattern.

Targets, in approximate yield order:

- **`runDgMapRead`** ([src/index.js:2711](src/index.js)) — every 30 ticks (~3 s) inside `findDgMap`. The full bind feeds a `screen.toData` call that's already region-scoped (calibrated dgMap region or default left-half). Switching `captureHoldFullRs()` → `captureHold(scanRegion.x, scanRegion.y, scanRegion.w, scanRegion.h)` saves the bind. Yield depends on the ratio of (calibrated region / default left-half) to full screen — typically ~40-50% of full screen, so ~50% reduction per fire.

- **`readPartyPanel`** ([src/partyPanel.js:931](src/partyPanel.js)) — every 30 ticks (~3 s) when active-floor gate passes. Full bind, then `screen.toData` reads the panelScanRect (right ~40% × middle 70% of screen ≈ 28% of full). ~70% reduction per fire if region-bound.

- **`findTrianglePx`** ([src/dgMap.js:953](src/dgMap.js)) — called from solo-pin cascade (event-driven, on door-info events) and `runTriangleSnapshot` (every 3 ticks when `settings.timestampedChat` is on; off by default for current user). Takes a `region` param. Same pattern as the others.

**Event-driven (low priority, mention for completeness):** `findDgMap` from solo-pin cascade, `captureEndDungeonTimer` (already paired with Phase 5's stage 2), Eyedrop, Run-layout-test, Calibrate Winterface.

Tackle one target per commit so any regression is bisectable. See [NEXT.md](NEXT.md) for the active pickup task.

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
