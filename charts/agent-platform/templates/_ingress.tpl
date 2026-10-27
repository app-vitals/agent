{{/*
Ingress controller helpers. "Bundled" does NOT mean a subchart here — it means
one of the two controller flavors (networking.ingress.controller) this library
understands and renders controller-specific config for: "nginx" (the default,
nginx.ingress.kubernetes.io/* annotations) and "traefik" (Traefik entrypoints
and Middleware CRs). agent-platform.validate cross-checks the selection against
className/entrypoints for contradictions.
*/}}

{{/*
agent-platform.bundled.nginx — true when networking.ingress.controller=nginx.
*/}}
{{- define "agent-platform.bundled.nginx" -}}
{{- if eq .Values.networking.ingress.controller "nginx" }}true{{- end }}
{{- end }}

{{/*
agent-platform.bundled.traefik — true when networking.ingress.controller=traefik.
*/}}
{{- define "agent-platform.bundled.traefik" -}}
{{- if eq .Values.networking.ingress.controller "traefik" }}true{{- end }}
{{- end }}

{{/*
agent-platform.bundledIngressClass — the conventional IngressClass name for the
DECLARED networking.ingress.controller ("nginx" -> "nginx", "traefik" ->
"traefik"), ignoring any explicit className override. agent-platform.validate
uses it as the "what would className default to" baseline.
*/}}
{{- define "agent-platform.bundledIngressClass" -}}
{{- .Values.networking.ingress.controller -}}
{{- end }}

{{/*
agent-platform.ingress.className — the IngressClass actually used. An explicit
networking.ingress.className always wins (e.g. "alb"); when unset, falls back to
the bundled class implied by networking.ingress.controller.
*/}}
{{- define "agent-platform.ingress.className" -}}
{{- .Values.networking.ingress.className | default (include "agent-platform.bundledIngressClass" .) -}}
{{- end }}

{{/*
agent-platform.ingress.controller — the effective controller flavor ("nginx" or
"traefik"), read straight from networking.ingress.controller.
*/}}
{{- define "agent-platform.ingress.controller" -}}
{{- .Values.networking.ingress.controller -}}
{{- end }}

{{/*
agent-platform.ingress.tlsEnabled — true when the Ingress terminates TLS:
networking.ingress.tls.enabled=true, OR tls.certManager.enabled=true
(cert-manager on the ingress path implies TLS — that is what the ingress-shim
annotations are for).
*/}}
{{- define "agent-platform.ingress.tlsEnabled" -}}
{{- if or .Values.networking.ingress.tls.enabled .Values.tls.certManager.enabled }}true{{- end }}
{{- end }}

{{/*
agent-platform.ingress.tlsSecretName — Secret the Ingress TLS stanza references.
An explicit networking.ingress.tls.secretName wins; otherwise "<fullname>-tls",
the same name the gateway-path Certificate uses.
*/}}
{{- define "agent-platform.ingress.tlsSecretName" -}}
{{- .Values.networking.ingress.tls.secretName | default (printf "%s-tls" (include "agent-platform.fullname" .)) -}}
{{- end }}

{{/*
agent-platform.ingress — the networking.k8s.io/v1 Ingress (networking.type=ingress).

Extensible (see _components.tpl): each `routes` entry adds a path ahead of the
admin "/" catch-all, in list order. A `stripPrefix: true` route has its
pathPrefix removed before traffic reaches its Service: on nginx via the
per-Ingress rewrite-target annotation (capture group $2) — which then applies to
EVERY path on the object, so every other path is rewritten as a no-op round trip
("/()(<rest>.*)") — and on traefik via a StripPrefix Middleware
(agent-platform.ingressTraefikMiddleware) attached through router.middlewares,
with plain Prefix paths throughout. Every backend uses the Service's "http"
port name.
*/}}
{{- define "agent-platform.ingress" -}}
{{- $ctx := . }}
{{- $ext := dict }}
{{- if hasKey . "context" }}
{{- $ctx = .context }}
{{- $ext = .extensions | default dict }}
{{- end }}
{{- with $ctx }}
{{- if eq .Values.networking.type "ingress" }}
{{- $routes := $ext.routes | default list }}
{{- $stripRoutes := list }}
{{- range $routes }}
{{- if .stripPrefix }}
{{- $stripRoutes = append $stripRoutes . }}
{{- end }}
{{- end }}
{{- $hasStrip := gt (len $stripRoutes) 0 }}
{{- /* TLS on this Ingress: networking.ingress.tls.enabled directly, OR
       tls.certManager.enabled (see agent-platform.ingress.tlsEnabled). */}}
{{- $tlsEnabled := include "agent-platform.ingress.tlsEnabled" . }}
{{- /* ssl-redirect is an nginx-specific annotation key, so only add it for the
       nginx controller flavor. */}}
{{- $sslRedirect := and $tlsEnabled .Values.networking.ingress.tls.redirect (include "agent-platform.bundled.nginx" .) }}
{{- /* cert-manager's ingress-shim annotations are controller-agnostic. Only
       added when tls.certManager is enabled AND an effective issuer name is
       resolvable (bring-your-own issuerRef.name, or a chart-managed Issuer). */}}
{{- $issuerName := include "agent-platform.certManager.issuerName" . }}
{{- $certManagerAnnotation := and .Values.tls.certManager.enabled $issuerName }}
{{- /* Traefik dialect: TLS/entrypoint/middleware config from annotations. */}}
{{- $isTraefik := include "agent-platform.bundled.traefik" . }}
{{- $traefikEntrypoint := .Values.networking.ingress.traefik.entrypoints.web }}
{{- if $tlsEnabled }}
{{- $traefikEntrypoint = .Values.networking.ingress.traefik.entrypoints.websecure }}
{{- end }}
{{- $traefikMiddlewares := and $isTraefik $hasStrip }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "agent-platform.fullname" . }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
  {{- if or .Values.networking.ingress.annotations $hasStrip $sslRedirect $certManagerAnnotation $isTraefik }}
  annotations:
    {{- if $hasStrip }}
    # Strip the prefix of every stripPrefix route before traffic reaches its
    # Service. nginx-only: traefik strips per router with a StripPrefix
    # Middleware attached via router.middlewares below.
    {{- if include "agent-platform.bundled.nginx" . }}
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    {{- end }}
    {{- end }}
    {{- if $sslRedirect }}
    # HTTP->HTTPS redirect once TLS is on — nginx-specific, so gated on the
    # nginx controller flavor (networking.ingress.controller=nginx).
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    {{- end }}
    {{- if $isTraefik }}
    # router.entrypoints selects which Traefik entrypoint serves this Ingress —
    # websecure once TLS terminates here, else web. Entrypoint NAMES are
    # operator-defined (networking.ingress.traefik.entrypoints).
    traefik.ingress.kubernetes.io/router.entrypoints: {{ $traefikEntrypoint }}
    {{- if $tlsEnabled }}
    # Tells Traefik's router to terminate TLS for this Ingress.
    traefik.ingress.kubernetes.io/router.tls: "true"
    {{- end }}
    {{- if $traefikMiddlewares }}
    # Attaches the StripPrefix Middleware(s) (agent-platform.ingressTraefikMiddleware)
    # in traefik's "<namespace>-<name>@kubernetescrd" reference format.
    {{- $refs := list }}
    {{- range $stripRoutes }}
    {{- $refs = append $refs (printf "%s-%s-strip@kubernetescrd" $ctx.Release.Namespace (include "agent-platform.component.fullname" (dict "context" $ctx "entry" .))) }}
    {{- end }}
    traefik.ingress.kubernetes.io/router.middlewares: {{ join "," $refs }}
    {{- end }}
    {{- end }}
    {{- if $certManagerAnnotation }}
    # cert-manager ingress-shim: cert-manager creates/manages the Certificate
    # itself, so no Certificate CR renders on the ingress path.
    {{- if eq (include "agent-platform.certManager.issuerKind" .) "ClusterIssuer" }}
    cert-manager.io/cluster-issuer: {{ $issuerName }}
    {{- else }}
    cert-manager.io/issuer: {{ $issuerName }}
    {{- end }}
    {{- end }}
    {{- with .Values.networking.ingress.annotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  {{- end }}
spec:
  {{- with .Values.networking.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- if $tlsEnabled }}
  tls:
    - hosts:
        - {{ .Values.networking.ingress.host | quote }}
      secretName: {{ include "agent-platform.ingress.tlsSecretName" . }}
  {{- end }}
  rules:
    - host: {{ .Values.networking.ingress.host | quote }}
      http:
        paths:
          {{- range $routes }}
          {{- $prefix := .pathPrefix }}
          {{- if .stripPrefix }}
          # Extension route "{{ .component }}" (stripPrefix): the prefix is
          # stripped by nginx's rewrite-target ($2) or traefik's StripPrefix
          # Middleware, so the Service sees its root paths.
          - path: {{ if $isTraefik }}{{ $prefix }}{{ else }}{{ $prefix }}(/|$)(.*){{ end }}
            pathType: {{ if $isTraefik }}Prefix{{ else }}ImplementationSpecific{{ end }}
          {{- else }}
          # Extension route "{{ .component }}": the Service sees the full path.
          # When an nginx rewrite-target is active it round-trips unchanged
          # through $2 (empty group 1, group 2 recaptures the whole suffix).
          - path: {{ if $isTraefik }}{{ $prefix }}{{ else if $hasStrip }}/()({{ trimPrefix "/" $prefix }}.*){{ else }}{{ $prefix }}{{ end }}
            pathType: {{ if or $isTraefik (not $hasStrip) }}Prefix{{ else }}ImplementationSpecific{{ end }}
          {{- end }}
            backend:
              service:
                name: {{ include "agent-platform.component.fullname" (dict "context" $ctx "entry" .) }}
                port:
                  name: http
          {{- end }}
          # Admin UI/API at the root. Everything not matched by a more-specific
          # path above is routed to the admin service, with the same no-op
          # rewrite treatment when an nginx rewrite-target is active.
          - path: {{ if $isTraefik }}/{{ else if $hasStrip }}/()(.*){{ else }}/{{ end }}
            pathType: {{ if or $isTraefik (not $hasStrip) }}Prefix{{ else }}ImplementationSpecific{{ end }}
            backend:
              service:
                name: {{ include "agent-platform.admin.fullname" . }}
                port:
                  name: http
{{- end }}
{{- end }}
{{- end }}

{{/*
agent-platform.ingressHttpRedirect — plain-HTTP redirect Ingress, Traefik only.
An Ingress with spec.tls is a TLS-only router in Traefik's model, so a SEPARATE
Ingress on the "web" entrypoint (no spec.tls) catches plaintext and redirects it
via the redirect-https Middleware. Renders only for networking.type=ingress with
controller=traefik, TLS enabled and networking.ingress.tls.redirect=true.
*/}}
{{- define "agent-platform.ingressHttpRedirect" -}}
{{- $tlsEnabled := include "agent-platform.ingress.tlsEnabled" . }}
{{- if and (eq .Values.networking.type "ingress") (include "agent-platform.bundled.traefik" .) $tlsEnabled .Values.networking.ingress.tls.redirect }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "agent-platform.fullname" . }}-http-redirect
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: {{ .Values.networking.ingress.traefik.entrypoints.web }}
    traefik.ingress.kubernetes.io/router.middlewares: {{ .Release.Namespace }}-{{ include "agent-platform.fullname" . }}-redirect-https@kubernetescrd
spec:
  {{- with .Values.networking.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  rules:
    - host: {{ .Values.networking.ingress.host | quote }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "agent-platform.admin.fullname" . }}
                port:
                  name: http
{{- end }}
{{- end }}

{{/*
agent-platform.ingressTraefikMiddleware — Traefik Middleware CRs (networking.type=
ingress, controller=traefik): one StripPrefix Middleware
"<route name>-strip" per `stripPrefix: true` extension route, plus the
"<fullname>-redirect-https" RedirectScheme Middleware when TLS and
networking.ingress.tls.redirect are on. Renders 0..n documents.
*/}}
{{- define "agent-platform.ingressTraefikMiddleware" -}}
{{- $ctx := . }}
{{- $ext := dict }}
{{- if hasKey . "context" }}
{{- $ctx = .context }}
{{- $ext = .extensions | default dict }}
{{- end }}
{{- with $ctx }}
{{- if and (eq .Values.networking.type "ingress") (include "agent-platform.bundled.traefik" .) }}
{{- $tlsEnabled := include "agent-platform.ingress.tlsEnabled" . }}
{{- $first := true }}
{{- range ($ext.routes | default list) }}
{{- if .stripPrefix }}
{{- if not $first }}
---
{{- end }}
{{- $first = false }}
# Strips the "{{ .component }}" route's pathPrefix before traffic reaches its
# Service — traefik's analogue of nginx's rewrite-target annotation, referenced
# from the Ingress via router.middlewares.
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: {{ include "agent-platform.component.fullname" (dict "context" $ctx "entry" .) }}-strip
  namespace: {{ $ctx.Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" $ctx | nindent 4 }}
spec:
  stripPrefix:
    prefixes:
      - {{ .pathPrefix }}
{{- end }}
{{- end }}
{{- if and $tlsEnabled .Values.networking.ingress.tls.redirect }}
{{- if not $first }}
---
{{- end }}
# Redirects plain-HTTP requests to HTTPS. Referenced from the separate
# plain-HTTP redirect Ingress (agent-platform.ingressHttpRedirect).
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: {{ include "agent-platform.fullname" . }}-redirect-https
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent-platform.labels" . | nindent 4 }}
spec:
  redirectScheme:
    scheme: https
    permanent: true
{{- end }}
{{- end }}
{{- end }}
{{- end }}
