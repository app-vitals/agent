{{/*
ServiceAccount that provisioned agent pods run as.
*/}}
{{- define "agent-platform.agent.serviceaccount" -}}
{{- if and .Values.agent.provisioning.enabled .Values.agent.provisioning.serviceAccount.create }}
# ServiceAccount that PROVISIONED agent pods run as (HD-4.2). Separate from the
# admin ServiceAccount: the admin SA holds the agent-provisioning RBAC (create
# Deployments/Secrets), while this SA is the identity the agent workloads
# themselves assume. Gated on agent.provisioning.enabled + a create flag.
# Lives in the agent namespace (agent.provisioning.namespace when set, else the
# release namespace): provisioned pods are created there and Kubernetes refuses
# to schedule a pod whose serviceAccountName is missing from its own namespace.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "agent-platform.agent.serviceAccountName" . }}
  namespace: {{ .Values.agent.provisioning.namespace | default .Release.Namespace | quote }}
  labels:
    {{- include "agent-platform.agent.labels" . | nindent 4 }}
  {{- with .Values.agent.provisioning.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- end }}

{{/*
Agent-provisioning RBAC (Role/RoleBinding, or ClusterRole/ClusterRoleBinding when agent.provisioning.namespace is set).
*/}}
{{- define "agent-platform.agent.provisioningRbac" -}}
{{- if .Values.agent.provisioning.enabled }}
{{- if .Values.agent.provisioning.namespace }}
# Agent-provisioning RBAC (HD-4.2 / K8S-NS-1.1). Gated on agent.provisioning.enabled
# (default false → this file renders nothing and the admin service stays in Noop mode).
#
# Cross-namespace mode (agent.provisioning.namespace is set): ClusterRole + ClusterRoleBinding.
# The admin service provisions agent Deployments + Secrets + PVCs + ServiceAccounts into a
# namespace other than its own release namespace (e.g. provisioning agents into a dedicated
# target namespace).
# A ClusterRole bound via ClusterRoleBinding is required to reach across namespace boundaries.
# The verb set is exactly what the provisioner (HD-1.3 KubernetesAgentProvisioner /
# HD-1.4 wiring) exercises: create + get + list + patch + update + delete on
# Deployments (apps) — patch/update are required by the reconcile path, which
# strategic-merge-patches existing Deployments — and create + get + delete on
# Secrets (core), PersistentVolumeClaims (core) and ServiceAccounts (core).
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ include "agent-platform.admin.fullname" . }}-agent-provisioner
  labels:
    {{- include "agent-platform.admin.labels" . | nindent 4 }}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["create", "get", "list", "patch", "update", "delete"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["create", "get", "delete"]
---
# ClusterRoleBinding granting the admin ServiceAccount the ClusterRole above.
# The subject namespace scopes which SA is granted the cluster-wide permissions.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ include "agent-platform.admin.fullname" . }}-agent-provisioner
  labels:
    {{- include "agent-platform.admin.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ include "agent-platform.admin.fullname" . }}-agent-provisioner
subjects:
  - kind: ServiceAccount
    name: {{ include "agent-platform.admin.serviceAccountName" . }}
    namespace: {{ .Release.Namespace }}
{{- else }}
# Agent-provisioning RBAC (HD-4.2 / K8S-NS-1.1). Gated on agent.provisioning.enabled
# (default false → this file renders nothing and the admin service stays in Noop mode).
#
# Same-namespace mode (agent.provisioning.namespace is empty, the default): namespace-scoped
# Role + RoleBinding. The admin service provisions agent Deployments + Secrets + PVCs +
# ServiceAccounts into its own release namespace — no cross-namespace access is needed, so a
# namespace-scoped Role provides least-privilege RBAC.
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {{ include "agent-platform.admin.fullname" . }}-agent-provisioner
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.admin.labels" . | nindent 4 }}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["create", "get", "list", "patch", "update", "delete"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["persistentvolumeclaims"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["serviceaccounts"]
    verbs: ["create", "get", "delete"]
---
# RoleBinding granting the admin ServiceAccount the namespace-scoped Role above.
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {{ include "agent-platform.admin.fullname" . }}-agent-provisioner
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.admin.labels" . | nindent 4 }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: {{ include "agent-platform.admin.fullname" . }}-agent-provisioner
subjects:
  - kind: ServiceAccount
    name: {{ include "agent-platform.admin.serviceAccountName" . }}
    namespace: {{ .Release.Namespace }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Managed Claude Code policy ConfigMap for provisioned agent pods.
*/}}
{{- define "agent-platform.agent.claudePolicyConfigMap" -}}
{{- /*
Managed Claude Code policy for provisioned agent pods (ACP-2.1). Renders only
when agent.provisioning.claudePolicy.enabled. The admin provisioner mounts the
single key managed-settings.json at /etc/claude-code in agent pods (name and
hash are handed over via the admin Deployment env). Lives in the provisioning
namespace when set, else the release namespace.

agent-platform.validate.claudePolicy is included unconditionally so the guards fire
on every render of this file, even when the policy is disabled.
*/}}
{{- include "agent-platform.validate.claudePolicy" . }}
{{- if .Values.agent.provisioning.claudePolicy.enabled }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "agent-platform.agent.claudePolicy.configMapName" . }}
  namespace: {{ .Values.agent.provisioning.namespace | default .Release.Namespace | quote }}
  labels:
    {{- include "agent-platform.admin.labels" . | nindent 4 }}
data:
  managed-settings.json: |-
    {{- include "agent-platform.agent.claudePolicy.json" . | nindent 4 }}
{{- end }}
{{- end }}
