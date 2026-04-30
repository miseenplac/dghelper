# Pickup note — 2026-04-30

You're continuing work on the DungKey Tracker Alt1 plugin. Read [HANDOFF.md](HANDOFF.md) first for project orientation, then this file for current state, then [OPTIMIZATION.md](OPTIMIZATION.md) for the active CPU-reduction project.

## Active project

**CPU reduction** — see [OPTIMIZATION.md](OPTIMIZATION.md) for the multi-phase plan. The original "calibration UX" issue is now folded into this project as Phase 1 (heavy-work pause). Plugin-wide CPU reduction is the umbrella goal.

**Phase status:**
- Phase 1 — Calibration smoothness — VERIFIED & SHIPPED 2026-04-29. Heavy-work pause + `renderCalibrationStatus` clobber guard + countdown UX polish.
- Phase 2 — Profiling instrumentation — VERIFIED 2026-04-30. Lightweight always-on perf line in debug log, once per minute. First data point flagged chat OCR as the dominant CPU consumer (~195 ms avg per tick when idle outside a dungeon).
- Phase 3 — Targeted reductions — Confirmed scope item (RoK cheap pixel re-verification + provisional timestamp bump) VERIFIED 2026-04-30. Banner no longer flickers during a floor; open-panel-mid-floor lag dropped from ~6 s to ~3 s.
- Phase 4 — Slow-CPU verification — READY. **Current phase.** Push to main + ask original slow-CPU testers to retest.

**Next move:** push the in-flight commits to main (Netlify auto-deploys), then user pings the original slow-CPU testers. If verified → project complete. If not → re-examine Phase 3 candidates (chat OCR delta-hash is the obvious next target per Phase 2 data).

**Pre-profile candidates remaining for future iteration** (only if Phase 4 reveals more lag):
- Chat OCR delta-hash (highest-value per Phase 2 data — 84% of total tick CPU is `reader.read()`).
- Adaptive tick rate, work staggering, shared screen capture per tick. See OPTIMIZATION.md Phase 3 pre-profile candidates list.

## State of the local repo

Local `main` is up to date with `origin/main`. Phases 1, 2, and 3 of the optimization project landed in commits on `main` (re-check the latest with `git log --oneline -10`). Whatever uncommitted edits you find in `git status` are in-flight new work, not the historical "two no-op commits" question — that resolved itself when those edits got committed and pushed cleanly.

## First moves

1. Read this file
2. Read [HANDOFF.md](HANDOFF.md) (project orientation, working-style flags, invariants 1-17)
3. Read [OPTIMIZATION.md](OPTIMIZATION.md) (active CPU project — Phase 4 is currently READY; pick up the next NOT STARTED, IN PROGRESS, or READY phase)
4. Skim `project_dungkey_calibration_ux.md` in user memory (prior incident; informs constraints listed in OPTIMIZATION.md)
5. Greet the user, summarize state in 2-3 sentences, ask:
   - Phase 4 is felt-experience verification on a slow CPU. Has the user heard back from testers? If yes, what was the read?
   - If verified → mark the project complete + tear out the Phase 2 perf scaffolding (grep `_perf` and `T0 = performance.now()` per the in-code REMOVE AT PROJECT COMPLETION marker).
   - If not verified → re-examine Phase 3 pre-profile candidates (chat OCR delta-hash is the obvious next target per Phase 2 data).
6. Wait for greenlight before any code change.
