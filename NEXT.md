# Pickup note — 2026-04-30 (post CPU-reduction project, pre UI work)

You're continuing work on the DungKey Tracker Alt1 plugin. The CPU-reduction project ([OPTIMIZATION.md](OPTIMIZATION.md)) is concluded; the user has pivoted to UI work. Read [HANDOFF.md](HANDOFF.md) first for project orientation, then this file for current state, then [UI.md](UI.md) for the new active working doc.

## Active project

**UI changes** — see [UI.md](UI.md) for the new working doc, including the existing UI architecture summary and the four load-bearing UI invariants you must not violate (#11, #16, #17, #18 from HANDOFF.md).

The user has not yet specified the first UI phase — they pivoted into this chapter immediately after CPU-reduction wrapped. **Greet the user, ask what UI work they want to engage in, and gather requirements before planning.** Don't guess at what they want.

## CPU-reduction project — concluded

Phases 1-7 all shipped + verified on user's machine. Phase 4 (slow-CPU tester verification) is in tester hands as a final feedback loop, non-blocking. Chat OCR was investigated as the dominant remaining culprit and explicitly shelved with the framework documented in [OPTIMIZATION.md Deferred section](OPTIMIZATION.md) so a future agent doesn't re-explore cold.

If a tester reports Phase 7 is still felt-laggy on slow CPUs, the next attack is chat OCR delta-hash — full plan written up under "Chat OCR" in OPTIMIZATION.md Deferred. Otherwise the project stays closed.

Other deferred CPU items (none urgent):
- Cold-start detection latency (~10 s after Ctrl+R + immediate floor entry).
- Solo-pin Tier 1 regional bind (139 ms `pin` max on door-info events).
- `runDgMapRead` active-floor gate.
- Phase 2 perf scaffolding removal (project-completion work; remove once Phase 4 verifies).

All documented in [OPTIMIZATION.md](OPTIMIZATION.md) Deferred section.

## Findings worth carrying forward (relevant to UI work too)

- **`style-loader` injects CSS at runtime via JS** ([alt1/dist/style-loader](node_modules/style-loader)). A top-level JS throw aborts the bundle BEFORE style tags are appended → all CSS appears not to load. Symptom after Ctrl+R: headings render at default h2 size, buttons look unstyled. That's a JS throw, not a CSS issue. HANDOFF invariant #16.
- **`appconfig.json` is read by Alt1 at install time, not Ctrl+R** (HANDOFF invariant #17). Width/height/permissions changes only take effect after re-install. Code-bundle changes propagate via Ctrl+R.
- **Tab nav `loadActiveTab` IIFE must run AFTER the RoK warning block** (HANDOFF invariant #11). TDZ throw on earlier placement.
- **`renderCalibrationStatus()` calls from `runCalibrationForMetric` must be in `finally` AFTER `_calActive = false`** (HANDOFF invariant #18). New as of commit `c9b99f4`. Touching calibration UI without re-reading this reintroduces the lag-on-error symptom.

## Working-style flags (carry from HANDOFF.md)

1. **Discuss before code.** Plan + tradeoffs + lean → wait for explicit greenlight ("yes" / "go ahead" / "do it") before any Edit/Write tool call. Even small diffs.
2. **Confirm before code applies even to small diffs.** A 1-line CSS tweak still gets stated and confirmed.
3. **For UI changes, start the dev server and verify in browser before reporting the task as complete.** Type checking and test suites verify code correctness, not feature correctness.
4. **Test on dev server (`localhost:7290`) before commit.** Live deploy ships to all plugin users.
5. **No emojis** in files unless explicitly asked.
6. **Trust user bug reports.** Don't hypothesize user error. Investigate code/data directly.
7. **Pace control: don't pile sub-decisions.** Report results in 1-3 short paragraphs after each entry. No "what's next?" sections, no embedded greenlight requests for follow-on work — user paces.
8. **CPU note required in commit message** (HANDOFF rule #6). UI changes that add per-tick DOM writes or observers need a brief CPU note even when net-neutral.

## State of local repo

`main` is up to date with `origin/main` after the CPU-reduction project wrap-up commits (Phase 7 parts 1-3, calibration fix, doc updates).

## First moves

1. Read this file (you're here).
2. Read [HANDOFF.md](HANDOFF.md) for project orientation, working-style rules, and the 18 load-bearing invariants.
3. Read [UI.md](UI.md) for the new working doc — UI architecture summary and invariants are there.
4. Skim user memory in `C:\Users\Aari Jabar\.claude\projects\C--Users-Aari-Jabar-Desktop-rs-scripts\memory\`. Especially `feedback_pace_control.md`, `feedback_confirm_before_code.md`, and `project_dungkey_ui_tabs.md` (the existing 4-tab UI architecture).
5. Greet the user, summarize state in 2-3 sentences, **ask what UI work they want to engage in**. Don't propose specific changes until they've described what they have in mind.
