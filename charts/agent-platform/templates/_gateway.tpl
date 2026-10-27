{{/*
agent-platform.gateway — the Gateway API Gateway (networking.type=gateway): an
HTTP :80 listener always, plus an HTTPS :443 listener terminating TLS with the
"<fullname>-tls" Secret when tls.certManager.enabled.
*/}}
{{- define "agent-platform.gateway" -}}
{{- if eq .Values.networking.type "gateway" }}
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: {{ include "agent-platform.fullname" . }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
  {{- with .Values.networking.gateway.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  gatewayClassName: {{ .Values.networking.gateway.gatewayClassName | quote }}
  listeners:
    # Plain HTTP listener on :80, always present so the gateway answers for the
    # configured host even without TLS (Minikube/dev = plain HTTP).
    - name: http
      protocol: HTTP
      port: 80
      hostname: {{ .Values.networking.gateway.host | quote }}
      allowedRoutes:
        namespaces:
          from: Same
    {{- if .Values.tls.certManager.enabled }}
    # HTTPS listener on :443, rendered only when cert-manager issues a cert. The
    # terminate-mode TLS references the Certificate's Secret
    # (agent-platform.certificate), whose name tracks the release fullname.
    - name: https
      protocol: HTTPS
      port: 443
      hostname: {{ .Values.networking.gateway.host | quote }}
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: {{ include "agent-platform.fullname" . }}-tls
      allowedRoutes:
        namespaces:
          from: Same
    {{- end }}
{{- end }}
{{- end }}

{{/*
agent-platform.httproute — Gateway API HTTPRoutes (networking.type=gateway).

Renders, in order: the HTTP->HTTPS redirect route (tls.certManager.enabled;
attaches to the "http" listener only), one HTTPRoute per extension `routes`
entry (see _components.tpl), and the admin "/" catch-all route. Gateway API
matches the most-specific path across attached routes, so a separate route per
prefix is equivalent to ordering rules within one route. With cert-manager on,
every backend route attaches to the "https" listener only (sectionName: https).
A `stripPrefix: true` route rewrites its prefix back to "/" (URLRewrite
ReplacePrefixMatch) before traffic reaches its Service.
*/}}
{{- define "agent-platform.httproute" -}}
{{- $ctx := . }}
{{- $ext := dict }}
{{- if hasKey . "context" }}
{{- $ctx = .context }}
{{- $ext = .extensions | default dict }}
{{- end }}
{{- with $ctx }}
{{- if eq .Values.networking.type "gateway" }}
{{- if .Values.tls.certManager.enabled }}
# HTTP→HTTPS redirect route. When cert-manager is enabled the Gateway has both
# an HTTP (:80) and HTTPS (:443) listener. Without this route, the backend
# HTTPRoutes below (attached by name only) are admitted on both ports, serving
# plaintext alongside TLS with no redirect. This route attaches specifically to
# the "http" listener (sectionName: http) and issues a 301 RequestRedirect to
# HTTPS — the GKE gke-l7-global-external-managed standard and best practice for
# any TLS-enabled Gateway deployment.
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ include "agent-platform.fullname" . }}-http-redirect
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
spec:
  parentRefs:
    - name: {{ include "agent-platform.fullname" . }}
      sectionName: http
  hostnames:
    - {{ .Values.networking.gateway.host | quote }}
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            statusCode: 301
---
{{- end }}
{{- range ($ext.routes | default list) }}
{{- $name := include "agent-platform.component.fullname" (dict "context" $ctx "entry" .) }}
# Extension route "{{ .component }}": its own HTTPRoute, so the pathPrefix routes
# to that Service ahead of the admin "/" catch-all.
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ $name }}
  labels:
    {{- include "agent-platform.component.labels" (dict "context" $ctx "entry" .) | nindent 4 }}
spec:
  parentRefs:
    - name: {{ include "agent-platform.fullname" $ctx }}
      {{- if $ctx.Values.tls.certManager.enabled }}
      sectionName: https
      {{- end }}
  hostnames:
    - {{ $ctx.Values.networking.gateway.host | quote }}
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: {{ .pathPrefix }}
      {{- if .stripPrefix }}
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplacePrefixMatch
              replacePrefixMatch: /
      {{- end }}
      backendRefs:
        - name: {{ $name }}
          port: {{ .port }}
---
{{- end }}
# Admin UI/API route. Everything not matched by a more-specific route above is
# routed to the admin Service at the root.
# When cert-manager is enabled this attaches to the "https" listener only
# (sectionName: https); plaintext traffic is handled by the redirect route above.
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ include "agent-platform.admin.fullname" . }}
  labels:
    {{- include "agent-platform.admin.labels" . | nindent 4 }}
spec:
  parentRefs:
    - name: {{ include "agent-platform.fullname" . }}
      {{- if .Values.tls.certManager.enabled }}
      sectionName: https
      {{- end }}
  hostnames:
    - {{ .Values.networking.gateway.host | quote }}
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: {{ include "agent-platform.admin.fullname" . }}
          port: {{ .Values.admin.service.port }}
{{- end }}
{{- end }}
{{- end }}

{{/*
agent-platform.healthCheckPolicy.body — one GKE HealthCheckPolicy document.
Args: dict "name" <Service name> "labels" <labels YAML> "requestPath" <path>.
*/}}
{{- define "agent-platform.healthCheckPolicy.body" -}}
apiVersion: networking.gke.io/v1
kind: HealthCheckPolicy
metadata:
  name: {{ .name }}
  labels:
    {{- .labels | nindent 4 }}
spec:
  default:
    checkIntervalSec: 15
    timeoutSec: 5
    healthyThreshold: 1
    unhealthyThreshold: 2
    config:
      type: HTTP
      httpHealthCheck:
        requestPath: {{ .requestPath }}
  targetRef:
    group: ""
    kind: Service
    name: {{ .name }}
{{- end }}

{{/*
agent-platform.healthcheckpolicy — GKE HealthCheckPolicies (networking.type=
gateway AND networking.gateway.healthCheckPolicy.enabled; opt-in). The GKE
Gateway controller default-probes "/", which the services answer with 404, and
marks the backend UNHEALTHY (503 on the external host); these policies steer the
probe to /health. Renders the admin policy, then one per extension
`healthChecks` entry (see _components.tpl). networking.gke.io/v1 is
GKE-specific — do not enable it on other Gateway controllers.
*/}}
{{- define "agent-platform.healthcheckpolicy" -}}
{{- $ctx := . }}
{{- $ext := dict }}
{{- if hasKey . "context" }}
{{- $ctx = .context }}
{{- $ext = .extensions | default dict }}
{{- end }}
{{- with $ctx }}
{{- if and (eq .Values.networking.type "gateway") .Values.networking.gateway.healthCheckPolicy.enabled }}
{{ include "agent-platform.healthCheckPolicy.body" (dict "name" (include "agent-platform.admin.fullname" .) "labels" (include "agent-platform.admin.labels" .) "requestPath" "/health") }}
{{- range ($ext.healthChecks | default list) }}
---
{{ include "agent-platform.healthCheckPolicy.body" (dict "name" (include "agent-platform.component.fullname" (dict "context" $ctx "entry" .)) "labels" (include "agent-platform.component.labels" (dict "context" $ctx "entry" .)) "requestPath" (.requestPath | default "/health")) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
agent-platform.securityGroupPolicy — AWS VPC CNI SecurityGroupPolicy, opt-in
(awsSecurityGroupPolicy.enabled). podSelector.matchLabels defaults to the
release's selector labels (every pod the consumer renders with them).
*/}}
{{- define "agent-platform.securityGroupPolicy" -}}
{{- if .Values.awsSecurityGroupPolicy.enabled }}
apiVersion: vpcresources.k8s.aws/v1beta1
kind: SecurityGroupPolicy
metadata:
  name: {{ default (include "agent-platform.fullname" .) .Values.awsSecurityGroupPolicy.nameOverride }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    {{- with .Values.awsSecurityGroupPolicy.extraLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  podSelector:
    matchLabels:
      {{- with .Values.awsSecurityGroupPolicy.podSelector.matchLabels }}
      {{- toYaml . | nindent 6 }}
      {{- else }}
      {{- include "agent-platform.selectorLabels" . | nindent 6 }}
      {{- end }}
  securityGroups:
    groupIds:
      {{- toYaml .Values.awsSecurityGroupPolicy.groupIds | nindent 6 }}
{{- end }}
{{- end }}

{{/*
agent-platform.tenantNetworkPolicy — tenant agent NetworkPolicy, opt-in
(selfServe.networkPolicy.enabled). Selects the self-serve tenant agent pods
(label shipwright.dev/tenant=true) in the agent namespace
(agent.provisioning.namespace, else the release namespace).

Ingress: only from the admin pods. Egress: cluster DNS (kube-dns plus the
selfServe.networkPolicy.dnsCidrs node-local resolvers), the admin pods, one
in-namespace peer per extension `networkPolicyEgress` entry (see
_components.tpl), the chat pods, and the public internet minus RFC1918 and
link-local ranges.
*/}}
{{- define "agent-platform.tenantNetworkPolicy" -}}
{{- $ctx := . }}
{{- $ext := dict }}
{{- if hasKey . "context" }}
{{- $ctx = .context }}
{{- $ext = .extensions | default dict }}
{{- end }}
{{- with $ctx }}
{{- if .Values.selfServe.networkPolicy.enabled }}
{{- $peers := list (include "agent-platform.admin.selectorLabels" .) }}
{{- range ($ext.networkPolicyEgress | default list) }}
{{- $peers = append $peers (include "agent-platform.component.selectorLabels" (dict "context" $ctx "entry" .)) }}
{{- end }}
{{- $peers = append $peers (include "agent-platform.chat.selectorLabels" .) }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "agent-platform.fullname" . }}-tenant
  namespace: {{ default .Release.Namespace .Values.agent.provisioning.namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      shipwright.dev/tenant: "true"
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ .Release.Namespace }}
          podSelector:
            matchLabels:
              {{- include "agent-platform.admin.selectorLabels" . | nindent 14 }}
  egress:
    # Cluster DNS (kube-dns / CoreDNS).
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    {{- with .Values.selfServe.networkPolicy.dnsCidrs }}
    # Node-local DNS resolver (e.g. GKE NodeLocal DNSCache at 169.254.20.10).
    # Link-local, so the 169.254.0.0/16 exclusion below would otherwise drop it.
    - to:
        {{- range . }}
        - ipBlock:
            cidr: {{ . | quote }}
        {{- end }}
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    {{- end }}
    # In-namespace services: admin, extension peers, chat.
    {{- range $selectors := $peers }}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ $ctx.Release.Namespace }}
          podSelector:
            matchLabels:
              {{- $selectors | nindent 14 }}
    {{- end }}
    # Public internet only: no other pods, nodes, metadata service or API server.
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 10.0.0.0/8
              - 172.16.0.0/12
              - 192.168.0.0/16
              - 169.254.0.0/16
{{- end }}
{{- end }}
{{- end }}
