# Plan: agent-github-card

Repo: app-vitals/agent. Approved by Dan.

## Goal
- Agent detail page: split the mislabeled "Slack access" card into a "Slack" card and a single "GitHub" card (connect actions + Preview access + GitHub sync + new Install-on-org action).
- Enterprise settings page (/admin/settings/github-enterprise): Organizations card becomes lookup-app installation only; all agent-specific install UI removed.

## Findings
- `slackAccessSection` (admin-ui-pages.ts) renders `connectActionsHtml` (Slack + GitHub connect buttons) above the Restrict-Slack form, in the Access tab.
- "Preview access" and "GitHub sync" are separate admin-only cards in `identitySection`, gated on `githubEnterpriseConfigured`. The sync card already lists installation repos; there is no separate Installations card.
- The settings page's per-row form is the only UI calling `POST /github-enterprise/orgs/{org}/install`.
- No API change: the install route and `GET /github-enterprise/orgs?agentId=` stay. Only the settings UI route is removed.
- `AGENT_POST_SECTIONS` must gain an entry for every new POST route (unit test enforces).

## Design
1. GHC-1.1: split cards. Slack card = Connect Slack + Restrict form. GitHub card = Set up App / Use existing App / Add PAT + Preview access + GitHub sync fragments (ids/scripts unchanged). Existing gating kept.
2. GHC-1.2: lazy-loaded fragment `GET /admin/agents/:id/github-orgs` (calls `/github-enterprise/orgs?agentId=`), `POST /admin/agents/:id/github-orgs/:org/install` (agent implicit, redirect to Access with banner). Show `agentAppReason` up front, disable Install when set. Hidden unless installer App configured and viewer is platform admin.
3. GHC-2.1: strip agent parts from the enterprise Organizations card and remove the settings install UI route.

## Tasks
| Task | Title | Depends on | Layer | Model |
|------|-------|------------|-------|-------|
| GHC-1.1 | refactor: split agent Slack and GitHub cards | — | Frontend | sonnet |
| GHC-1.2 | feat: add install-on-org action to agent GitHub card | GHC-1.1 | Frontend | sonnet |
| GHC-2.1 | refactor: make enterprise orgs card lookup-app only | GHC-1.2 | Frontend | haiku |

```
[START]
  └─ GHC-1.1
        └─ GHC-1.2
              └─ GHC-2.1
```

Breaking Change Safety: add (1.2) before remove (2.1), so a UI path to install an agent App always exists. Safe to deploy standalone: yes for each task.

HITL scan: no tasks require human steps.

## Decision Log
- GitHub username row: left in "Owner & identities" (identity field, not App setting).
- Install block: lazy-loaded fragment, so a slow GitHub call cannot slow the Access tab.
- Slack card title: "Slack" instead of "Slack access".
