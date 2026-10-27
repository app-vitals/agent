# Plan: signed-push-git-data-api

Repo: app-vitals/agent. Make `scripts/signed-push.ts` sign every commit shape.

## Background
`signed-push.ts` replays commits through GraphQL `createCommitOnBranch`, which can only add one single-parent commit on top of a branch head. It therefore refuses merge commits (plus new executable files, mode changes, symlinks and submodules). That blocked the patch run on app-vitals/agent#68 (conflict resolution needs a merge of main; `merge commit df21bc0 would be flattened`).

Spike on #68 proved the alternative: the REST Git Data API (`POST /git/blobs`, `/git/trees`, `/git/commits` with the original `parents` and no author/committer, then a fast-forward `PATCH /git/refs/heads/{branch}`) with a GitHub App installation token produces a commit GitHub signs (`verification.verified: true`, reason `valid`), author `<app>[bot]`, committer GitHub, and a tree identical to the local one.

## Design
1. Reads move to REST (`GET /repos/{r}`, `GET /git/ref/heads/{b}`); GraphQL is dropped, leaving one client.
2. Replay `rev-list --reverse --topo-order --parents base..HEAD`, keeping an old->new SHA map. A parent not in the map is already on the remote and used as-is, so merge commits keep both parents.
3. Per commit: `POST /git/trees` with `base_tree` = first parent's tree and entries from `diff-tree` against the first parent (modes, symlinks `120000`, submodules `160000`, deletes `sha: null`), then `POST /git/commits` with the mapped parents, the original message and no author/committer. Check `verification.verified` on each response.
4. Move the ref once, at the end: `POST /git/refs` for a new branch, `PATCH /git/refs/heads/{b}` with `force: false` for an existing one. Verify the final commit's tree equals local `HEAD^{tree}` before moving the ref. Nothing is visible on the remote until the ref moves, so a mid-replay failure leaves only unreferenced objects.
5. Request volume (secondary rate limit on content-creating requests, documented around 80/min and 500/hour; verify): skip blobs already in a parent that is on the remote, send UTF-8 text inline as tree `content`, use the blob API only for binary, cap concurrency and honour `Retry-After`.
6. Refusals that stay: force, tag, delete, `--all`/`--mirror`, multiple refspecs, non-fast-forward, the payload cap, an unverified commit. Removed: merge commits, new executable files, mode changes, symlinks, submodules, root commits, unrelated history.
7. Errors read like git's own (`! [rejected] ... (fetch first)`, `error: failed to push some refs to ...`, exit 1). A short hint is added only where the cause is the agent environment (unverified commit, missing owner or token). No changes to the shipwright plugin or `patch.md`.

## Decision Log
- Identity: defaulted to app[bot] author / GitHub committer (as today) - a custom author or committer would make GitHub skip signing; `Co-Authored-By` trailers are kept.
- Unverified commit: defaulted to refuse (with the standard bypass hint) - the feature exists to produce signed commits, and the ref only moves at the end, so nothing needs undoing.
- Root commits and unrelated history: defaulted to allow - the API accepts empty parents and the ref is created at the final tip.
- patch.md escalation wording: dropped - with merges supported there is little left to refuse, and errors should look like normal git errors (Dan, 2026-10-27).

## Tasks
| Task | Title | Depends on | Layer | Model | Hours |
|---|---|---|---|---|---|
| GDP-1.1 | refactor: replay signed pushes through the Git Data API | - | CLI | sonnet | 5 |
| GDP-1.2 | feat: let signed push carry merge commits, modes, symlinks and submodules | GDP-1.1 | CLI | sonnet | 4 |
| GDP-1.3 | perf: cut signed-push request volume | GDP-1.2 | CLI | sonnet | 4 |
| GDP-1.4 | docs: update signed-commits docs for the Git Data API flow | GDP-1.2, GDP-1.3 | Shared | haiku | 1 |

```
[PRIOR] SGC-2.1 (pending, HITL) - re-verify end to end after GDP-1.2 ships
[START]
  `- GDP-1.1 -> GDP-1.2 -> GDP-1.3 -> GDP-1.4
```

## Breaking Change Safety
The CLI surface, the git wrapper and the env vars (`SHIPWRIGHT_SIGNED_COMMITS`, `SHIPWRIGHT_SIGNED_COMMITS_MAX_BYTES`) are unchanged. The exports that go away (`buildCommitInput`, `splitMessage`) are only used by the helper's own tests and are replaced in the same task. The installation token already needs `contents: write`. Safe to deploy standalone: yes (all four).
