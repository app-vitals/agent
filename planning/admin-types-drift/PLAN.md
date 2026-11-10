# Plan: admin-types-drift

Repo: app-vitals/agent. Session: `admin-types-drift`.

## Problem

`lib/admin-types.ts` (published as `@app-vitals/agent-lib/admin-types`) has not been regenerated
from `admin/openapi.platform.json` across several spec-changing PRs. PR #152 (GitHub Enterprise
admin API) added five `/github-enterprise/*` paths to the spec but not to the types, so every
release since (v1.14.0 through v1.20.0) publishes `agent-lib` types that lack paths the
`agent-admin` spec declares. Shipwright's `admin-types-split` tests fail on any bump to those
versions, which blocks the platform-release bump PR.

Root cause: agent has no `generate:admin-types` script, `openapi-typescript` is not a dependency,
and nothing in CI compares the types to the spec. The spec itself is drift-tested
(`admin-spec.smoke.test.ts`); the types are not.

## Design

- Add a pinned `openapi-typescript@7.13.0` devDependency (same version shipwright uses for its
  coding types) and a `generate:admin-types` script: `admin/openapi.platform.json` -> `lib/admin-types.ts`.
- Regenerate. Verified on a scratch worktree off main (979b800): about 945 insertions / 803
  deletions in the one file (not only the GHE paths), `bun run typecheck` clean, and the runtime
  client, `coding-schema-guard` and `consumer-compat` unit tests pass. No consumer changes needed.
- Add a drift gate: a unit test that every path of the platform spec is a key of the generated
  `paths` interface, plus a CI step that re-runs the generator and fails on `git diff`.
  Agent regenerates both files in the same PR, so unlike the cross-repo consumer-compat drift check
  this cannot deadlock a PR that changes the admin surface.
- The step goes inside the existing required CI job, so no branch-protection change is needed.

## Tasks

| Task | Depends on | Layer | Model | Safe standalone |
|---|---|---|---|---|
| ADT-1.1 fix: add generate:admin-types script and regenerate lib/admin-types.ts | none | Shared | haiku | yes |
| ADT-1.2 ci: fail when lib/admin-types.ts drifts from admin/openapi.platform.json | ADT-1.1 | Shared | sonnet | yes (after 1.1) |

Dependency map: `[START] -> ADT-1.1 -> ADT-1.2`

## Risks and notes

- Open PR #154 also edits `lib/admin-types.ts` and both specs. Whichever lands second re-runs
  `bun run generate:admin-types`. #155 is independent.
- A future `openapi-typescript` bump changes the output and would trip the gate; pin it exactly and
  group it in Renovate with a regen.
- Shipwright bump PR #4917 is superseded and closed; the next `platform-release` dispatch after
  ADT-1.1 releases opens a fresh bump on the newest version. The shipwright-side
  `admin-spec.smoke` fix (mount the `/github-enterprise` app) is redone by the patch loop there.
