# SearXNG platform chart configuration

This chart owns the search workload. It does not bootstrap Kubernetes, its CNI,
Ingress controller, certificate issuer, OIDC provider, Prometheus Operator, or an
external HA Valkey service. The repository's operations layer owns those
prerequisites. Read `values.yaml` for every chart control and
`values.schema.json` for validation. Keep local site overrides in the deployment
repository; keep secret bytes in the encrypted secret workflow.

## Render and select a profile

From the repository root:

```bash
helm lint charts/searxng-platform
helm template search charts/searxng-platform --namespace search \
  -f environments/lab.yaml
helm template search charts/searxng-platform --namespace search \
  -f environments/enterprise-3k.yaml -f site-values.yaml
```

The enterprise profiles deliberately fail rendering until `site-values.yaml`
supplies the actual published `mcp.image.digest` and the routable
`valkey.externalCidrs`. A syntactically valid digest does not prove that an image
exists or has passed the repository's release checks. The default application repository under `example-org` is a placeholder. Set the
repository you control, then build and verify its image before installing. All Services are `ClusterIP`; migration of the previous
NodePort integration is a separate operations step.

| Profile | Shared search admission | SearXNG minimum | Granian slots at minimum | Infrastructure requirement |
| --- | ---: | ---: | ---: | --- |
| Lab | 5/s | 1 | 1 worker × 4 threads = 4 | One evaluation cluster; bundled Valkey |
| Enterprise 3k | 20/s | 3 | 3 × 1 × 16 = 48 | Three worker nodes; external HA Valkey |
| Enterprise 5k | 25/s | 3 | 3 × 1 × 32 = 96 | Three worker nodes; external HA Valkey |

The default enterprise scheduling spreads each component over at least three
worker hostnames. For a cluster with three independent zones, change
`topologySpread.topologyKey` to `topology.kubernetes.io/zone`. Node spreading
within one LAN is not protection against loss of the entire site.

These are **qualification starting points, not benchmark results**. User count
is not request rate. The profiles assume 20 queries/person/day over eight hours,
10% of people actively searching once per 30 seconds, and five reserved machine
queries/second. Four primary engines imply up to 80 or 100 upstream requests/s
before retries or fallbacks. Increasing replicas does not increase the shared
admission rate and does not remove engine provider quotas, bans, or usage terms.
Measure request latency, upstream failures, partial results, memory, and rejection
rates before increasing the limit. Optional browser pods add resource requests;
they do not get an independent unlimited search budget.

## Broad engine examples

`examples/values-all-engines.yaml` copies the pinned catalog's eligible public
online inventory and its bounded per-category engine policy. It enables MCP and
explicit alternate feeds, keeps REST disabled, and can be combined after a lab,
3k, or 5k profile. Entries requiring credentials, private service endpoints,
upstream maintenance changes, or other prerequisites remain in the catalog;
they are not silently activated. Catalog presence does not establish current
provider availability or permission to use that provider.

`examples/values-all-engines-secure.yaml` has the same engine policy, fetch-domain
allowlist, and official feed rules. It includes the complete 5k planning profile
and enables REST, OIDC browser access, strict TLS ingress, external HA datastore
mode, image digest enforcement, three-worker spreading, an explicit `searxng-users` OIDC group gate, HPA/PDB protection,
monitoring CRs, namespace quotas, and smaller request/fetch limits. It intentionally
cannot render until operator values supply the image digest, HA endpoint CIDRs,
TLS Secret, issuer, client ID, restricted email-domain policy, and trusted ingress
CIDRs. Replace `searxng-users` with the actual authorized identity-provider group claim.
Existing Secret contents and prerequisites must also exist before install.

```bash
helm template search charts/searxng-platform --namespace search \
  -f environments/lab.yaml -f examples/values-all-engines.yaml
helm template search charts/searxng-platform --namespace search \
  -f examples/values-all-engines-secure.yaml -f site-values.yaml
```

Both examples use a transparent operator contact URL placeholder. Replace it
with the actual service contact URL before installation. The hardened example
creates `monitoring.coreos.com/v1` `ServiceMonitor` and `PrometheusRule` resources;
install those CRDs and select the release's monitoring labels first.

## Access paths and independent switches

| Control | Effect |
| --- | --- |
| `mcp.enabled` | Serves authenticated MCP at exactly `/mcp`; default true |
| `mcp.apiEnabled` | Serves scoped REST search at exactly `/api/v1/search`; default false |
| `mcp.fetchEnabled` | Enables scoped fetch/extract tools; requires explicit domains; default false |
| `web.enabled` | Adds OIDC proxy → web admission → HTML-only SearXNG; default false |
| `ingress.enabled` | Creates a TLS Ingress for enabled routes; default false |

The JSON backend receives traffic only from the MCP/API deployment. It enables
only JSON output and disables the native limiter so shared gateway traffic is
not treated as a single human client. The HTML backend enables only HTML output
and is reachable only through web admission. OAuth2 Proxy is the sole public
browser target. Neither backend, admission readiness, nor metrics is directly
published in Ingress. Disabling REST therefore cannot expose native JSON through
the browser deployment.

`mcp.searchTimeoutMs` bounds each search attempt (default 5 seconds);
`mcp.requestTimeoutMs` bounds the entire request (default 30 seconds). The attempt
budget cannot exceed the total budget. Native outgoing timeouts start at 4 seconds,
below the default 5-second gateway attempt. An aborted request can still leave a
bounded tail of upstream work; qualify engine-specific timeouts and retries when
changing these values. Primary and fallback attempts each consume
shared admission, so retries cannot silently multiply the admitted engine budget.
The explicit REST `engines` parameter accepts only names in the configured policy,
with at most four engines selected per attempt.

The HTTP gateway runs stateless MCP; there is no session-affinity requirement.
Principals and their permissions come from the referenced JSON Secret. Use
separate principals for people, services, and integrations, and grant only the
required `mcp:search`, `mcp:fetch`, or `api:search` scopes supported by the runtime.
The runtime's principal document format is documented in the repository.

## Secrets and rotation

The chart never generates secret bytes and never renders a Secret. Create the
referenced Secrets in the release namespace through the approved encrypted
workflow before starting workloads.

| Value / default key | Consumer / content |
| --- | --- |
| `secrets.existingSecret` | Shared existing Secret name, default `searxng-platform-secrets` |
| `secrets.principalsKey` / `principals.json` | Gateway principal JSON document |
| `secrets.searxngSecretKey` / `searxng-secret` | Strong unpredictable SearXNG signing secret, delivered as `SEARXNG_SECRET` |
| `secrets.valkeyUrlKey` / `valkey-url` | Node gateway/admission URL: `redis://` or `rediss://` |
| `secrets.limiterValkeyUrlKey` / `searxng-valkey-url` | HTML backend native Valkey URL: `valkey://` or `valkeys://` |
| `secrets.sessionValkeyUrlKey` / `session-valkey-url` | OAuth2 Proxy session URL: `redis://` or `rediss://` |
| `secrets.valkeyPasswordKey` / `valkey-password` | Bundled lab Valkey password. Use only `A-Za-z0-9._~+/=-`; the container refuses to start otherwise. It is written to a mode-0600 file in the pod's `/tmp` volume, never passed on the command line |
| `web.oauth2Proxy.existingSecret` | OIDC client and cookie keys; defaults `client-secret` and `cookie-secret` |
| `searxng.secretSettings.existingSecret` | Optional private full settings overlay; key defaults to `settings.yml` |

Use authenticated TLS URLs for external HA services. URL-encode passwords; choose
separate logical databases or key prefixes where supported. The MCP and web
admission processes **must** use the same quota endpoint and
`mcp.rateLimitPrefix`; the default prefix is `<namespace>:<release>`. OIDC session
storage and native backend state may use separate HA endpoints/databases.
`valkey.externalCidrs` and `externalPort` must cover every endpoint a managed
service's stable URL can resolve to after failover. These are ordinary Redis
protocol endpoints, not a declaration of Sentinel or Redis Cluster client support.

Increment `secrets.revision` whenever any referenced Secret changes. This string
is included in every affected pod template to restart startup-only consumers.
A key-name change or ConfigMap/policy change also changes rollout checksums.
Templates do not depend on timestamps, random bytes, cluster lookups, or chart
render time. Keep the prior encrypted secret version until rollback has been
qualified; rotating session and signing keys can invalidate active sessions.

## Complete upstream settings, including credentials

`searxng.settings` accepts the upstream settings mapping. It can configure engines,
categories, plugins, search defaults, UI behavior, outgoing requests, transport
pools, engine weights and timing, and other settings supported by the pinned
SearXNG version. `web.settings` merges browser-specific differences over that
mapping. `use_default_settings` can remain enabled or be set to false when the
operator supplies complete engine definitions. Named keys and types in the
upstream file are version-specific; the pinned upstream sources below are the
reference. The chart rejects obsolete `outgoing.pool_maxsize`; current versions
use `outgoing.pool_connections`.

Place engine API keys, authenticated proxy URLs, and other credentials in the
**private Secret overlay**, never in `values.yaml`, a Helm `--set` argument, or
ordinary settings ConfigMaps. Secret-bearing common key names and credential
URLs are rejected during rendering. No static detector can identify every
conceivable credential; operators remain responsible for keeping secret material
out of public settings.

An unprivileged init container uses the pinned SearXNG image's Python and PyYAML
to merge the private overlay with public settings. Mappings merge recursively;
engine lists merge by engine `name` so adding a credential does not erase the
rest of the catalog; other lists replace their predecessor. The result is written
with mode `0600` into a memory-backed volume. Secret input is read-only and no
parser exception or settings content is logged.

After merging, the init container always restores these boundaries:

- Backend formats are `json`; browser formats are `html`.
- Both native limiters are false; authenticated gateway admission owns the quotas.
- Bind address, port, and public base URL are chart-controlled.
- Signing material comes from `SEARXNG_SECRET`; the YAML signing key stays empty.
- Native debug and native metrics are disabled. Gateway metrics are supported.
- Outgoing TLS verification remains enabled; public-instance and image-proxy modes stay disabled.
- Enabled/configured engine names stay within the selected engine catalog.

An engine requiring credentials is usable only after its prerequisites are met,
its name is added to the policy catalog, and its private configuration is supplied.
Do not use private configuration to add an internal fetch target without an
explicit, reviewed egress rule. New mandatory upstream keys should be covered by
an image upgrade and qualification run, rather than silently changing the pin.

## Engine selection and alternative feeds

An explicit `mcp.enginePolicy` is mandatory. The chart provides a small default
policy covering all five supported categories. The policy is mounted as
`SEARXNG_MCP_ENGINE_POLICY_FILE` and defines:

```yaml
mcp:
  enginePolicy:
    engines: [google, bing, duckduckgo, brave]
    categories:
      general:
        primary: [google, bing]
        fallbacks:
          - [duckduckgo, brave]
      # Also define news, images, videos, and science in a complete policy.
```

The allowed catalog can be broad while each attempt remains at most four engines
and each category has at most two fallback groups. The complete catalog controls
SearXNG's `keep_only` list; it does not make every search fan out to all providers.
The generated all-engine examples use the pinned catalog's safe public candidates
and separately record engines requiring credentials, local services, or repair.
Availability in this inventory is not a guarantee of live reachability or legal
permission to send a particular request volume.

`mcp.feedPolicy` mounts an explicit policy as
`SEARXNG_MCP_FEED_POLICY_FILE`. It can map a blocked page to a publisher's official
RSS, Atom, or API source. Rules have a fixed source host, bounded path captures,
HTTPS alternative templates, statuses to trigger on, and at most two alternatives.
Both the source and each destination hostname must appear exactly in
`mcp.allowedDomains`. Feed alternatives are scoped fetch behavior, so they require
`mcp.fetchEnabled`. The runtime returns alternative-source provenance; it does not
claim to have accessed the original blocked page. This is not CAPTCHA or
Cloudflare challenge circumvention.

`mcp.fetch.userAgent` is a stable, transparent service identity. Add an operator
contact URL in site values. Header rotation and browser/curl/Python impersonation
are not exposed. SearXNG's own engine transports retain their upstream protocol
behavior; `outgoing.useragent_suffix` identifies this deployment where supported.

## OIDC browser settings

Set `web.enabled`, `web.baseUrl`, OIDC `issuerUrl`, `clientId`, explicit
`emailDomains`, existing secret references, and `trustedProxyCidrs`. Wildcard
email domains and world-open trusted proxies are rejected. Set `allowedGroups`
for a further identity-provider group constraint. Match `web.baseUrl` exactly to
the HTTPS web ingress origin; register `/oauth2/callback` at that origin with the
provider. Redis-backed sessions keep large group claims out of the browser cookie.

OAuth2 Proxy requires nonce checking, secure/HTTP-only SameSite cookies, and
explicit trusted ingress proxy CIDRs. Cookie lifetime, refresh, scopes, groups,
and the limited non-security `extraArgs` surface are configurable. The chart
blocks arguments that override identity, secret, cookie, or routing boundaries.
The `__Host-` cookie has a root path and no domain attribute. The OIDC provider
and the ingress controller must have stable, reviewed network locations. A private
issuer needs a narrow egress exception.

Native `web.limiter` is fixed to false. The browser gateway intentionally does
not forward client IP addresses or browser identity headers to SearXNG, so native
IP/bot heuristics would see the shared gateway address and service identity.
`web.limiterConfig` is retained as a native TOML settings surface, but that limiter
is inactive in this architecture and `web.limiter: true` is rejected.

OAuth2 Proxy strips caller-supplied identity headers, then injects the authenticated
session's user claim. The pinned proxy is explicitly configured with
`--pass-user-headers=true`, `--skip-auth-strip-headers=true`, and
`--prefer-email-to-user=false`. The admission service accepts requests only from
the proxy under NetworkPolicy, rejects missing/invalid identity, hashes the
identity for its Redis key, and strips it before forwarding to HTML SearXNG.
Access/identity tokens and Authorization headers are not sent to either backend.

`web.admission.userRateLimit` and `userRateLimitWindowSeconds` configure a shared
per-human search quota (defaults 60 searches per 60 seconds; hardened example
30 per 60 seconds). Browser searches also consume the same global search budget
as machine traffic. Local in-flight and response-size caps remain under
`web.admission`; those local caps multiply with replicas, while the shared
per-human and global quotas do not. A failed quota store fails admission closed.

## Workload, network, and monitoring knobs

| Surface | Controls |
| --- | --- |
| Images | Repository, tag, immutable digest, pull policy, pull secrets; production digest gate |
| Scaling | Replica counts, HPA min/max/CPU target, PDB minimum; profiles choose initial values |
| Scheduling | Node selectors, tolerations, priority class, topology key/domain count; preferred host anti-affinity |
| Resources | CPU/memory/ephemeral storage requests and limits for each component |
| Granian | Workers, blocking threads, backlog, additional non-reserved `GRANIAN_*` environment settings |
| Lifecycle | Startup/readiness/liveness probes; shutdown grace and termination budget; five-second preStop drain delay |
| Service identity | Optional service account creation/name; API token automount always disabled |
| Gateway | Exact allowed CORS origins, machine principal and browser identity rate/window, shared search rate, local in-flight cap, total/per-attempt search timeouts, request bytes, search response bytes |
| Fetch | Explicit domains, maximum bytes, timeout, concurrency, rate, bounded retries, stable User-Agent |
| Valkey | Lab-only bundled mode, memory, no-eviction policy, optional PVC; external CIDRs/port for HA mode |
| Ingress | Enable flag, controller class, independent API/UI hosts, TLS Secret, additional controller annotations |
| Network | Ingress-controller peers, explicit in-cluster clients, DNS peers, monitoring peers, public ports, narrow egress exceptions |
| Monitoring | Optional ServiceMonitor interval/timeout/labels and PrometheusRule thresholds/labels |
| Namespace quota | Optional ResourceQuota; use a dedicated namespace because quotas affect the whole namespace |

Non-root users, dropped capabilities, seccomp, no privilege escalation, read-only
root filesystems, and no host mounts are enforced. Only temporary/configuration
paths are writable. `enableServiceLinks: false` is mandatory: Kubernetes service
environment injection otherwise can populate `SEARXNG_PORT` with a URL where the
entrypoint expects an integer.

NetworkPolicies deny ingress and egress by default. Narrow rules allow the
controller, DNS, component-to-component flows, Valkey, and monitoring. Search
engines and configured fetch providers get public IPv4 egress and global IPv6
egress (`2000::/3`) with private, loopback, link-local, metadata, multicast,
documentation, 6to4, and IETF protocol-assignment ranges excluded. No
NetworkPolicy provides domain-level filtering;
the runtime separately resolves and validates fetch destinations. DNS and pod
selector behavior must be tested against the chosen CNI and kube-proxy mode.

Browser access requires `networkPolicy.enabled` and a CNI that enforces
NetworkPolicy: web-admission accepts the OAuth2 proxy's identity header from its
network peer, so a cluster that ignores NetworkPolicy lets any pod assert an
identity.

`networkPolicy.extraEgress` is an explicit infrastructure exception keyed by
component (`searxng`, `mcp`, `web-auth`, `web-admission`, `web`): each list is
added only to that component's policy. Each peer must be one `ipBlock`. IPv4
prefixes must be `/24` or longer and IPv6 prefixes `/64` or longer, on TCP 80
or 443 only. World routes, link-local, loopback, multicast, and the same
translation ranges excluded from public egress are rejected. Keep it to the
single private OIDC issuer's subnet on TCP/443 under `web-auth`. Never add
internal peers to `mcp` when fetch is enabled; it fetches caller-chosen URLs.
`clientPeers` only permits direct clients of the authenticated gateway; it
never opens the raw search backends.

The optional ServiceMonitor scrapes only the private gateway `/metrics`, served
with the probes on the separate `admin` port (`mcp.adminPort`, default 8528),
never on the API port. The
rules cover target availability, server-error ratio, p95 latency, and quota-store
rejection. Install Prometheus Operator CRDs first and set the labels used by the
Prometheus selector. Metrics contain route/status/rejection classes, not queries
or principal tokens. Native SearXNG engine metrics are not part of this chart;
adding them requires a separate password-protected endpoint and appropriate
scrape credentials.

## Upstream references and release pins

- [SearXNG pinned settings](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/settings.yml)
- [SearXNG pinned container entrypoint](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/container/entrypoint.sh)
- [SearXNG settings documentation](https://docs.searxng.org/admin/settings/index.html)
- [SearXNG limiter documentation](https://docs.searxng.org/admin/searx.limiter.html)
- [OAuth2 Proxy configuration](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/)
- [Kubernetes NetworkPolicy behavior](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Kubernetes topology spreading](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)

The default SearXNG, Valkey, and OAuth2 Proxy image digests were resolved from the
registries for the repository's dated source review. Their exact immutable
values are in `values.yaml`; do not copy a tag from an unreviewed upgrade into
production. Chart rendering and schema validation are offline checks. They do
not constitute live cluster, OIDC, provider, failover, or 3–5k-user load validation.

The browser header trust boundary is verified against the pinned OAuth2 Proxy
[v7.15.6 legacy options](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/pkg/apis/options/legacy_options.go),
[strip/inject middleware](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/pkg/middleware/headers.go),
and [claim injector](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/pkg/header/injector.go).
The `skip-auth-strip-headers` flag is deliberately **true**: false preserves caller
header values in this pinned implementation.
