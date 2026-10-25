# Plan: signed-commits

Repo: app-vitals/agent. Verified (GitHub-signed) commits for GitHub App agents.

## Background
A GitHub App bot has no account to hold GPG/SSH keys, so a local `git push` can never produce a Verified badge. Commits created through the API with an installation token (GraphQL `createCommitOnBranch`, or REST create-commit with author/committer omitted) are signed by GitHub and attributed to the `app[bot]`. Signed commits can be required before merge, so this is worth doing. Squash/web-flow merge commits on the default branch are already GitHub-signed; this concerns the PR's branch commits.

## Design
1. `scripts/bin/git` (bash wrapper) sits ahead of real git on PATH (`/app/scripts/bin` already is), parses global options (`-C`, `-c`), strips its own dir from PATH and execs real git for everything except `push` with `SHIPWRIGHT_SIGNED_COMMITS=1`. Token/owner handling mirrors the `gh` wrapper: `SHIPWRIGHT_GH_OWNER` selects `gh-token.d/<owner>`; unset or missing gives a teaching error; PAT mode never enters this path.
2. `scripts/signed-push.ts` (bun): read remote head; `rev-list --reverse <remoteHead>..HEAD`; if the branch is new, create the ref at the merge-base with the default branch; replay each commit via `createCommitOnBranch` (base64 additions, deletions, message, `expectedHeadOid`). Author becomes the app; message and Co-Authored-By trailers are kept.
3. Safety: after replay, compare the new remote head's tree to local `HEAD^{tree}`; on mismatch stop before touching the worktree. On success `git fetch` then `git reset --mixed <newhead>` (not `--hard`; trees are identical so uncommitted work survives); honour `-u`.
4. Refusals (non-zero, teaching message ending with the bypass `SHIPWRIGHT_SIGNED_COMMITS=off git push ...`): new executable files, mode changes, symlinks, submodules, force/tag/delete pushes, non-fast-forward, payload over a size cap (default ~10 MB per commit, configurable, to be verified against GitHub's real limit). Mid-replay failure reports how many commits landed and says to fetch and rebase. Success message notes that SHAs changed.
5. Config: env var `SHIPWRIGHT_SIGNED_COMMITS`, off by default. Admin checkbox (Option A, no schema change) upserts/deletes the AgentEnv row; shown only when `GH_APP_ID` is set; reuses `POST /admin/agents/:id/settings` with the hidden-fallback pattern used by `restrictSlackToMembers`.

## Tasks
| Task | Title | Depends on | Layer | Model | HITL |
|---|---|---|---|---|---|
| SGC-1.1 | feat: add the signed-push helper for GitHub App agents | - | CLI | sonnet | |
| SGC-1.2 | feat: add the git wrapper that routes push through signed-push | SGC-1.1, AGR-3.1 | CLI | sonnet | |
| SGC-1.3 | feat: add a signed-commits toggle to the agent admin settings | - | Frontend | sonnet | |
| SGC-1.4 | docs: document signed commits, the git wrapper and the admin toggle | SGC-1.2, SGC-1.3 | Shared | haiku | |
| SGC-2.1 | chore: enable signed commits via the admin toggle and verify on a real PR | SGC-1.2, SGC-1.3 | CLI | haiku | HITL |

```
[PRIOR] AGR-3.1 (pr_open, agent#3)
[START]
  |- SGC-1.1 -> SGC-1.2 (also needs AGR-3.1) --\
  `- SGC-1.3 -----------------------------------+-> SGC-1.4
                                                `-> SGC-2.1 (HITL)
```

## Breaking Change Safety
All tasks are additive; the flag defaults off. Safe to deploy standalone: yes (all five).

## Related
Drift between the extracted platform and shipwright (notably the missing `gh` wrapper in `scripts/bin`, which AGR-4.3b would drop from shipwright's agent image) is tracked separately; a deeper-scan session is planned.
