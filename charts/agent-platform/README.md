# agent-platform

Library chart holding the Helm templates shared by agent platform deployments.
It renders nothing on its own; consumers add it as a dependency:

```yaml
dependencies:
  - name: agent-platform
    version: 0.1.0
    repository: https://app-vitals.github.io/agent
```

## Versioning

`version` in `Chart.yaml` is tied to the platform release. Bump it to the
release's `X.Y.Z` when a release changes the shared templates; merging the bump
to `main` publishes it via `.github/workflows/chart-release.yml`, which then sends a
`chart-release` dispatch (carrying the chart version) to `app-vitals/shipwright`
so it can bump its library dependency.
