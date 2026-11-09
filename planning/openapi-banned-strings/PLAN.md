# Plan: openapi-banned-strings

## Problem
`app-vitals/agent` PR #140 (released as 1.11.0) added `"vitals-os"` as an example value in OpenAPI
schemas. Shipwright's Platform Release Bump regenerates its admin spec/types and docs snapshot from the
published package, then runs `check-banned-strings`, which rejects the string. The bump gave up after
3 attempts (shipwright PR #4911) and has failed on 4 consecutive runs.

`consumer-compat` (agent PR check) already packs the PR into a scratch shipwright checkout and runs
`admin-gen`, `typecheck`, `seed-dev-agent`, `migration-guard` — but not shipwright's `check-strings`.

## Design
1. Replace the example values with a neutral name in sources, docs source, and generated artifacts.
2. Add `check-strings` to consumer-compat so the next occurrence fails the agent PR, not the bump.

Safe to deploy standalone: yes (example values + CI step; no export renamed or removed).

## Tasks
| Task | Depends on | Model | HITL |
|---|---|---|---|
| AOS-1.1 fix: use neutral marketplace names in OpenAPI examples | — | haiku | |
| AOS-1.2 ci: run shipwright check-strings in consumer-compat | AOS-1.1 | sonnet | |

```
[START]
  └─ AOS-1.1
        └─ AOS-1.2
```

After AOS-1.1 merges the agent release tags 1.11.1; confirm shipwright's next bump run opens a green PR
(or supersedes #4911).

Note: AOS-1.2 only sees the regenerated spec/types in the scratch checkout; the docs snapshot is refreshed
only in shipwright's bump workflow, so AOS-1.1 adds a spec-level assertion and AOS-1.2 covers the docs
snapshot if cheap, otherwise documents the gap.
