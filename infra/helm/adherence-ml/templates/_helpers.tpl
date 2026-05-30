{{- define "adherence.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "adherence.fullname" -}}
{{- printf "%s" (include "adherence.name" .) -}}
{{- end -}}

{{- define "adherence.labels" -}}
app.kubernetes.io/name: {{ include "adherence.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "adherence.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "adherence.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
adherence.podSecurityContext renders the pod-level securityContext when
.Values.securityContext.enabled is true. Used by every Deployment so the
posture stays uniform across api, worker, and trainer.
*/}}
{{- define "adherence.podSecurityContext" -}}
{{- if .Values.securityContext.enabled -}}
securityContext:
{{ toYaml .Values.securityContext.pod | indent 2 }}
{{- end -}}
{{- end -}}

{{/*
adherence.containerSecurityContext renders the container-level
securityContext (drops caps, blocks privilege escalation, read-only rootfs).
*/}}
{{- define "adherence.containerSecurityContext" -}}
{{- if .Values.securityContext.enabled -}}
securityContext:
{{ toYaml .Values.securityContext.container | indent 2 }}
{{- end -}}
{{- end -}}

{{/*
adherence.writableVolumes renders emptyDir volumes that back the read-only
root filesystem with scratch space (/tmp, framework caches, ...).
*/}}
{{- define "adherence.writableVolumes" -}}
{{- if and .Values.securityContext.enabled .Values.securityContext.writableDirs -}}
{{- range .Values.securityContext.writableDirs }}
- name: {{ .name }}
  emptyDir:
    sizeLimit: {{ .sizeLimit | default "64Mi" }}
{{- end }}
{{- end -}}
{{- end -}}

{{/*
adherence.writableVolumeMounts pairs with adherence.writableVolumes.
*/}}
{{- define "adherence.writableVolumeMounts" -}}
{{- if and .Values.securityContext.enabled .Values.securityContext.writableDirs -}}
{{- range .Values.securityContext.writableDirs }}
- name: {{ .name }}
  mountPath: {{ .mountPath }}
{{- end }}
{{- end -}}
{{- end -}}
