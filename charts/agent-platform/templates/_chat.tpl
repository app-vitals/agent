{{/*
Chat workload manifests. Each named template renders one complete manifest (or
nothing, when its own guard is off); a consumer calls it from a one-line
templates/*.yaml, e.g. `{{ include "agent-platform.chat.deployment" . }}`.
Rendered names, labels and selectors are identical to the shipwright chart that
these were ported from.
*/}}
{{/*
Chat component fullname: "<fullname>-chat".
*/}}
{{- define "agent-platform.chat.fullname" -}}
{{- printf "%s-chat" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Chat selector labels — fullname selector labels plus the component label.
*/}}
{{- define "agent-platform.chat.selectorLabels" -}}
{{ include "agent-platform.selectorLabels" . }}
app.kubernetes.io/component: chat
{{- end }}

{{/*
Chat labels — common labels plus the component label.
*/}}
{{- define "agent-platform.chat.labels" -}}
{{ include "agent-platform.labels" . }}
app.kubernetes.io/component: chat
{{- end }}

{{/*
Chat ServiceAccount name.
*/}}
{{- define "agent-platform.chat.serviceAccountName" -}}
{{- if .Values.chat.serviceAccount.create }}
{{- default (include "agent-platform.chat.fullname" .) .Values.chat.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.chat.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the chart-managed chat Secret (holds the assembled
DATABASE_URL_SHIPWRIGHT_CHAT on the bundled-PostgreSQL path).
*/}}
{{- define "agent-platform.chat.secretName" -}}
{{- printf "%s-chat" (include "agent-platform.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of the Secret holding the raw chat admin token, or "" when chat is
disabled. Prefers a caller-supplied chat.adminToken.existingSecret; otherwise
the chart manages the token itself in its own chat Secret (see
chat-secret.yaml). Both the chat container (CHAT_SEED_ADMIN_TOKEN) and the
admin container (SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN) resolve through this so
the two always read the same value — that shared value is what makes the admin
console's Chat tab work without a hand-created Secret.
*/}}
{{- define "agent-platform.chat.adminTokenSecretName" -}}
{{- if .Values.chat.enabled }}{{- .Values.chat.adminToken.existingSecret | default (include "agent-platform.chat.secretName" .) }}{{- end }}
{{- end }}

{{/*
Key within the chat admin-token Secret. One expression shared by the chart-managed
Secret and both consumers, so a custom chat.adminToken.key stays consistent.
*/}}
{{- define "agent-platform.chat.adminTokenSecretKey" -}}
{{- .Values.chat.adminToken.key | default "SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN" }}
{{- end }}

{{/*
Chat database name: a SEPARATE database from admin, metrics and task-store
(default "shipwright_chat"). Each Prisma service must own its own database.
*/}}
{{- define "agent-platform.chat.databaseName" -}}
{{- default "shipwright_chat" .Values.chat.database.name }}
{{- end }}

{{/*
Whether chat uses the chart-managed bundled-PostgreSQL database. Mirrors
agent-platform.taskStore.useBundledDatabase — see there for the opt-in rationale.
*/}}
{{- define "agent-platform.chat.useBundledDatabase" -}}
{{- if and (not .Values.chat.database.existingSecret) .Values.postgresql.enabled }}true{{- end }}
{{- end }}

{{/*
Chat Deployment (chat.enabled).
*/}}
{{- define "agent-platform.chat.deployment" -}}
{{- if .Values.chat.enabled }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "agent-platform.chat.fullname" . }}
  labels:
    {{- include "agent-platform.chat.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.chat.replicas | default 1 }}
  selector:
    matchLabels:
      {{- include "agent-platform.chat.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      {{- $selectorLabels := include "agent-platform.chat.selectorLabels" . }}
      labels:
        {{- $selectorLabels | nindent 8 }}
        {{- with (include "agent-platform.podLabels" (dict "podLabels" .Values.chat.podLabels "selectorLabels" $selectorLabels)) }}
        {{- . | nindent 8 }}
        {{- end }}
      {{- with .Values.chat.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      serviceAccountName: {{ include "agent-platform.chat.serviceAccountName" . }}
      {{- with .Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . }}
        {{- end }}
      {{- end }}
      {{- if or (include "agent-platform.chat.useBundledDatabase" .) (and .Values.cloudSqlProxy.enabled .Values.cloudSqlProxy.nativeSidecar) }}
      initContainers:
      {{- if include "agent-platform.chat.useBundledDatabase" . }}
      # Only on the bundled-PostgreSQL path — an external database is the
      # operator's to make reachable, and blocking on it here would be wrong.
        - name: wait-for-postgres
          image: busybox:1.36
          command: ['sh', '-c', 'until nc -z {{ include "agent-platform.postgresql.fullname" . }} 5432; do echo "waiting for postgresql..."; sleep 2; done']
      {{- end }}
      {{- if and .Values.cloudSqlProxy.enabled .Values.cloudSqlProxy.nativeSidecar }}
        {{- include "agent-platform.cloudSqlProxy.container" (dict "context" $ "nativeSidecar" true) | nindent 8 }}
      {{- end }}
      {{- end }}
      containers:
        - name: chat
          image: {{ include "agent-platform.imageRef" (dict "context" $ "repository" .Values.chat.image.repository "tag" (.Values.chat.image.tag | default .Chart.AppVersion)) | quote }}
          imagePullPolicy: {{ .Values.chat.image.pullPolicy | default .Values.imagePullPolicy }}
          ports:
            - name: http
              containerPort: 3000
              protocol: TCP
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 15
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          env:
            {{- if .Values.chat.database.existingSecret }}
            # Bring-your-own Secret (the default, "shipwright-secrets"). The chart
            # neither creates nor owns it — create it before deploying.
            - name: DATABASE_URL_SHIPWRIGHT_CHAT
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.chat.database.existingSecret }}
                  key: DATABASE_URL_SHIPWRIGHT_CHAT
            {{- else if .Values.postgresql.enabled }}
            # Chart-managed bundled-PostgreSQL path: the DSN is assembled in
            # chat-secret.yaml so the password stays out of plaintext env.
            - name: DATABASE_URL_SHIPWRIGHT_CHAT
              valueFrom:
                secretKeyRef:
                  name: {{ include "agent-platform.chat.secretName" . }}
                  key: DATABASE_URL_SHIPWRIGHT_CHAT
            {{- else }}
            {{- fail "chat.database.existingSecret is required when postgresql.enabled=false" }}
            {{- end }}
            {{- with (include "agent-platform.chat.adminTokenSecretName" .) }}
            # Seed the admin token (stored hashed) at boot so the admin console
            # can authenticate without manual token minting. Idempotent upsert —
            # the same raw value is injected into the admin Deployment as
            # SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN. Sourced from the caller's
            # chat.adminToken.existingSecret when set, otherwise from the
            # chart-managed chat Secret.
            - name: CHAT_SEED_ADMIN_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ . }}
                  key: {{ include "agent-platform.chat.adminTokenSecretKey" $ }}
            {{- end }}
            {{- with .Values.chat.extraEnv }}
            # chat.extraEnv: caller-supplied env vars appended last so they can
            # override anything above if needed.
            {{- toYaml . | nindent 12 }}
            {{- end }}
          {{- with .Values.chat.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
        {{- if and .Values.cloudSqlProxy.enabled (not .Values.cloudSqlProxy.nativeSidecar) }}
        {{- include "agent-platform.cloudSqlProxy.container" (dict "context" $ "nativeSidecar" false) | nindent 8 }}
        {{- end }}
{{- end }}
{{- end }}

{{/*
Chat Service (chat.enabled). Its name is reached by vitals-os through an ExternalName alias — keep it stable.
*/}}
{{- define "agent-platform.chat.service" -}}
{{- if .Values.chat.enabled }}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "agent-platform.chat.fullname" . }}
  labels:
    {{- include "agent-platform.chat.labels" . | nindent 4 }}
spec:
  type: {{ .Values.chat.service.type | default "ClusterIP" }}
  ports:
    - name: http
      port: {{ .Values.chat.service.port }}
      targetPort: 3000
      protocol: TCP
  selector:
    {{- include "agent-platform.chat.selectorLabels" . | nindent 4 }}
{{- end }}
{{- end }}

{{/*
Chart-managed chat Secret (bundled-PostgreSQL DSN and/or generated admin token).
*/}}
{{- define "agent-platform.chat.secret" -}}
{{- $bundledDb := include "agent-platform.chat.useBundledDatabase" . }}
{{- $manageToken := and .Values.chat.enabled (not .Values.chat.adminToken.existingSecret) }}
{{- if and .Values.chat.enabled (or $bundledDb $manageToken) }}
{{- /*
  Chart-managed chat Secret. Holds two independent things, each rendered only
  when the chart is responsible for it:

    DATABASE_URL_SHIPWRIGHT_CHAT  — bundled-PostgreSQL path only. Mirrors
      task-store-secret.yaml exactly; see that file for the full rationale
      (opt-in gating, why the DSN lives in a Secret rather than plaintext env,
      and why no lookup-persistence idiom is needed for a deterministically-
      derived value).

    the chat admin token — generated unless the caller supplied
      chat.adminToken.existingSecret. Both the chat service (which seeds it at
      boot via CHAT_SEED_ADMIN_TOKEN) and the admin console (which calls chat
      with it) read this one key, so the Chat tab works with no hand-created
      Secret. Unlike the DSN this value is NOT derivable, so it uses the same
      lookup-persistence idiom as admin-secret.yaml: reuse the value already in
      the cluster, generate only when absent. Without that, every `helm upgrade`
      would mint a new token and desynchronize the two Deployments.

      `helm template` and helm-unittest cannot execute `lookup`, so they always
      take the generate branch — expected, and the same caveat admin-secret.yaml
      documents.
*/}}
{{- $secretName := include "agent-platform.chat.secretName" . }}
{{- $tokenKey := include "agent-platform.chat.adminTokenSecretKey" . }}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace $secretName) }}
{{- $adminToken := "" }}
{{- if and $existing $existing.data (index $existing.data $tokenKey) }}
{{- $adminToken = index $existing.data $tokenKey }}
{{- else }}
{{- $adminToken = (randAlphaNum 32 | b64enc) }}
{{- end }}
apiVersion: v1
kind: Secret
metadata:
  name: {{ $secretName }}
  labels:
    {{- include "agent-platform.chat.labels" . | nindent 4 }}
type: Opaque
data:
  {{- if $bundledDb }}
  {{- $dbUrl := include "agent-platform.postgresql.dsn" (dict "context" . "database" (include "agent-platform.chat.databaseName" .)) }}
  DATABASE_URL_SHIPWRIGHT_CHAT: {{ $dbUrl | b64enc | quote }}
  {{- end }}
  {{- if $manageToken }}
  # Generated on first install, reused on upgrade via the lookup idiom above.
  {{ $tokenKey }}: {{ $adminToken | quote }}
  {{- end }}
{{- end }}
{{- end }}

{{/*
Chat ServiceAccount (chat.enabled and chat.serviceAccount.create).
*/}}
{{- define "agent-platform.chat.serviceaccount" -}}
{{- if and .Values.chat.enabled .Values.chat.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "agent-platform.chat.serviceAccountName" . }}
  labels:
    {{- include "agent-platform.chat.labels" . | nindent 4 }}
  {{- with .Values.chat.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- end }}

{{/*
Chat PodDisruptionBudget (chat.enabled and chat.podDisruptionBudget.enabled).
*/}}
{{- define "agent-platform.chat.pdb" -}}
{{- if and .Values.chat.enabled .Values.chat.podDisruptionBudget.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "agent-platform.chat.fullname" . }}
  labels:
    {{- include "agent-platform.chat.labels" . | nindent 4 }}
spec:
  minAvailable: {{ .Values.chat.podDisruptionBudget.minAvailable }}
  selector:
    matchLabels:
      {{- include "agent-platform.chat.selectorLabels" . | nindent 6 }}
{{- end }}
{{- end }}
