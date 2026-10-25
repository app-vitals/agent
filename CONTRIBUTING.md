# Contributing

Thanks for your interest. This document covers the conventions and the release process.

## Code of conduct

Be respectful and constructive.

## Conventions

### Commit style and PR titles

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

Allowed types: `feat`, `fix`, `perf`, `revert`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`. Mark breaking changes with `!` after the type or a `BREAKING CHANGE:` footer.

Pull requests are squash-merged, so the PR title becomes the commit subject that semantic-release reads. The `pr-title-lint` workflow rejects titles that are not Conventional Commits.

### Tests land with the code

Tests ship in the same PR as the change, at the right layer:

- **unit** (`*.unit.test.ts`): pure logic, no I/O
- **integration** (`*.integration.test.ts`): real dependency behavior through injected doubles or a test database
- **smoke** (`*.smoke.test.ts`): endpoints exercised in-process, or image-level checks in CI
- **e2e** (`admin/e2e/`): browser flows through Playwright

### The import boundary

Everything in `runtime/`, `admin/`, `lib/` and `agent-types/` must resolve inside this repository. `bun run check:boundary` fails on any import that leaves it.

## Development workflow

1. Branch from `main`; never commit to `main` directly.
2. Run `bun run lint`, `bun run typecheck`, `bun run check:boundary` and `bun test` before pushing.
3. Open a PR with a Conventional Commit title.

## Release process

Releases are driven by semantic-release through the `Release` workflow, on demand or automatically on merge to main.

1. Go to **Actions, Release** and click **Run workflow** (leave `tag` empty).
2. Run with `dry_run` set to `true` first to preview the next version and release notes.
3. Re-run with `dry_run` unchecked. semantic-release tags `vX.Y.Z`; the tag push publishes `@app-vitals/agent-lib`, `agent-runtime` and `agent-admin` to npm (Trusted Publishing, provenance on) and `ghcr.io/app-vitals/agent` and `agent-admin` images tagged `X.Y.Z`.
4. To re-run or dry-run a publish for an existing tag, run the workflow with `tag` set (and `dry_run` if previewing). Versions and image tags that already exist are skipped.
5. To rehearse the publish before any tag exists, run the workflow on your branch with `dry_run` set and `version` set to `X.Y.Z` (no `tag`). It checks out the dispatched commit, runs `npm publish --dry-run` and builds both images without logging in or pushing. A `version` dispatch without `dry_run` fails fast.
6. Automatic release: set the repo variable `AUTO_RELEASE` to `true` and every push to main waits for the three CI checks (lint / typecheck / boundary / test, runtime docker build, admin docker build) for up to 25 minutes, then runs semantic-release. Commits with no `feat`, `fix` or `perf` produce no release. A red, missing or timed-out check fails the run; the red build is the alert. Unset or clear the variable to turn it off.

Release notes live on the GitHub release; there is no committed changelog (main is protected, so semantic-release does not push commits).
