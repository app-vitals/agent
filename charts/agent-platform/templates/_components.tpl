{{/*
Extension-list plumbing for the shared networking, database and NOTES templates.

The extensible templates (httproute, healthcheckpolicy, ingress,
ingressTraefikMiddleware, tenantNetworkPolicy, postgresql.initdbConfigMap,
notes) accept EITHER the root context:

  {{ include "agent-platform.httproute" . }}

which renders the platform-only set, OR a dict carrying the caller's
extension lists:

  {{ include "agent-platform.httproute" (dict "context" . "extensions" $ext) }}

$ext is a dict (usually built by the consumer from one of its own named
templates with `include "<consumer>.platformExtensions" . | fromYaml`) with any
of these keys — every key is optional, a missing or empty key renders nothing
extra:

  routes:               HTTP routes to a consumer Service, listed in match order
    - component: metrics          # required; name = "<fullname>-<component>"
      name: ""                    # optional explicit Service/route name
      pathPrefix: /dashboard      # required
      port: 3460                  # Service port (HTTPRoute backendRef)
      stripPrefix: false          # true: strip pathPrefix before the Service
  healthChecks:         GKE HealthCheckPolicies (networking.type=gateway)
    - component: metrics
      name: ""
      requestPath: /health        # default /health
  networkPolicyEgress:  extra in-namespace egress peers for the tenant policy
    - component: task-store       # selects "<selectorLabels> + component"
  databases:            extra per-service databases on the bundled PostgreSQL
    - file: 00-create-metrics-db.sql
      name: shipwright_metrics
  notes:                NOTES.txt additions
    productName: Shipwright Harness
    servicePorts:
      - name: metrics
        port: 3460
    sections:
      - "Metrics dashboard access:\n  ..."

Platform entries keep their fixed positions: routes and health checks render
before the admin catch-all, egress peers and databases between admin and chat,
NOTES ports/sections between admin and chat.
*/}}

{{/*
agent-platform.component.fullname — "<fullname>-<component>" for an
extension entry, or its explicit `name`.
Args: dict "context" <root> "entry" <entry dict>.
*/}}
{{- define "agent-platform.component.fullname" -}}
{{- .entry.name | default (printf "%s-%s" (include "agent-platform.fullname" .context) .entry.component | trunc 63 | trimSuffix "-") }}
{{- end }}

{{/*
agent-platform.component.labels — common labels plus the entry's component label.
Args: dict "context" <root> "entry" <entry dict>.
*/}}
{{- define "agent-platform.component.labels" -}}
{{ include "agent-platform.labels" .context }}
app.kubernetes.io/component: {{ .entry.component }}
{{- end }}

{{/*
agent-platform.component.selectorLabels — selector labels plus the entry's
component label.
Args: dict "context" <root> "entry" <entry dict>.
*/}}
{{- define "agent-platform.component.selectorLabels" -}}
{{ include "agent-platform.selectorLabels" .context }}
app.kubernetes.io/component: {{ .entry.component }}
{{- end }}
