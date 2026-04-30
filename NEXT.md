# Pickup note — 2026-04-29

You're continuing work on the DungKey Tracker Alt1 plugin. Read [HANDOFF.md](HANDOFF.md) first for project orientation, then this file for current state, then [OPTIMIZATION.md](OPTIMIZATION.md) for the active CPU-reduction project.

## Active project

**CPU reduction** — see [OPTIMIZATION.md](OPTIMIZATION.md) for the multi-phase plan. The original "calibration UX" issue is now folded into this project as Phase 1 (heavy-work pause). Plugin-wide CPU reduction is the umbrella goal.

**Current phase:** Phase 1 — Calibration smoothness — **VERIFIED & SHIPPED 2026-04-29**. Heavy-work pause + `renderCalibrationStatus` clobber guard + countdown UX polish (5 s timer, skip-0s frame) all shipped together. User confirmed smooth on their PC. See OPTIMIZATION.md Phase 1 Outcome for the full iteration history (heavy-work pause shipped first as a guess, didn't resolve visible problem; clobber guard turned out to be the dominant cause).

**Next available work** (user direction needed before starting):
- Phase 3 confirmed scope item — RoK pixel re-verification (data-independent, ready to start). Resolves the RoK warning banner flicker the user reported on 2026-04-29 + delivers a real CPU saving. Full spec in OPTIMIZATION.md.
- Phase 2 — profiling instrumentation (gates the rest of Phase 3's pre-profile candidates).

## State of the local repo

```
origin/main: 9311846 (live: density pass + webhook reorder)
local main is N commits ahead of origin (re-check with: git log --oneline origin/main..HEAD)

Of the historical commits since 9311846:
  1e2b101 + 82d9a9b — broken calibration attempt (code + HANDOFF doc)
  5341c52 + 1c82b30 — their reverts (cancel the pair above)
  d401c22           — NEXT.md pickup note (net-new)
  [+ any newer planning/optimization commits — check git log]
```

The 4 calibration-attempt commits cancel in pairs. Net-new value-bearing commits are the docs (NEXT.md, OPTIMIZATION.md, etc.). Push decision still pending — the user has not chosen between:

- **(i) Push everything.** Preserves audit trail in remote history; ships two no-op commits to live deploy timeline.
- **(ii) Reset to `origin/main` + recommit only the value-bearing changes.** Cleaner history; destructive (needs explicit user OK).
- **(iii) Hold local until Phase 1 lands**, then push the lot together.

**Don't push without asking.**

## First moves

1. Read this file
2. Read [HANDOFF.md](HANDOFF.md) (project orientation, working-style flags, invariants 1-17)
3. Read [OPTIMIZATION.md](OPTIMIZATION.md) (active CPU project — find the most recent NOT STARTED or IN PROGRESS phase)
4. Skim `project_dungkey_calibration_ux.md` in user memory (prior incident; informs constraints listed in OPTIMIZATION.md)
5. Greet the user, summarize state in 2-3 sentences, ask:
   - Confirm the next phase from OPTIMIZATION.md is still what you want to tackle?
   - If commits are unpushed and the push question is still open: push / reset / hold?
6. Wait for greenlight before any code change.
