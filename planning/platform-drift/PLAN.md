# Plan: platform-drift

Repos: app-vitals/agent (PLD-1.x), app-vitals/shipwright (PLD-2.x). Follow-up to session agent-repo-extraction (AGR-*).

## Scan method and result
`scripts/extract-platform.ts --no-history` run on shipwright main (8063ed8) and diffed against app-vitals/agent main: identical except bun.lock and .github/CODEOWNERS (added by the agent repo by design). The extraction is gated by an import-closure test, so code the platform imports cannot have been missed. Drift is limited to files nothing imports:

1. `agent/scripts/bin/gh` (owner-routing gh wrapper) is not extracted: `PATH_RENAMES` has no `agent/scripts/bin/*` entry, so platform `scripts/bin` has only the template's credential helper. The Dockerfile chmod and template test list only that helper. AGR-4.3b would therefore drop gh from the shipwright-agent image.
2. `agent/scripts/verify-cgroup-delegation.ts` is not in the platform, though platform `runtime/process-tree-kill.ts` documents it and AGR-4.3b's criteria say "cgroup checks pass".
3. Docs: ~9 docs are wholly platform, 6 are mixed, the rest stay (classification below). The agent repo has no docs/.

## Doc classification
Wholly platform (move): specialties.md, specialties-examples.md, specialties-sources.md (+ specialties.content.test.ts), github-multi-org.md, agent-api.md, agent-api-ops.md, agent-api-resources.md (carve out Phase Methodology and Work queue snapshot sections), anthropic-usage-by-agent.md (lowest confidence), self-serve.md (product-judgment call).
Mixed (split by section/row): agent-key-files.md (~96 platform rows, ~34 coding), agent.md, agent-ops.md, agent-web-ui.md, configuration-agent.md (~115 platform rows, ~45 coding by keyword pass; needs row-by-row review), observability.md.
Stay in shipwright: architecture, configuration, quickstart, testing, extending, README, chat, session-notifications, platform-manifest (pointer, AGR-4.4), and all task-store/metrics/MCP/deploy/helm/prompt-audit/consolidation/suppressions/migration/behind-branches docs (classified by title only).

## Docs sync design (decision: site pages stay in shipwright)
Option B, vendored snapshot: the platform-release bump PR (AGR-3.3 dispatch + AGR-4.1 receiver) also copies the tagged release's platform docs into a read-only snapshot directory in shipwright. site/docs-source-map.json points at snapshot paths; each snapshot file has a generated header linking its source in app-vitals/agent. docs-source-map.unit.test.ts and check-site-docs-freshness.ts work unchanged (paths exist on disk; git history carries the bumps). A guard blocks hand edits to the snapshot. Rejected: option A (cross-repo {repo,path} map + release-tag anchors via the compare API), a larger rewrite of the map, its test and the precheck.

## Tasks
| Task | Repo | Title | Depends on |
|---|---|---|---|
| PLD-1.1 | agent | feat: port the gh wrapper into the platform scripts/bin | - |
| PLD-1.2 | agent | ci: port verify-cgroup-delegation and its CI report step | - |
| PLD-1.3 | agent | docs: move the 9 platform docs and the specialties content test into docs/ | - |
| PLD-1.4 | agent | docs: split the 6 mixed docs and port their platform halves | PLD-1.3 |
| PLD-1.5 | agent | ci: add a platform config-docs check | PLD-1.4 |
| PLD-2.1 | shipwright | feat: vendor the platform docs snapshot on each platform release | PLD-1.4, AGR-4.1 |
| PLD-2.2 | shipwright | refactor: repoint the docs map, freshness and config-docs checks to the snapshot | PLD-2.1 |

PLD-1.4 absorbs the stale agent-key-files.md fixes (credential-helper row; nonexistent resolve-gh-owner.ts mention). Record edits made alongside this plan: AC bullets on AGR-5.1 and AGR-4.3b (gh and cgroup checks), AGR-4.4 depends on PLD-2.2, SGC-1.2 depends on PLD-1.1. Not done, recommended: AGR-5.1 depends on PLD-1.1 and PLD-1.2 so the candidate image contains them.

## Breaking Change Safety
PLD-1.1, 1.2, 1.5, 2.1 are additions. PLD-1.3 copies docs (originals stay in shipwright until PLD-2.2). PLD-2.2 removes the moved originals only after PLD-2.1 vendors them, retargeting the three binding checks in the same PR (atomic). Safe to deploy standalone: yes, in dependency order.
