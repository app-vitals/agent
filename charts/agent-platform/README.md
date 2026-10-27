# agent-platform

Library chart holding the Helm templates shared by agent platform deployments.
It renders nothing on its own; consumers add it as a dependency:

```yaml
dependencies:
  - name: agent-platform
    version: 0.3.0
    repository: https://app-vitals.github.io/agent
```

## Versioning

`version` in `Chart.yaml` is tied to the platform release. Bump it to the
release's `X.Y.Z` when a release changes the shared templates; merging the bump
to `main` publishes it via `.github/workflows/chart-release.yml`, which then sends a
`chart-release` dispatch (carrying the chart version) to `app-vitals/shipwright`
so it can bump its library dependency.

## Helpers

Named templates, all under the `agent-platform.` namespace. They read the
consuming chart's `.Values`, `.Release` and `.Chart`, so the values keys and
release-derived names are whatever the consumer defines.

- Core: `fullname`, `name`, `chart`, `labels`, `selectorLabels`, `podLabels`,
  `serviceAccountName`, `imageRef`
- Admin: `admin.fullname`, `admin.selectorLabels`, `admin.labels`,
  `admin.serviceAccountName`, `admin.secretName`
- Agent: `agent.fullname`, `agent.labels`, `agent.serviceAccountName`
- Whisper: `whisper.fullname`, `whisper.selectorLabels`, `whisper.labels`,
  `whisper.serviceUrl`
- Voice: `voice.secretName`
- Support: `publicHost`, `publicScheme`, `admin.appBaseUrl`, `postgresql.fullname`,
  `postgresql.password`, `postgresql.dsn`, `cloudSqlProxy.container`,
  `chat.fullname`, `chat.secretName`, `chat.adminTokenSecretName`,
  `chat.adminTokenSecretKey`, `agent.claudePolicy.configMapName`,
  `agent.claudePolicy.json`, `validate.claudePolicy`, `validate.anthropicFederation`

## Manifests

Whole-object templates the consumer includes from a one-line stub file
(e.g. `templates/admin-deployment.yaml` containing
`{{ include "agent-platform.admin.deployment" . }}`), so every rendered name,
label and annotation is unchanged:

- Admin: `admin.deployment`, `admin.service`, `admin.secret`,
  `admin.serviceaccount`, `admin.pdb`
- Agent provisioning: `agent.serviceaccount`, `agent.provisioningRbac`,
  `agent.claudePolicyConfigMap`

They read the consumer's `.Values` (`admin`, `auth`, `agent`, `postgresql`,
`externalDatabase`, `cloudSqlProxy`, `chat`, `networking`, `selfServe`, ...), so
the consumer's values file must define those keys.

## Tests

A library chart cannot render itself, so the helpers are tested through a
minimal consumer chart in `tests/fixtures/consumer` (a stub per manifest plus a
shipwright-shaped `values.yaml`; the `admin_*` / `agent_*` suites run against it), using the
[helm-unittest](https://github.com/helm-unittest/helm-unittest) plugin:

```bash
helm plugin install https://github.com/helm-unittest/helm-unittest
helm dependency build charts/agent-platform/tests/fixtures/consumer
helm unittest charts/agent-platform/tests/fixtures/consumer
```

CI runs the same steps in `.github/workflows/chart-release.yml`.
