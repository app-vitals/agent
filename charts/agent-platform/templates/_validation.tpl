{{/*
agent-platform.validate — cross-field guards for the networking/TLS/cert-manager
values plus the agent provisioning guards. Called from agent-platform.notes (so
it fires on every install/upgrade without touching manifest output) and from
agent-platform.certManagerIssuer. Each check `fail`s; the first failing one wins:

  1. controller=nginx while networking.ingress.traefik.entrypoints is customized
     (half-migrated values: both controllers appear configured).
  2. className names the OTHER bundled controller (className=nginx with
     controller=traefik, or className=traefik with controller=nginx). An
     unrecognized className (e.g. "alb") is never a contradiction.
  3. tls.certManager.issuer.create=true, type=letsencrypt and no email (ACME
     requires a contact email).
  4. tls.certManager.enabled + issuer.create + type=letsencrypt with
     networking.type=gateway: the HTTP-01 solver targets an Ingress, which never
     renders in gateway mode, so the challenge could never complete.
  5. An explicit className that differs from the controller's bundled class AND
     names the other known controller (check 2 stated from the other side).
  6. ingress-nginx.enabled and traefik.enabled at once (two bundled controller
     subcharts in one release).
  7. agent-platform.validate.claudePolicy.
  8. agent-platform.validate.anthropicFederation.
*/}}
{{- define "agent-platform.validate" -}}
{{- $ingress := .Values.networking.ingress -}}
{{- $controller := $ingress.controller -}}
{{- $className := $ingress.className -}}
{{- $traefikCustomized := or (ne $ingress.traefik.entrypoints.web "web") (ne $ingress.traefik.entrypoints.websecure "websecure") -}}
{{- if and (eq $controller "nginx") $traefikCustomized -}}
{{- fail "networking.ingress.controller=nginx but networking.ingress.traefik.entrypoints is customized — both bundled ingress controllers appear to be configured at once. Set networking.ingress.controller=traefik to use the Traefik entrypoints, or reset traefik.entrypoints to defaults if you meant to stay on nginx." -}}
{{- end -}}
{{- if and (eq $className "nginx") (eq $controller "traefik") -}}
{{- fail "networking.ingress.className=nginx contradicts networking.ingress.controller=traefik. Set controller=nginx, or change className to a Traefik IngressClass." -}}
{{- end -}}
{{- if and (eq $className "traefik") (eq $controller "nginx") -}}
{{- fail "networking.ingress.className=traefik contradicts networking.ingress.controller=nginx. Set controller=traefik, or change className to an NGINX IngressClass." -}}
{{- end -}}
{{- if and .Values.tls.certManager.issuer.create (eq .Values.tls.certManager.issuer.type "letsencrypt") (not .Values.tls.certManager.issuer.email) -}}
{{- fail "tls.certManager.issuer.email is required when tls.certManager.issuer.create=true and tls.certManager.issuer.type=letsencrypt (Let's Encrypt requires a contact email on every ACME account)." -}}
{{- end -}}
{{- if and .Values.tls.certManager.enabled .Values.tls.certManager.issuer.create (eq .Values.tls.certManager.issuer.type "letsencrypt") (eq .Values.networking.type "gateway") -}}
{{- fail "tls.certManager.issuer.create=true with tls.certManager.issuer.type=letsencrypt is not supported when networking.type=gateway — the chart-managed Issuer's HTTP-01 solver targets an Ingress, which never renders in gateway mode (templates/ingress.yaml only renders for networking.type=ingress), so the ACME challenge could never complete. Use tls.certManager.issuer.type=selfsigned, switch networking.type to ingress, or bring your own Issuer via tls.certManager.issuerRef.name instead." -}}
{{- end -}}
{{- $bundledClass := include "agent-platform.bundledIngressClass" . -}}
{{- if and $className (ne $className $bundledClass) (or (eq $className "nginx") (eq $className "traefik")) -}}
{{- fail (printf "networking.ingress.className=%s contradicts the class implied by networking.ingress.controller=%s (%s). Align className with controller, or use an IngressClass name this chart does not special-case (e.g. \"alb\")." $className $controller $bundledClass) -}}
{{- end -}}
{{- if and (index .Values "ingress-nginx" "enabled") (.Values.traefik.enabled) -}}
{{- fail "ingress-nginx.enabled=true and traefik.enabled=true are both set — both bundled ingress controller subcharts are enabled at once. Enable only one (or neither, to bring your own)." -}}
{{- end -}}
{{- include "agent-platform.validate.claudePolicy" . -}}
{{- include "agent-platform.validate.anthropicFederation" . -}}
{{- end -}}
