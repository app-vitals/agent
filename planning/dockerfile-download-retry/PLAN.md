# Plan: dockerfile-download-retry

Repo: app-vitals/agent

## Context
Release run 42664951371 (APP-1.2 post-merge, PR #142) failed because `runtime/Dockerfile`'s
Piper block (`curl -fsSL` on github.com and huggingface.co) got a transient HTTP 500. Later
releases passed — a flake that blocked the task.

## Design
Add `--retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 15` to the three bare curls
in the Piper RUN block (~line 284-292). `--retry-all-errors` is required since curl does not
retry 500s by default under `-f`. No behavior change otherwise. Out of scope: the gh keyring
(line ~104) and mise installer (line ~121) curls.

## Tasks
| ID | Title | Deps | HITL |
|----|-------|------|------|
| DLR-1.1 | fix: retry transient failures in Dockerfile Piper downloads | — | no |

Safe to deploy standalone: yes (build-time only, no interface change).
