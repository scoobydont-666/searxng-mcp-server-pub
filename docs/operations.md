# Operating the SearXNG platform

This guide takes a reviewed source revision to a reviewable deployment bundle,
then describes activation, verification, migration, and recovery. The repository
configures the application workload; the operator owns Kubernetes, its network,
Flux, DNS, certificate issuance, the identity provider, and the HA datastore.
Preparing or validating these files does not install anything on a fleet.

Read the [chart configuration guide](../charts/searxng-platform/CONFIGURATION.md)
for every value and Secret key, the [capacity envelope](capacity.md) for the
3,000–5,000-user assumptions, and the [GitOps contract](../gitops/README.md) for
the exact three-object delivery unit. Run verification using the commands in
the [development guide](development.md).

## 1. Establish the target and its prerequisites

Use a dedicated application namespace. The delivery tooling accepts namespaces
named `searxng` or `searxng-<suffix>` and release names beginning `searxng-`.
Its Flux objects live in `flux-system`. The application ServiceAccounts do not
mount Kubernetes API tokens.

| Prerequisite | Operator-provided evidence |
| --- | --- |
| Kubernetes/K3s | Supported cluster version, explicit kube context and HTTPS API-server URL, restricted Pod Security support, metrics-server for CPU HPA, and a CNI that enforces ingress **and** egress NetworkPolicy. |
| Worker capacity | At least three eligible CPU-worker hostnames for enterprise profiles, with measured headroom for the selected requests, limits, HPA maxima, and optional browser components. |
| Flux | Installed source-controller and helm-controller, `GitRepository` v1 and `HelmRelease` v2 CRDs, and an existing reconciliation owner for the generated desired state. |
| Network and DNS | Reachable DNS, public search-provider egress, the actual ingress/DNS/monitoring pod labels, and narrow private egress exceptions where needed. |
| Private access and TLS | Real API/browser hostnames, an ingress reachable from the intended network, a trusted certificate covering those hosts, and the matching TLS Secret. LAN-only exposure is a property of the ingress/load balancer/firewall configuration. |
| HA Valkey/Redis | A stable, authenticated TLS endpoint with bounded latency and tested failover; exact routable CIDRs and ports covering every failover destination. |
| Human identity | A trusted HTTPS OIDC issuer, client registration, exact callback URL, permitted email domains and group claim, and client/cookie Secrets. |
| Images and source | A published application image with a real registry digest, read-only image-pull access, and read-only source access to the reviewed commit. |
| Optional operators | Prometheus Operator CRDs for the hardened example; cert-manager or External Secrets Operator only if using those optional prerequisite templates. |

The Redis consumers use ordinary URL-addressed Redis protocol connections. An
HA service must expose a stable endpoint compatible with those clients. Merely
setting `valkey.mode: external` does not configure Sentinel discovery, Redis
Cluster routing, failover, backups, or TLS trust. Custom/private trust roots must
be installed in the relevant images through an explicitly reviewed mechanism;
the chart never disables certificate verification to work around trust failures.

Three workers provide an availability starting point, not a throughput promise.
Enterprise profiles spread replicas across at least three hostname domains with
`DoNotSchedule`. If one worker is lost, surviving replicas can continue, but the
replacement replica needs a third eligible domain. Qualify the sustained target
on the remaining workers and add eligible nodes or adjust measured capacity
where necessary. Three hostnames in one site do not provide site-failure
protection. A real three-zone deployment can select `topology.kubernetes.io/zone`.

## 2. Build and identify the application image

Use an isolated rootless Buildah worker and the exact reviewed commit. The build
script refuses a dirty worktree, labels the image with the source SHA, and does
not publish unless `--push` is supplied. The application repository in the
default chart is an `example-org` placeholder; it is not a published release.

Set `SEARXNG_IMAGE` to the untagged registry repository you control, for example a
repository chosen in your registry project. Authenticate using the worker's
approved credential mechanism, then run:

```bash
SEARXNG_REVISION=$(git rev-parse HEAD)
git status --short
bash scripts/build-image.sh "$SEARXNG_IMAGE"
```

The script names the candidate image `<repository>:<source-SHA>`. When publishing
that reviewed release is authorized, use the same source and command with the
explicit publishing flag:

```bash
bash scripts/build-image.sh "$SEARXNG_IMAGE" --push
cat "artifacts/image-${SEARXNG_REVISION}.digest"
```

Set `mcp.image.repository` to that repository and `mcp.image.digest` to the actual
push result. The digest is not a secret. Retain the source SHA, image digest,
architecture, build evidence, dependency review, and qualification results
together. Build/test the actual platform architecture; this script does not
automatically produce or qualify a multi-architecture image index. Promote the
same verified image digest between environments.

## 3. Prepare credentials without putting them in values

Use the existing secret-management workflow to create the referenced Kubernetes
Secrets. The chart renders no Secret objects and never creates random credentials
during a Helm render. The generated Flux bundle contains nonsecret values, which
must be safe to retain in the deployment repository and Helm release history.

With the default names, the application Secret contract is:

| Secret / key | Content and consumer |
| --- | --- |
| `searxng-platform-secrets` / `principals.json` | Principal document containing high-entropy token digests and explicit scopes for MCP/API. |
| Same / `searxng-secret` | Independent unpredictable SearXNG signing secret, delivered through `SEARXNG_SECRET`. |
| Same / `valkey-url` | `rediss://` URL for both Node gateways in enterprise deployments. Their endpoint and quota prefix must match. |
| Same / `searxng-valkey-url` | `valkeys://` URL consumed by the native HTML backend when browser access is enabled. |
| Same / `session-valkey-url` | `rediss://` URL for OAuth2 Proxy sessions when browser access is enabled. |
| Same / `valkey-password` | Password for the bundled lab Valkey; not required for external mode. |
| `searxng-web-oidc` / `client-secret` | Confidential client credential issued by the OIDC provider. |
| Same / `cookie-secret` | Independently generated, base64-encoded 32 random bytes for the proxy's cookie protection. |
| `searxng-ghcr-pull` / `.dockerconfigjson` | Read-only registry login, Kubernetes type `kubernetes.io/dockerconfigjson`. Change the name for another registry if desired. |
| Optional private settings Secret / `settings.yml` | Engine API keys, authenticated proxy configuration, or other private upstream settings. |

For a bundled lab endpoint only, Node and OAuth2 Proxy use `redis://`, while the
native backend uses `valkey://`. URL-encode credential components; keep complete
URLs in the secret manager. The three URL **keys** are deliberately separate
because Node/OAuth2 Proxy and native SearXNG expect different URL schemes and
session state may use a different database. Endpoint ACLs must allow the runtime's
counter/Lua operations and the session operations used by the proxy. Test them
with the actual clients before activation.

### Issue a scoped principal

The helper writes the raw bearer credential only to a private file and stores
its SHA-256 digest in the manifest. It rejects duplicate IDs and existing token
files. The files below are local credentials; `.secrets/` is ignored by Git.

```bash
umask 077
python3 scripts/create_principal.py \
  --manifest .secrets/principals.json \
  --token-file .secrets/operator-smoke.token \
  --id operator-smoke \
  --scopes mcp:search,api:search \
  --rate-limit 30
```

Grant `mcp:fetch` only to clients that need the configured fetch tools. Add
`--expires-at` with your chosen future RFC3339 UTC expiry when issuing a temporary
credential. Give each service or integration its own principal and an explicitly
sized quota. A shared service credential needs a service workload budget; it does
not receive one quota for each human behind that service. Deliver token files to
their intended owners through the existing secret channel, and store only the
digest manifest in the referenced Kubernetes Secret.

### Choose a Secret delivery mechanism

An existing encrypted-secret or vault workflow is sufficient; installing a new
operator is not required. If External Secrets Operator is already available,
copy [the optional ExternalSecret template](../examples/external-secrets.yaml),
fill the real SecretStore and remote references, and adjust its namespace. The
template uses `external-secrets.io/v1`, explicit key mappings, `OnChange` refresh,
and leaves the Kubernetes Secret intact if the ExternalSecret is removed. Pin
remote versions where the provider supports them. A remote update alone does not
restart these applications: wait for secret reconciliation, then increment the
chart's `secrets.revision`. Follow the operator's
[refresh and lifecycle contract](https://external-secrets.io/latest/api/externalsecret/).

Use one reconciler for each Secret. A retained Secret is not a backup, and deleting
its namespace still deletes it. Keep recoverable encrypted versions independently
of the cluster. The optional prerequisite manifests are not accepted inside the
three-object application delivery bundle.

### Separate source and registry access

Image-pull access and Git source access are independent. Pods need a read-only
registry credential in the **application namespace**, referenced through
`imagePullSecrets`. For a private registry, a Kubernetes Secret can be prepared
from a dedicated Docker-format credential file without placing credentials in a
command argument:

```bash
umask 077
kubectl create secret generic searxng-ghcr-pull \
  --namespace "$SEARXNG_NAMESPACE" \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=.secrets/registry-pull.json \
  --dry-run=client -o yaml > .secrets/registry-pull-secret.yaml
```

The input must contain a credential with pull access only, not the build worker's
publishing credential. For a public image, the operator may deliberately use an
empty `imagePullSecrets` list. See the Kubernetes
[private-registry Secret contract](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/).

Flux source-controller needs its own Secret in **`flux-system`**. For SSH, use a
dedicated read-only repository deploy key and a `known_hosts` file verified
against the Git host's published keys through an independent trusted channel.
A network scan alone does not establish host identity. The native Secret can be
prepared from files:

```bash
umask 077
kubectl create secret generic searxng-git-auth \
  --namespace flux-system \
  --from-file=identity=.secrets/source-deploy-key \
  --from-file=known_hosts=.secrets/source-known-hosts \
  --dry-run=client -o yaml > .secrets/source-git-secret.yaml
```

Register the public deploy key with read access on the actual source repository.
For HTTPS source access, use the appropriate Flux username/password or token
Secret fields instead. Both authenticated and public source URLs must match the
operator's expected repository. Consult Flux's
[GitRepository authentication](https://fluxcd.io/flux/components/source/gitrepositories/)
and, when using GitHub, its published
[SSH host keys](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).

These commands prepare private files only. Apply Secrets through the authorized
credential workflow once their namespaces exist; keep the source Secret and
image-pull Secret out of the public repository and ordinary delivery YAML.

## 4. Complete the site values and TLS/OIDC setup

Copy [the site values template](../examples/site-values.yaml.example) to
`site-values.local.yaml`. Apply it **last** so it overrides the selected capacity
profile or example. Empty required fields intentionally block rendering.

Choose the actual image repository/digest, HA endpoint CIDRs/port, ingress hosts,
TLS Secret, network-policy peer labels, OIDC issuer/client, allowed email domains,
trusted ingress-proxy CIDRs, monitoring selector labels, and any worker placement.
The hardened example requires the `searxng-users` group; replace it with the exact
authorized group claim from your identity provider. Configure group claims/scopes
at the provider, then verify that an unauthorised account is denied.

Use distinct API and browser hostnames. Set `web.baseUrl` exactly to the HTTPS
browser origin and register `<browser-origin>/oauth2/callback` with the OIDC
provider. The issuer and datastore certificate chains must be trusted by the
relevant runtime images. Add a narrow `networkPolicy.extraEgress.web-auth` rule for
a private issuer if necessary: one `ipBlock`, IPv4 `/24` or longer or IPv6 `/64`
or longer, TCP 443. Rules apply only to the component they are listed under.
World, link-local, and metadata prefixes are rejected.

If cert-manager already operates the cluster, [the optional Certificate template](../examples/certificate.yaml)
requests one certificate for the actual enabled hostnames using an existing
issuer. Fill its DNS names and issuer; align `spec.secretName` with
`ingress.tlsSecretName`. Wait for certificate readiness before activation. The
[Certificate API](https://cert-manager.io/docs/usage/certificate/) owns issuance
and renewal; the Helm chart only references the resulting TLS Secret.

The proxy strips incoming identity headers and injects the authenticated session's
user claim. Browser admission rejects a missing identity, hashes it for its shared
per-user quota, and strips it before sending requests to HTML SearXNG. Native
IP-based bot heuristics remain disabled because the backend sees a shared proxy
address. Both browser and machine searches also consume the same deployment-wide
search budget. No client-supplied forwarding header grants a quota identity.

For the hardened example, per-user browser defaults are 30 searches per 60 seconds;
configure `web.admission.userRateLimit` and `userRateLimitWindowSeconds` to match
the site's policy. These quotas are independent of machine-principal request
quotas. A failed datastore rejects admission; replicas do not multiply the shared
quotas. Read the pinned proxy flag rationale in the
[chart guide](../charts/searxng-platform/CONFIGURATION.md#oidc-browser-settings).

## 5. Prepare, review, and activate desired state

The [GitOps guide](../gitops/README.md) contains the executable bundle preparation
and bootstrap commands. Preparation requires the exact clean source commit and
renders the chart before writing the bundle. The default HelmRelease is
**suspended**, allowing source identity, values, namespaces, and prerequisites to
be reviewed before application pods are created.

The bundle embeds the site values, so it is production configuration. Commit the
generated `delivery.yaml` and `kustomization.yaml` to your deployment repository
and apply them through one desired-state owner: a Flux `Kustomization` that points
at the committed directory (an example is in the GitOps guide), or the bootstrap
run from a clean committed checkout. Preparing the bundle with `--service-account`
requires a namespace-scoped ServiceAccount in `flux-system` whose RBAC is provided
by the operator; the [GitOps guide](../gitops/README.md#service-account-and-rbac-required)
has the Role and RoleBinding example.

First validate locally, then use the Ansible playbook in check mode against the
explicit expected API server. The playbook validates object ownership and uses a
server-side diff; it will not adopt foreign-owned Namespace or Flux objects.
Check mode still reads the cluster and asks the API server to calculate the diff.

Applying the suspended bundle creates the application namespace and Flux source/
release objects. It does not create the application workloads. Reconcile the
existing Secrets and optional certificate/operator prerequisites through their
own authorized workflow, confirm source/image access and prerequisite readiness,
then generate and review an **active** bundle for the same source and values.
Apply the reviewed active bundle through the same bootstrap/desired-state owner.
Reapplying unchanged intent should produce no diff; it does not regenerate keys
or change rollout annotations.

## 6. Verify the installed service before moving traffic

Record the source revision reconciled by Flux, the actual image digest(s), config
and secret revisions, replica placement, and dependency versions. Check pod
readiness, PDB/HPA behavior, certificate validity, Redis connectivity, and private
metrics scraping. Readiness alone does not demonstrate useful search results.

Use a small, scoped principal and complete the intended transactions: MCP
initialize/list/search, REST search when enabled, and a real OIDC browser search.
Check denied/missing credentials, missing scopes, wrong groups, quotas, forbidden
origins, and disabling REST while MCP/browser remain enabled. Confirm that the
browser cannot request JSON, choose unbounded engines, or bypass admission via
alternate paths. Test NetworkPolicy from unrelated pods, including attempts to
reach each raw backend and the browser admission service.

The browser's native HTML output, Node gateways, and OIDC proxy are distinct
trust boundaries. Test the full proxy chain with the real CNI and ingress mode;
rendered selectors do not prove observed source addresses or enforcement. Use
the [capacity qualification sequence](capacity.md#qualification-sequence) for
synthetic load, real-provider pilot, one-worker loss, datastore outage, rotation,
and recovery. Preserve evidence of both accepted searches and intentional
rejections. Gateway HTTP 200 responses with empty or unusable results are not a
successful provider qualification.

## 7. Migrate existing consumers deliberately

Inventory any existing raw SearXNG NodePort/Service URL, host-side MCP process,
client configuration, and integrations such as OpenWebUI. Deploy this platform
under distinct resource names and a dedicated namespace while those consumers
continue using their existing endpoint. The chart creates ClusterIP Services and
does not take over a legacy NodePort or existing resources.

Give each machine integration a new scoped principal. Move MCP clients to the
TLS `/mcp` endpoint. Enable REST only for integrations that use its authenticated
`/api/v1/search` contract, then qualify the response mapping and rate budget.
An OpenWebUI installation configured for a native SearXNG `/search` URL is not
automatically compatible with this REST endpoint: verify its installed connector
supports bearer authentication and the response contract, or provide a reviewed
adapter. Do not point it at the raw private backend to bypass the gateway.

Move a bounded consumer cohort first, observe real results and quotas, then
expand. Retain the previous endpoint/configuration as a controlled migration
rollback target until the new path is qualified. Remove the old endpoint, host
process, or NodePort only through the infrastructure repository that owns it,
after every consumer has moved. New Secret references do not rotate credentials
in an independently running legacy service.

## 8. Rotate credentials and signing material

Referenced files and environment variables are loaded at startup. Updating a
Secret alone does not reload every process. Reconcile the new encrypted secret
version, advance the nonsecret `secrets.revision` value, then promote the resulting
bundle so the affected pods roll. Keep the old encrypted version available for
recovery only when it has not been compromised.

For a machine principal, issue a new ID/token while the old principal remains
valid, deploy both digests, migrate that consumer, and then remove the old digest
and roll again. Removing a credential is effective only when all serving replicas
have loaded the updated manifest. Emergency revocation may require a faster
controlled rollout and verification of old-token rejection at every replica.

Create a fresh SearXNG signing secret for migration; do not copy a legacy value
that has appeared in source control. There is no built-in dual-signing-key grace
period, so rotating native signing material can invalidate signed native state.
Rotating the OAuth2 Proxy cookie key can invalidate browser sessions; schedule
reauthentication and test it. Provider client-secret rotation must coordinate the
provider's accepted credentials with the proxy rollout.

Datastore credential changes must keep both gateways on the same quota endpoint
and prefix. Switching or flushing that database resets admission state and may
invalidate sessions. Treat URL/credential changes, endpoint failover, and data
restoration as separate operations with tested recovery, not as incidental edits
to a password string.

## 9. Roll back through the same desired-state path

Retain the previous known-good delivery bundle, source commit, image digest,
nonsecret values, and compatible encrypted secret versions. The configured Flux
upgrade remediation can roll back a failed Helm upgrade, but a successful Helm
health check does not detect every semantic failure. Operator verification still
decides whether to keep the release.

To recover from a functional regression, prepare an active bundle from a clean
checkout of the previous reviewed source and its saved values. Validate the
target, ownership, image availability, and secret compatibility; inspect the
server-side diff; then promote that bundle through the established desired-state
owner. Do not restore a revoked/compromised credential merely to recreate an old
configuration. A previous binary with current compatible credentials may be the
correct rollback; incompatible state may require forward repair instead.

Keep Flux's declaration and live release aligned. An ad hoc `helm rollback` can
be undone by the next reconciliation; use an emergency procedure only when it
also reconciles desired state. Confirm recovery with the same real search/auth
transactions and monitoring window used to detect the regression. Avoid deleting
the application namespace as a rollback: it removes Secrets and any lab PVCs as
well as workloads. External HA state and provider-side configuration are outside
the application's Helm rollback boundary.

## Troubleshooting signals

| Observation | First useful checks |
| --- | --- |
| Enterprise pods Pending | Three eligible hostname domains, node selectors/taints, allocatable resources, quotas, and HPA/PDB settings. |
| Gateway readiness fails | Existing Secret keys, URL schemes, DNS/egress, TLS trust, datastore authentication/ACLs, and backend readiness. |
| Browser repeatedly authenticates or denies everyone | Exact callback/base URL, issuer/client configuration, cookie secret, Redis sessions, email/group claims, proxy strip/inject flags, and ingress trusted-proxy CIDRs. |
| HTTP 429 or 503 under load | Principal/per-user/global admission, local in-flight caps, provider failures, queueing, datastore availability, and node headroom. |
| Search succeeds but results are sparse | Selected engine policy, provider suspensions/CAPTCHA/429, engine prerequisites, native timeouts, category selection, and fallback provenance. |
| ImagePullBackOff or Flux source failure | Actual digest/architecture availability, separate read-only registry/source Secrets, Git host trust, source URL, and commit reachability. |
| Metrics absent | Installed CRDs, Prometheus selectors, namespace/pod selectors, Service endpoints, and the private monitoring NetworkPolicy rule. |

Inspect counts and statuses without dumping Secret contents, Authorization
headers, queries, or fetched pages into incident logs. The chart does not expose
native engine metrics or a public metrics ingress; gateway metrics are one part
of operational evidence.

For `OnChange` external secrets, update the ExternalSecret spec or metadata, wait for Ready, then increment `secrets.revision`. A remote value update alone does not trigger synchronization.
