# Goal run: execute the upstream merge, pairing and scene library plan

Paste everything below the line into a Claude Code session started with `cw feat/upstream-merge-and-live-scenes` from a clone of `betamobility/slides` that has the branch `docs/plan-upstream-and-live-scenes` merged or checked out. The run is autonomous; it stops only at the points named under "Stops".

---

/goal Execute `docs/plans/2026-10-13-2236-feat-upstream-merge-and-live-scenes-plan.md` to completion, unit by unit, with Codex as the independent tester, and keep going until every Definition of Done line in that plan is true or a stop condition below is reached.

## Authority

The plan's Goal Capsule, session-settled Key Decisions and Scope Boundaries are fixed. `docs/PLATFORM.md` and `AGENTS.md` win over the plan. Do not widen scope, do not build anything the plan lists as considered and not built, and never reference or depend on any third-party fork.

## How to work

1. Start every unit from the plan with `ce-work`, in this worktree, on this branch. Work the units in the order of the plan's Unit Index, except that U6 and U7 may run before U1 since they touch only `plugins/beta-slides/` and `server/deck-store/`.
2. Every unit ships with its rigs green locally and the full `beta` CI job green before the PR opens. A red rig is a regression or a fork divergence to remove, never a rig to skip or weaken.
3. Codex is the tester and the second reviewer. Codex runs on the same checkout as a peer; keep `AGENTS.md` canonical so it sees the same rules. For every unit, after your own verification and before the PR:
   - Run `ce-code-review` with its cross-model pass so Codex reviews the diff adversarially.
   - Ask Codex, through `codex exec` in this worktree, to break the unit: write and run at least three new failing-first tests against the unit's test scenarios from the plan, including one for each failure path the unit builds, and report which passed and which found a bug. A bug Codex finds is fixed with a repro test before the unit continues.
   - Repeat review and break attempts until Codex reports no new finding at P0 or P1 two rounds in a row. That is "rock solid" for the unit.
4. Browser-visible units (U10, U11, U13, U14) are verified by starting the dev server, loading the page, taking a screenshot, and recording a one-line regression check in the PR body.
5. Each unit lands as one squash-merged PR to `main` with Beta's attribution trailers, after CI is green, except U1, which lands as a merge commit. Push after every commit.
6. After the merge unit (U1) lands, run the sync rigs with `SEEDS=300` and the relay protocol rig once more on `main`.
7. Keep a running status file at `docs/plans/2026-10-13-2236-goal-status.md`: unit, state (todo, in progress, blocked, merged), the last Codex verdict, and the stop reached if any. Commit it with every unit.

## Stops

Stop the loop and write the status file with the exact reason when any of these holds. These are decisions or actions only Johan can take.

- A unit needs a release, a worker deploy (`server/deck-store` or `server/sync-worker`), or an Access change. Prepare everything up to that point, write the exact maintainer step into the status file, and stop that unit. Continue with units that do not depend on it.
- A change would touch `kernel/src/` outside the three named files, regenerate a `docId`, or let a deck control its own frame sandbox.
- Two consecutive attempts at the same step fail. Write one paragraph on what was assumed, what the evidence says, and what changes, before any third attempt.
- The caps below are reached.

## Caps

- At most 40 wake-ups for the whole run and at most 6 Codex rounds per unit.
- At most 8 pull requests opened by this run.
- Total spend ceiling: the session's configured budget; if the platform reports a cost, stop at 80 percent of it with the status file written.

## Done

The run is complete when every line of the plan's Definition of Done is true on `main`, the status file shows every unit merged or stopped with a named maintainer step, and the last Codex round on each merged unit reported no P0 or P1 finding. End with a `Status:` line that says which units merged, which stopped and why, and the exact next human step.
