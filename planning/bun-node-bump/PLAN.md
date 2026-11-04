# Plan: bun-node-bump (app-vitals/agent)

Bump the toolchain to bun 1.4.4 and node 26, and harden the release consumer-smoke wait. Follows #109 (base images pinned by digest), now merged.

## Findings
- `oven/bun:1-slim` is a floating tag; its pinned digest (`sha256:1846adf2…`) is the digest of `oven/bun:1.4.4-slim`, so images already run 1.4.4. CI pins `bun-version: "1.4.3"` in 10 places (`ci.yml` x5, `release.yml` x3, `consumer-compat.yml`, `consumer-smoke.yml`) and `scripts/release-workflow.unit.test.ts` asserts it.
- Node appears only in the `runtime/Dockerfile` `node-source` stage (`node:24-trixie-slim`); its comment still says `node:22`. `node:26-trixie-slim` exists.
- v1.2.0 release run 41677115986: Consumer smoke failed. `bun add` hit `failed to resolve` then tarball 404 for 12 attempts (~4 min) while npm propagated `1.2.0`; the packages are visible now. v1.1.0 passed. Retry budget in `scripts/consumer-smoke.ts` (12 x 20s) is too short.

## Design
1. BNB-1.1: CI `bun-version` -> `1.4.4` (+ test assertion); Dockerfile `oven/bun:1-slim@sha` -> `oven/bun:1.4.4-slim@sha` (tag now matches digest; Renovate bumps both).
2. BNB-1.2: `node-source` -> `node:26-trixie-slim@<digest>`; fix stale comment. Claude Code CLI runs on this node; the runtime docker build + base-image contract smoke exercise it.
3. BNB-1.3: consumer-smoke polls `npm view` for each package/version, and retry budget goes to ~10 min.

## Tasks
| Task | Depends on | Branch | Layer | Model | HITL |
|---|---|---|---|---|---|
| BNB-1.1 build: pin bun 1.4.4 in CI and Dockerfiles | — | build/bnb-bun-node-bump | CLI | haiku | |
| BNB-1.2 build: bump runtime node-source to node 26 | BNB-1.1 | build/bnb-bun-node-bump | CLI | haiku | |
| BNB-1.3 fix: widen consumer-smoke registry wait | — | fix/bnb-1-3-consumer-smoke-wait | CLI | haiku | |

BNB-1.1 and BNB-1.2 are bundled (one PR). All changes are in-place version changes: Safe to deploy standalone: yes.
