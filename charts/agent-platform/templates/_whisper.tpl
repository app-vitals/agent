
{{/*
Whisper ASR Deployment (agent.voice.enabled and provider == whisper).
*/}}
{{- define "agent-platform.whisper.deployment" -}}
{{- if and .Values.agent.voice.enabled (eq .Values.agent.voice.provider "whisper") }}
{{- /*
  Self-hosted Whisper ASR pod (CV-1.1). Rendered ONLY when agent.voice.enabled
  AND agent.voice.provider == "whisper". Runs onerahmet/openai-whisper-asr-webservice,
  which exposes POST /asr (multipart `audio_file`, query task=transcribe&output=txt)
  on container port 9000 — the contract the agent's makeWhisperSvcClient targets.

  The in-cluster URL of the paired Service (whisper-service.yaml) is injected into
  the admin Deployment as WHISPER_SERVICE_URL and flowed to provisioned agent pods
  by the admin provisioner. For provider=groq this file renders nothing (no pod).
*/}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "agent-platform.whisper.fullname" . }}
  labels:
    {{- include "agent-platform.whisper.labels" . | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      {{- include "agent-platform.whisper.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "agent-platform.whisper.selectorLabels" . | nindent 8 }}
    spec:
      {{- with .Values.global.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . }}
        {{- end }}
      {{- end }}
      containers:
        - name: whisper
          image: "{{ with .Values.global.imageRegistry }}{{ . }}/{{ end }}{{ .Values.agent.voice.whisper.image }}"
          imagePullPolicy: {{ .Values.imagePullPolicy }}
          ports:
            - name: http
              containerPort: 9000
              protocol: TCP
          {{- with .Values.agent.voice.whisper.model }}
          env:
            - name: ASR_MODEL
              value: {{ . | quote }}
          {{- end }}
          {{- with .Values.agent.voice.whisper.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
{{- end }}
{{- end }}

{{/*
Whisper ASR Service (same condition as the Deployment).
*/}}
{{- define "agent-platform.whisper.service" -}}
{{- if and .Values.agent.voice.enabled (eq .Values.agent.voice.provider "whisper") }}
{{- /*
  Service fronting the self-hosted Whisper ASR pod (CV-1.1). Rendered under the
  same condition as whisper-deployment.yaml. Its ClusterIP DNS name + port form
  WHISPER_SERVICE_URL (see agent-platform.whisper.serviceUrl), which the admin injects
  and the provisioner flows into provisioned agent pods.
*/}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "agent-platform.whisper.fullname" . }}
  labels:
    {{- include "agent-platform.whisper.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  ports:
    - name: http
      port: {{ .Values.agent.voice.whisper.service.port }}
      targetPort: 9000
      protocol: TCP
  selector:
    {{- include "agent-platform.whisper.selectorLabels" . | nindent 4 }}
{{- end }}
{{- end }}
