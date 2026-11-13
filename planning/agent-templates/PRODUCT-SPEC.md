# Product Spec: agent-templates — default agent configuration for a deployment

Session: `agent-templates` · Requested by Dan McAulay · Repo: `app-vitals/agent` (platform admin)

## Problem
Every agent is configured one by one. Specialty defaults (tools, plugins, crons) are copied once at creation and
never updated; env vars have no defaults beyond `ANTHROPIC_MODEL`. Operators who want every agent in a deployment to
carry the same setting (for example the Sentry DSN for the Vitals OS deployment) must set it on each agent by hand,
and a later change never reaches existing agents.

## Goal
An operator defines a **template** in the admin Settings nav. Every agent gets the template configuration by default
at provisioning. When the template changes, agents that still follow it are reconciled. An agent that has been
configured differently keeps its own configuration.

## Requirements
1. Templates cover env vars (with the `secret` flag, encrypted at rest), allowed tools, plugins and crons.
2. Templates are scoped by account and by agent type (specialty). Both are optional; null means "applies to all".
   Resolution merges by key, most specific scope winning: built-in specialty defaults, deployment-wide all types,
   deployment-wide one type, account all types, account one type.
3. The template is the default at provisioning (`POST /agents` and the web form). Anything set explicitly at
   provisioning overrides the template for that key and is never reconciled over.
4. Provisioning can opt out of the template entirely; the agent then keeps only the built-in specialty defaults.
5. Per-item override tracking: each env/tool/plugin/cron row is marked `template` or `custom`. Any admin write marks
   the row `custom`. Reconcile only touches `template` rows. Deleting an inherited row leaves a tombstone so it is
   not re-added.
6. An agent can be detached from templates (`templateDetached`) and re-attached; an inherited row can be reset to
   the template value.
7. Per-agent credentials (Slack tokens, `GH_TOKEN`, Anthropic credentials, task-store URL/token) can never be
   templated.
8. Template changes propagate to following agents; agents also reconcile at boot.

## Out of scope (v1)
Policy columns and phase methodology (coding-owned), named/multiple templates per scope, per-field override tracking
on `Agent` scalars, read-time inheritance.

## Success criteria
- A new agent provisioned in an account with a template starts with the merged template config and receives its env
  within the next 60s config sync.
- Editing a template changes `template`-sourced rows on following agents and leaves `custom` rows untouched.
- Opting out at provisioning, or detaching later, stops all template writes to that agent.
