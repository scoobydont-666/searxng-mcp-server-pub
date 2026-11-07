{{- define "search.name" -}}{{ default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- define "search.fullname" -}}{{ default .Release.Name .Values.fullnameOverride | trunc 40 | trimSuffix "-" }}{{- end -}}
{{- define "search.labels" -}}
app.kubernetes.io/name: {{ include "search.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}
{{- define "search.selector" -}}
app.kubernetes.io/name: {{ include "search.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "search.sa" -}}
{{- if .Values.serviceAccount.create -}}{{ default (include "search.fullname" .) .Values.serviceAccount.name }}{{- else -}}{{ default "default" .Values.serviceAccount.name }}{{- end -}}
{{- end -}}
{{- define "search.image" -}}
{{- if .image.digest -}}{{ printf "%s@%s" .image.repository .image.digest }}{{- else -}}{{ printf "%s:%s" .image.repository .image.tag }}{{- end -}}
{{- end -}}
{{- define "search.placement" -}}
{{- with .root.Values.imagePullSecrets }}
imagePullSecrets: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .root.Values.nodeSelector }}
nodeSelector: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .root.Values.tolerations }}
tolerations: {{ toYaml . | nindent 2 }}
{{- end }}
{{- with .root.Values.priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
{{- if .root.Values.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: {{ .root.Values.topologySpread.topologyKey }}
    whenUnsatisfiable: {{ .root.Values.topologySpread.whenUnsatisfiable }}
    {{- if eq .root.Values.topologySpread.whenUnsatisfiable "DoNotSchedule" }}
    minDomains: {{ .root.Values.topologySpread.minDomains }}
    {{- end }}
    labelSelector:
      matchLabels:
        {{- include "search.selector" .root | nindent 8 }}
        app.kubernetes.io/component: {{ .component }}
{{- end }}
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels:
              {{- include "search.selector" .root | nindent 14 }}
              app.kubernetes.io/component: {{ .component }}
{{- end -}}
{{- define "search.annotations" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
searxng.platform/secret-revision: {{ .Values.secrets.revision | quote }}
{{- with .Values.podAnnotations }}
{{ toYaml . }}
{{- end }}
{{- end -}}
{{- define "search.settings" -}}
{{- $v := deepCopy .root.Values.searxng.settings -}}
{{- if eq .component "web" -}}{{- $v = mergeOverwrite $v (deepCopy .root.Values.web.settings) -}}{{- end -}}
{{- if not (hasKey $v "server") -}}{{- $_ := set $v "server" dict -}}{{- end -}}
{{- if not (hasKey $v "search") -}}{{- $_ := set $v "search" dict -}}{{- end -}}
{{- $_ := set $v.server "secret_key" "" -}}
{{- $_ := set $v.server "port" (.root.Values.searxng.port | int) -}}
{{- if eq .component "web" -}}
{{- $_ := set $v.search "formats" (list "html") -}}
{{- $_ := set $v.server "base_url" .root.Values.web.baseUrl -}}
{{- $_ := set $v.server "limiter" .root.Values.web.limiter -}}
{{- else -}}
{{- $_ := set $v.search "formats" (list "json") -}}
{{- $_ := set $v.server "limiter" false -}}
{{- $_ := set $v.server "base_url" (printf "http://%s-searxng:%v/" (include "search.fullname" .root) .root.Values.searxng.port) -}}
{{- end -}}
{{- if or (kindIs "map" $v.use_default_settings) $v.use_default_settings -}}
{{- $defaults := dict -}}
{{- if kindIs "map" $v.use_default_settings -}}{{- $defaults = deepCopy $v.use_default_settings -}}{{- end -}}
{{- $_ := set $defaults "engines" (dict "keep_only" (include "search.availableEngines" .root | fromJsonArray)) -}}
{{- $_ := set $v "use_default_settings" $defaults -}}
{{- end -}}
{{ toYaml $v }}
{{- end -}}

{{/* extraEgress is a narrow issuer/API exception, not a second public route. */}}
{{- define "search.rejectUnsafeExtraEgress" -}}
{{- range $component, $rules := . -}}
{{- range $rule := $rules -}}
{{- if or (empty $rule.to) (empty $rule.ports) -}}
{{- fail "networkPolicy.extraEgress rules need explicit to and ports" -}}
{{- end -}}
{{- range $peer := $rule.to -}}
{{- if or (hasKey $peer "podSelector") (hasKey $peer "namespaceSelector") (not (hasKey $peer "ipBlock")) -}}
{{- fail "networkPolicy.extraEgress peers must be one narrow ipBlock" -}}
{{- end -}}
{{- if $peer.ipBlock.except -}}
{{- fail "networkPolicy.extraEgress ipBlock.except is not supported" -}}
{{- end -}}
{{- $parts := splitList "/" $peer.ipBlock.cidr -}}
{{- $prefix := atoi (index $parts 1) -}}
{{- $addr := index $parts 0 -}}
{{- if contains ":" $addr -}}
{{- if or (lt $prefix 64) (regexMatch "(?i)^(?:fe[89ab][0-9a-f]:|ff[0-9a-f]{2}:|f[cd][0-9a-f]{0,2}:|::1?$|2001:0*db8:|2002:|64:ff9b|100::|2001:(?::|0{0,4}:|0{0,3}1[0-9a-f]{0,3}:))" $addr) -}}
{{- fail (printf "networkPolicy.extraEgress cidr %s is too wide or not a forwardable unicast prefix" $peer.ipBlock.cidr) -}}
{{- end -}}
{{- else if or (lt $prefix 24) (regexMatch "^(?:0\\.|127\\.|169\\.254\\.|22[4-9]\\.|23[0-9]\\.|2[4-5][0-9]\\.)" $addr) -}}
{{- fail (printf "networkPolicy.extraEgress cidr %s is too wide or not a forwardable unicast prefix" $peer.ipBlock.cidr) -}}
{{- end -}}
{{- end -}}
{{- range $port := $rule.ports -}}
{{- $protocol := default "TCP" $port.protocol -}}
{{- if or (ne $protocol "TCP") (hasKey $port "endPort") (not (or (eq ($port.port | toString) "80") (eq ($port.port | toString) "443"))) -}}
{{- fail "networkPolicy.extraEgress ports must be TCP 80 or 443" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "search.quotaPrefix" -}}
{{- default (printf "%s:%s" .Release.Namespace (include "search.fullname" .)) .Values.mcp.rateLimitPrefix -}}
{{- end -}}
{{/* Reject accidental secrets before they can enter ConfigMaps, Helm history, or Git. */}}
{{- define "search.checkPublicSettings" -}}
{{- if kindIs "map" .value -}}
{{- range $key, $value := .value -}}
{{- if and (regexMatch "(?i)(?:^|[_.-])(?:api[_-]?keys?|api[_-]?secrets?|passwords?|passwd|auth[_-]?pass|secrets?|tokens?|credentials?|private[_-]keys?|authorization)(?:$|[_.-])|(?:^|[_.-])api$" $key) (not (empty $value)) -}}
{{- fail (printf "%s.%s is secret material; use searxng.secretSettings.existingSecret" $.path $key) -}}
{{- end -}}
{{- include "search.checkPublicSettings" (dict "value" $value "path" (printf "%s.%s" $.path $key)) -}}
{{- end -}}
{{- else if kindIs "slice" .value -}}
{{- range $index, $value := .value -}}
{{- include "search.checkPublicSettings" (dict "value" $value "path" (printf "%s[%v]" $.path $index)) -}}
{{- end -}}
{{- else if kindIs "string" .value -}}
{{- if regexMatch "://[^/[:space:]]+@" .value -}}{{- fail (printf "%s contains URL credentials; use searxng.secretSettings.existingSecret" .path) -}}{{- end -}}
{{- end -}}
{{- end -}}

{{- define "search.availableEngines" -}}
{{ toJson .Values.mcp.enginePolicy.engines }}
{{- end -}}
