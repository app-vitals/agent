# Plan: automatic releases for app-vitals/agent

Session: `agent-auto-release` · Repo: `app-vitals/agent` · Task prefix: `ARL`

## Problem

`release.yml` has no automatic trigger. A release needs an admin to dispatch the
workflow (cut a version), and the tag it creates then triggers the publish. No
task owns cutting the first release, so `AGR-3.1` and `AGR-3.2` are deployed but
have never been exercised by a real release, and `AGR-4.1` needs a real published
`@app-vitals/agent-lib`.

A dry run of the cut (run 40139663291) analysed 563 commits, computed `1.0.0`, and
failed at `generateNotes`: `conventional-changelog-conventionalcommits@^10` needs
`conventional-changelog-writer@9`, but the lockfile pins 8.4.0 via
`release-notes-generator@14`. The same mismatch exists in shipwright, where the
release job is a dormant manual hatch.

## Constraints

- npm Trusted Publishing is bound to the workflow filename `release.yml`; every
  publish step stays in that file (no `workflow_call` indirection).
- npm versions are permanent. The first release must be supervised.
- The ruleset on `main` requires review and four checks; the release needs no push
  to `main` (the changelog and git plugins were removed).
- `workflow_run` triggers are disallowed by zizmor, so the release waits for CI
  itself.

## Design

1. **Fix the notes step.** Pin the changelog preset to the major that matches the
   locked writer (`^9`), or bump `release-notes-generator`. Regenerate the lockfile
   with Bun 1.4.3 (the version CI pins), or the Slack patch silently stops applying.
2. **Rehearsable publish.** A `version` dispatch input with `dry_run=true` lets the
   publish and image jobs run at `HEAD` without a tag. A non-dry run without a tag
   is rejected. The tag trigger excludes `v0.0.0`, reserved as the baseline tag.
3. **Automatic trigger.** `push: branches: [main]`, gated by the repo variable
   `AUTO_RELEASE == 'true'` (default off, doubling as a kill switch). Tag-path
   conditions change from `github.event_name == 'push'` to `github.ref_type == 'tag'`
   so a branch push is never validated as a tag. `concurrency: release` serialises
   runs. A wait job polls the three CI check-runs on the commit and fails the run if
   any is red, missing, or times out. Commits without `feat`/`fix`/`perf` produce no
   release and the run is green.
4. **Alerting is a red build.** Every failure path fails the workflow run; there is
   no `continue-on-error` and no issue-opening job.
5. **First release is supervised and starts at 0.1.0.** semantic-release computes
   `1.0.0` for a repo with no tags. A baseline tag `v0.0.0` on the root commit makes
   the first feat-driven release `0.1.0`. After verification, `AUTO_RELEASE=true`.

## Breaking-change scan (release pipeline consumers)

| Consumer | Effect |
|---|---|
| `AGR-3.3` (PR #9) | Adds a notify job to `release.yml`; `ARL-1.3` rebases over it. Its dispatch to shipwright is exercised by `ARL-2.1`. |
| `AGR-3.2` (merged) | Consumer smoke called from `release.yml`; unchanged, exercised by `ARL-2.1`. |
| `AGR-4.1` | Receiver in shipwright; now depends on `ARL-2.1` so a real package exists. Every release produces a bump, so the receiver should update an open bump PR instead of opening many. |
| `PLD-2.1` | Vendors platform docs on each release; already depends on `AGR-4.1`, so it is covered transitively. |
| `release.yml` internals | `resolve` and `guard` conditions used `event_name == 'push'` to mean a tag push; `ARL-1.3` switches them to `ref_type == 'tag'`. |

## Tasks

| ID | Title | Depends on | Complexity / model | Hours | HITL |
|---|---|---|---|---|---|
| ARL-1.1 | fix: align the changelog preset with the locked changelog writer | — | 2 / haiku | 2 | |
| ARL-1.2 | ci: dry-run the publish at HEAD without a tag | — | 3 / sonnet | 4 | |
| ARL-1.3 | ci: release automatically on merge to main | ARL-1.1, ARL-1.2 | 4 / sonnet | 5 | |
| ARL-2.1 | chore: cut the first release (0.1.0) under supervision, then enable automatic releases | ARL-1.3, AGR-3.3 | 2 / haiku | 3 | ⚠ HITL |

```
[PRIOR SESSIONS]
  └─ AGR-3.3: notify shipwright when the platform releases [pr_open] (session: agent-repo-extraction)

[START]
  ├─ ARL-1.1 (no deps)
  └─ ARL-1.2 (no deps)
        └─ ARL-1.3 (needs 1.1, 1.2)
              └─ ARL-2.1 (needs 1.3, AGR-3.3)  ⚠ HITL
                    └─ AGR-4.1 (cross-session; PLD-2.1 follows it)
```

Every task is safe to deploy standalone: the automatic trigger ships disabled
(`AUTO_RELEASE` unset) and the dry-run input only adds an option.

## Decision Log

- Automatic trigger: gated by repo variable `AUTO_RELEASE`, default off — a kill
  switch that turns the trigger on without another PR (decided by Dan).
- Release waits for CI on the commit before cutting — decided by Dan.
- First version `0.1.0` via a baseline `v0.0.0` tag, not the analyzer's `1.0.0` —
  decided by Dan.
- Failure alerting is a red workflow run; no issue or Slack job — decided by Dan.
- `ARL-2.1` added as a dependency of `AGR-4.1`; `PLD-2.1` left alone because it
  already depends on `AGR-4.1`.
- Out of scope: shipwright's own `.releaserc` and package versions carry the same
  preset mismatch but its release job is dormant.
