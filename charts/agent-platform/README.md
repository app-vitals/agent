# agent-platform

Library chart holding the Helm templates shared by agent platform deployments.
It renders nothing on its own; consumers add it as a dependency:

```yaml
dependencies:
  - name: agent-platform
    version: 0.4.0
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
- Chat: `chat.fullname`, `chat.selectorLabels`, `chat.labels`,
  `chat.serviceAccountName`, `chat.secretName`, `chat.adminTokenSecretName`,
  `chat.adminTokenSecretKey`, `chat.databaseName`, `chat.useBundledDatabase`
- Database: `postgresql.fullname`, `postgresql.password`, `postgresql.dsn`,
  `cloudSqlProxy.container`
- Database: `postgresql.initdbConfigMapName` (legacy `<release>-metrics-initdb`)
- Ingress: `bundled.nginx`, `bundled.traefik`, `bundledIngressClass`,
  `ingress.className`, `ingress.controller`, `ingress.tlsEnabled`,
  `ingress.tlsSecretName`
- cert-manager: `certManager.issuerName`, `certManager.issuerKind`,
  `certManager.createIssuer`, `certManager.viaHook`,
  `certManager.subchartFullname`, `certManager.issuerManifest`,
  `certManager.certificateManifest`
- Extension entries: `component.fullname`, `component.labels`,
  `component.selectorLabels` (see [Extension lists](#extension-lists))
- Support: `publicHost`, `publicScheme`, `admin.appBaseUrl`,
  `agent.claudePolicy.configMapName`, `agent.claudePolicy.json`,
  `validate`, `validate.claudePolicy`, `validate.anthropicFederation`

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

## Workload templates

Each of these renders one complete manifest (or nothing when its own guard is
off). A consumer calls it from a one-line file under its own `templates/`, e.g.
`{{ include "agent-platform.chat.deployment" . }}` in `chat-deployment.yaml`:

- Chat (`chat.enabled`): `chat.deployment`, `chat.service`, `chat.secret`,
  `chat.serviceaccount`, `chat.pdb`
- Whisper (`agent.voice.enabled`, provider `whisper`): `whisper.deployment`,
  `whisper.service`
- Voice (`agent.voice.enabled`): `voice.secret`

They read the consumer's `chat.*`, `agent.voice.*`, `cloudSqlProxy.*`,
`postgresql.*`, `global.*` and `imagePullPolicy` values, and render the same
names as the shipwright chart they were ported from.

## Networking, database and NOTES templates

Same one-line-stub pattern; each renders nothing when its own guard is off:

- Gateway API (`networking.type=gateway`): `gateway`, `httproute`*,
  `healthcheckpolicy`* (`networking.gateway.healthCheckPolicy.enabled`)
- Ingress (`networking.type=ingress`): `ingress`*, `ingressHttpRedirect`,
  `ingressTraefikMiddleware`* (traefik only)
- cert-manager: `certificate`, `certManagerIssuer`, `certManagerBootstrapJob`,
  `certManagerBootstrapRbac`
- Policy: `tenantNetworkPolicy`* (`selfServe.networkPolicy.enabled`),
  `securityGroupPolicy` (`awsSecurityGroupPolicy.enabled`)
- Bundled PostgreSQL: `postgresql.initdbConfigMap`*, `postgresql.dbBootstrapJob`
- `notes`* — the whole NOTES.txt body; also runs `agent-platform.validate`

They read the consumer's `networking.*`, `tls.*`, `selfServe.*`,
`awsSecurityGroupPolicy.*`, `postgresql.*`, `dbBootstrap.*`, `cert-manager`,
`ingress-nginx`, `traefik`, `admin.*`, `chat.*`, `auth.*` and `agent.*` values.

## Extension lists

The templates marked * above interleave platform services (admin, chat) with
whatever services the consumer adds. The library owns the mechanism; the
consumer passes its own entries as a dict argument (not via `.Values`, because
entries depend on the consumer's own conditions such as `metrics.enabled`):

```yaml
# templates/httproute.yaml (same shape for every * template)
{{ include "agent-platform.httproute" (dict "context" . "extensions" (include "shipwright.platformExtensions" . | fromYaml)) }}
```

where the consumer's named template renders YAML with any of these keys (all
optional; called with the bare root context, `{{ include "agent-platform.httproute" . }}`,
a template renders the platform-only set):

```yaml
routes:              # HTTPRoute per entry + Ingress path, ahead of the admin "/" catch-all
  - component: task-store   # Service/route name "<fullname>-<component>", component label
    name: ""                # optional explicit name
    pathPrefix: /task-store
    port: 3000              # Service port for the HTTPRoute backendRef (Ingress uses port name "http")
    stripPrefix: true       # strip the prefix: URLRewrite / nginx rewrite-target / traefik StripPrefix
healthChecks:        # GKE HealthCheckPolicy per entry, after admin's
  - component: metrics
    requestPath: /health    # default
networkPolicyEgress: # tenant NetworkPolicy egress peer (same namespace), between admin and chat
  - component: task-store
databases:           # bundled-PostgreSQL CREATE DATABASE script, before chat's 02-create-chat-db.sql
  - file: 00-create-metrics-db.sql
    name: shipwright_metrics
notes:
  productName: Shipwright Harness   # banner: "Thank you for installing <chart> (<productName>)"
  servicePorts:                     # "Configured service ports" lines, between admin and chat
    - name: metrics
      port: 3460
  sections:                         # free-text blocks, between admin and chat access
    - "Metrics dashboard access:\n  ..."
```

`tests/fixtures/consumer/templates/_platform_extensions.tpl` is Shipwright's
list (metrics and task-store); with it the fixture renders the same objects as
the shipwright chart.

## Tests

A library chart cannot render itself, so the helpers are tested through a
minimal consumer chart in `tests/fixtures/consumer` (a stub per manifest plus a
shipwright-shaped `values.yaml`; the workload, networking, cert-manager, database,
validation and `extensions_*` suites run against it, the last driving the
extension lists through test-only `fixture.*` values), using the
[helm-unittest](https://github.com/helm-unittest/helm-unittest) plugin:

```bash
helm plugin install https://github.com/helm-unittest/helm-unittest
helm dependency build charts/agent-platform/tests/fixtures/consumer
helm unittest charts/agent-platform/tests/fixtures/consumer
```

CI runs the same steps in `.github/workflows/chart-release.yml`.
