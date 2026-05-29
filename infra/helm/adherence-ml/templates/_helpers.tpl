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
