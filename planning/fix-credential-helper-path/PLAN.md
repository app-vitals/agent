# Plan: fix-credential-helper-path

Repo: app-vitals/agent

## Problem

`~/.gitconfig` on the persistent agent home held
`credential.https://github.com.helper = !/scripts/bin/git-credential-shipwright.sh`,
a path that does not exist (the image ships it at `/app/scripts/bin/`). Every authenticated
git call then failed (`…: not found`, `could not read Username`), and `signed-push` refused
new-branch pushes with "cannot find the default branch to create the new branch from"
(it cannot fetch the default branch without a token) plus a generic
"bypass with SHIPWRIGHT_SIGNED_COMMITS=off" hint.

## Root cause

`runtime/boot.ts` (GITHUB_AUTH_SCRIPTS_BIN) derives the scripts dir with
`join(import.meta.dir, "..", "..", "scripts", "bin")`. From `/app/runtime` that is `/scripts/bin`.
`runtime/entrypoint-main.ts` uses one `..` and is correct. The extra `..` dates from the
`agent/src` -> `runtime/` move (a23c0f5). It only bites when boot.ts's syncConfig() retry path
runs `setupGitHubAuth`, which rewrites the global git config. Why it began surfacing on
2026-11-17 is inferred (account-scoped GitHub App changes + new image), not verified.

## Design

Rejected: a PATH-resolved helper (`helper = shipwright.sh`). Tested: works with plain git, but
the `git` wrapper strips `/app/scripts/bin` from PATH before exec'ing real git, so the helper
is not found. An absolute path is the right mechanism; make it correct and observable.

1. One shared `SCRIPTS_BIN` constant used by both call sites.
2. A `checkCredentialHelper(path)` guard in `configureAppGit` (the single writer of the helper
   line) that logs a prominent error when the helper is missing or not executable. Log and
   continue; do not fail boot (a git misconfig must not take down Slack/cron).
3. Surface it on the agent detail "GitHub Installations" card. No admin/UI change needed:
   admin's `state`/`lastError` are free strings and the card already renders `broken` with
   the `lastError` text. The reporter marks every installation `broken` with the constant
   `lastError` "git credential helper not found" when the check fails; the check re-runs each
   report, so the card clears itself once fixed. The path stays in the log, not the card.

## Tasks

| ID | Title | Layer | Model | Hours | Depends on |
|---|---|---|---|---|---|
| CHP-1.1 | fix: share one scripts/bin path between boot and entrypoint | Background | haiku | 1.5 | - |
| CHP-1.2 | feat: check the git credential helper exists before configuring git | Background | haiku | 2 | CHP-1.1 |
| CHP-1.3 | feat: report a broken credential helper in the GitHub installations snapshot | Background | sonnet | 3 | CHP-1.2 |

```
[START]
  └─ CHP-1.1
        └─ CHP-1.2
              └─ CHP-1.3
```

All additive; safe to deploy standalone. No HITL tasks.

## Not planned (flagged)

- `runtime/boot.ts` (contextStamp `pluginJsonPath`) builds a path with three `..` from the same
  directory and looks like the same off-by-one. Unverified; needs its own check.
- Injecting the helper from the git wrapper instead of `~/.gitconfig`: hidden behavior, and
  callers using git directly would bypass it.
