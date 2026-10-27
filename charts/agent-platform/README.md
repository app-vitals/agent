# agent-platform

Library chart holding the Helm templates shared by agent platform deployments.
It renders nothing on its own; consumers add it as a dependency:

```yaml
dependencies:
  - name: agent-platform
    version: 0.2.0
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

## Tests

A library chart cannot render itself, so the helpers are tested through a
minimal consumer chart in `tests/fixtures/consumer`, using the
[helm-unittest](https://github.com/helm-unittest/helm-unittest) plugin:

```bash
helm plugin install https://github.com/helm-unittest/helm-unittest
helm dependency build charts/agent-platform/tests/fixtures/consumer
helm unittest charts/agent-platform/tests/fixtures/consumer
```

CI runs the same steps in `.github/workflows/chart-release.yml`.
