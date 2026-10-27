{{/*
cert-manager integration: helpers, the inline Certificate / (Cluster)Issuer, and
the bootstrap hook (ConfigMap + apply/cleanup Jobs + RBAC) used when cert-manager
is bundled in the same release.
*/}}

{{/*
agent-platform.certManager.issuerName — the (Cluster)Issuer name a rendered
Certificate/Ingress references. An explicit tls.certManager.issuerRef.name wins
(bring-your-own Issuer); else, with tls.certManager.issuer.create=true, the
chart-managed "<fullname>-issuer"; else "".
*/}}
{{- define "agent-platform.certManager.issuerName" -}}
{{- if .Values.tls.certManager.issuerRef.name -}}
{{- .Values.tls.certManager.issuerRef.name -}}
{{- else if .Values.tls.certManager.issuer.create -}}
{{- printf "%s-issuer" (include "agent-platform.fullname" .) -}}
{{- end -}}
{{- end }}

{{/*
agent-platform.certManager.issuerKind — issuerRef.kind for a bring-your-own
Issuer (issuerRef.name set), else issuer.kind (the kind the chart creates).
*/}}
{{- define "agent-platform.certManager.issuerKind" -}}
{{- if .Values.tls.certManager.issuerRef.name -}}
{{- .Values.tls.certManager.issuerRef.kind -}}
{{- else -}}
{{- .Values.tls.certManager.issuer.kind -}}
{{- end -}}
{{- end }}

{{/*
agent-platform.certManager.createIssuer — true when the chart renders its own
(Cluster)Issuer: tls.certManager.issuer.create=true AND no explicit
tls.certManager.issuerRef.name (which always means bring-your-own).
*/}}
{{- define "agent-platform.certManager.createIssuer" -}}
{{- if and .Values.tls.certManager.issuer.create (not .Values.tls.certManager.issuerRef.name) }}true{{- end }}
{{- end }}

{{/*
agent-platform.certManager.viaHook — true when the chart-managed
Issuer/Certificate must go through the bootstrap hook Job instead of inline
manifests: tls.certManager.enabled AND cert-manager is BUNDLED in this release
(cert-manager.enabled — its CRDs do not exist at first-install apply time) AND
there is an Issuer (issuer.create) and/or a gateway Certificate to apply.
*/}}
{{- define "agent-platform.certManager.viaHook" -}}
{{- if and .Values.tls.certManager.enabled (index .Values "cert-manager" "enabled") (or .Values.tls.certManager.issuer.create (eq .Values.networking.type "gateway")) }}true{{- end }}
{{- end }}

{{/*
agent-platform.certManager.subchartFullname — the fullname the BUNDLED
cert-manager subchart resolves to (its own cert-manager.fullname logic, honoring
the `cert-manager:` block's fullnameOverride/nameOverride), so the bootstrap
Job's `kubectl wait` targets the real Deployment names.
*/}}
{{- define "agent-platform.certManager.subchartFullname" -}}
{{- $cm := index .Values "cert-manager" | default dict -}}
{{- if $cm.fullnameOverride -}}
{{- $cm.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := $cm.nameOverride | default "cert-manager" -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
agent-platform.certManager.issuerManifest — the cert-manager.io/v1
(Cluster)Issuer body. issuer.type "selfsigned" -> spec.selfSigned: {};
"letsencrypt" (default) -> ACME with an HTTP-01 solver on the effective ingress
class. Only kind "Issuer" gets a metadata.namespace.
*/}}
{{- define "agent-platform.certManager.issuerManifest" -}}
apiVersion: cert-manager.io/v1
kind: {{ .Values.tls.certManager.issuer.kind }}
metadata:
  name: {{ include "agent-platform.certManager.issuerName" . }}
  {{- if eq .Values.tls.certManager.issuer.kind "Issuer" }}
  namespace: {{ .Release.Namespace }}
  {{- end }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
spec:
  {{- if eq .Values.tls.certManager.issuer.type "selfsigned" }}
  selfSigned: {}
  {{- else }}
  acme:
    email: {{ .Values.tls.certManager.issuer.email | quote }}
    server: {{ .Values.tls.certManager.issuer.server | default "https://acme-v02.api.letsencrypt.org/directory" | quote }}
    privateKeySecretRef:
      name: {{ include "agent-platform.certManager.issuerName" . }}-acme-account
    solvers:
      - http01:
          ingress:
            ingressClassName: {{ include "agent-platform.ingress.className" . }}
  {{- end }}
{{- end }}

{{/*
agent-platform.certManager.certificateManifest — the cert-manager.io/v1
Certificate body for the gateway host, written to the "<fullname>-tls" Secret
the Gateway's HTTPS listener references.
*/}}
{{- define "agent-platform.certManager.certificateManifest" -}}
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {{ include "agent-platform.fullname" . }}-tls
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
spec:
  # Secret cert-manager populates with the issued certificate + key.
  secretName: {{ include "agent-platform.fullname" . }}-tls
  dnsNames:
    - {{ .Values.networking.gateway.host | quote }}
  issuerRef:
    name: {{ include "agent-platform.certManager.issuerName" . | quote }}
    kind: {{ include "agent-platform.certManager.issuerKind" . }}
    group: cert-manager.io
{{- end }}

{{/*
agent-platform.certificate — the inline Certificate, rendered only when
tls.certManager.enabled AND networking.type=gateway AND NOT viaHook (with
cert-manager bundled, the bootstrap hook applies it instead).
*/}}
{{- define "agent-platform.certificate" -}}
{{- if and .Values.tls.certManager.enabled (eq .Values.networking.type "gateway") (not (include "agent-platform.certManager.viaHook" .)) }}
{{ include "agent-platform.certManager.certificateManifest" . }}
{{- end }}
{{- end }}

{{/*
agent-platform.certManagerIssuer — the inline chart-managed (Cluster)Issuer,
rendered only when tls.certManager.enabled AND createIssuer AND NOT viaHook.
Runs agent-platform.validate first.
*/}}
{{- define "agent-platform.certManagerIssuer" -}}
{{- if and .Values.tls.certManager.enabled (include "agent-platform.certManager.createIssuer" .) (not (include "agent-platform.certManager.viaHook" .)) }}
{{- include "agent-platform.validate" . }}
{{ include "agent-platform.certManager.issuerManifest" . }}
{{- end }}
{{- end }}

{{/*
agent-platform.certManagerBootstrapJob — cert-manager bootstrap hook, rendered
only when agent-platform.certManager.viaHook:
  1. ConfigMap <fullname>-cert-manager-bootstrap carrying 10-issuer.yaml (if
     createIssuer) and 20-certificate.yaml (if gateway), from the same
     issuerManifest / certificateManifest helpers the inline templates use.
  2. apply Job (post-install,post-upgrade, weight 10): waits for the bundled
     cert-manager Deployments, then `kubectl apply --server-side` the ConfigMap.
  3. cleanup Job (pre-delete; tls.certManager.bootstrap.cleanupOnDelete):
     deletes the applied CRs (the TLS and ACME account Secrets are kept).
The kubectl field manager is "<chart name>-chart".
*/}}
{{- define "agent-platform.certManagerBootstrapJob" -}}
{{- if include "agent-platform.certManager.viaHook" . }}
{{- $fullname := include "agent-platform.fullname" . }}
{{- $name := printf "%s-cert-manager-bootstrap" $fullname | trunc 63 | trimSuffix "-" }}
{{- $cmFullname := include "agent-platform.certManager.subchartFullname" . }}
{{- $createIssuer := include "agent-platform.certManager.createIssuer" . }}
{{- $gateway := eq .Values.networking.type "gateway" }}
{{- $image := include "agent-platform.imageRef" (dict "context" . "repository" "registry.k8s.io/kubectl" "tag" "v1.31.0") }}
{{- $b := .Values.tls.certManager.bootstrap }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-weight": "10"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
data:
  {{- if $createIssuer }}
  10-issuer.yaml: |
    {{- include "agent-platform.certManager.issuerManifest" . | nindent 4 }}
  {{- end }}
  {{- if $gateway }}
  20-certificate.yaml: |
    {{- include "agent-platform.certManager.certificateManifest" . | nindent 4 }}
  {{- end }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap
  annotations:
    "helm.sh/hook": post-install,post-upgrade
    "helm.sh/hook-weight": "10"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: {{ $b.backoffLimit }}
  activeDeadlineSeconds: {{ $b.activeDeadlineSeconds }}
  template:
    metadata:
      labels:
        {{- include "agent-platform.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: cert-manager-bootstrap
    spec:
      restartPolicy: OnFailure
      serviceAccountName: {{ $name }}
      {{- with .Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . }}
        {{- end }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
      initContainers:
        # Wait for the bundled cert-manager control plane — controller, webhook,
        # and cainjector — to be Available before applying the CRs. Until the
        # webhook is up, apply of a cert-manager.io/v1 resource is rejected.
        - name: wait-cert-manager
          image: {{ $image | quote }}
          command:
            - kubectl
          args:
            - wait
            - --for=condition=Available
            - --timeout=300s
            - deployment/{{ $cmFullname }}
            - deployment/{{ $cmFullname }}-webhook
            - deployment/{{ $cmFullname }}-cainjector
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
          {{- with $b.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      containers:
        - name: apply
          image: {{ $image | quote }}
          command:
            - kubectl
          args:
            - apply
            - --server-side
            - --field-manager={{ .Chart.Name }}-chart
            - --force-conflicts
            - -f
            - /manifests
          volumeMounts:
            - name: manifests
              mountPath: /manifests
              readOnly: true
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
          {{- with $b.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
      volumes:
        - name: manifests
          configMap:
            name: {{ $name }}
{{- if $b.cleanupOnDelete }}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ printf "%s-cleanup" $name | trunc 63 | trimSuffix "-" }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap-cleanup
  annotations:
    "helm.sh/hook": pre-delete
    "helm.sh/hook-weight": "10"
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
spec:
  backoffLimit: {{ $b.backoffLimit }}
  activeDeadlineSeconds: {{ $b.activeDeadlineSeconds }}
  template:
    metadata:
      labels:
        {{- include "agent-platform.selectorLabels" . | nindent 8 }}
        app.kubernetes.io/component: cert-manager-bootstrap-cleanup
    spec:
      restartPolicy: OnFailure
      serviceAccountName: {{ $name }}
      {{- with .Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . }}
        {{- end }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
      containers:
        - name: cleanup
          image: {{ $image | quote }}
          # Delete the CRs the apply Job created. --ignore-not-found so an
          # already-partly-removed release still exits 0. The issued TLS Secret
          # and the ACME account Secret are INTENTIONALLY not deleted — keeping
          # them avoids a fresh ACME order / re-issuance on the next install.
          command:
            - kubectl
          args:
            - delete
            - --ignore-not-found
            {{- if $gateway }}
            - certificate.cert-manager.io/{{ $fullname }}-tls
            {{- end }}
            {{- if $createIssuer }}
            {{- if eq .Values.tls.certManager.issuer.kind "ClusterIssuer" }}
            - clusterissuer.cert-manager.io/{{ include "agent-platform.certManager.issuerName" . }}
            {{- else }}
            - issuer.cert-manager.io/{{ include "agent-platform.certManager.issuerName" . }}
            {{- end }}
            {{- end }}
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
          {{- with $b.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
agent-platform.certManagerBootstrapRbac — RBAC for the bootstrap hook Jobs,
rendered only when viaHook. REGULAR (non-hook) resources, so the
ServiceAccount's UID — and its bound tokens — survive `helm upgrade`. The
namespaced Role always renders; the ClusterRole/Binding only when the chart
creates a ClusterIssuer.
*/}}
{{- define "agent-platform.certManagerBootstrapRbac" -}}
{{- if include "agent-platform.certManager.viaHook" . }}
{{- $name := printf "%s-cert-manager-bootstrap" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- $clusterScoped := and (include "agent-platform.certManager.createIssuer" .) (eq .Values.tls.certManager.issuer.kind "ClusterIssuer") }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["cert-manager.io"]
    resources: ["issuers", "certificates"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ $name }}
subjects:
  - kind: ServiceAccount
    name: {{ $name }}
    namespace: {{ .Release.Namespace }}
{{- if $clusterScoped }}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ $name }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap
rules:
  - apiGroups: ["cert-manager.io"]
    resources: ["clusterissuers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ $name }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
    app.kubernetes.io/component: cert-manager-bootstrap
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ $name }}
subjects:
  - kind: ServiceAccount
    name: {{ $name }}
    namespace: {{ .Release.Namespace }}
{{- end }}
{{- end }}
{{- end }}
