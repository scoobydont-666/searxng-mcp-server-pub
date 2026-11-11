# Security model and reporting

Use the repository host's private vulnerability-reporting feature when enabled,
or a maintainer-approved private channel. Do not put credentials, private host
names, customer queries, personal identities, or exploitable deployment details
in public issues. This repository does not publish a personal contact address.

## Trust boundaries

Machine requests require scoped bearer keys. Only key hashes reach the server
manifest. Browser identity comes from the configured OIDC provider through the
pinned OAuth2 Proxy. The browser guard rejects missing or malformed identity and
uses a hash for per-user quota keys. Its identity header is trusted only because
NetworkPolicy restricts guard ingress to the proxy and the proxy strips inbound
header values before injecting the authenticated session claim.

The required OAuth2 flags include `--pass-user-headers=true` and
`--skip-auth-strip-headers=true`. The second flag's name is counterintuitive:
false preserves request values in the pinned implementation. Do not reverse it.
Identity, OAuth cookies, authorization, and forwarding headers are not sent to
the native search backend. Native IP bot heuristics are disabled; authenticated
user quotas and the aggregate search budget replace those proxy-incompatible
heuristics. The cluster's CNI must actually enforce the rendered policies.

The machine JSON backend and browser HTML backend are separate services. API
disablement does not expose native JSON on another route. Autocomplete, image
proxying, favicon proxying, raw configuration, native statistics, and arbitrary
backend paths are denied by the browser guard. Queries cannot use engine bangs,
category cookies, or inline timeout controls to expand a policy pool.

Every actual search attempt uses an atomic shared Valkey admission counter.
Counter-store errors reject work. Principal and user quotas are separate from
the service budget. Authenticated operators can configure trusted upstreams and
private engine credentials; ordinary clients cannot choose arbitrary backend
URLs or supply private engine settings.

## Public fetch tools

Fetch requires a nonempty hostname allowlist. HTTP(S) destinations must use ports
80 or 443 and cannot embed credentials. Every redirect is rechecked, HTTPS
downgrades are denied, and sensitive headers are removed across origins. DNS
answers are checked at connection time and the connection uses those exact
answers; private, loopback, link-local, metadata, reserved, and common address
translation ranges are denied. NetworkPolicy adds a separate public-egress
boundary. Wildcard domain entries still require this DNS/IP validation.

These controls do not make fetched content trustworthy. Treat search snippets,
pages, PDFs, and feeds as untrusted data, including when an agent consumes them.
Do not execute instructions embedded in retrieved content. There is no browser
session automation, access-control bypass, CAPTCHA solver, or identity-rotation
system. Alternative feeds are separately identified public sources.

Response byte caps, deadlines, concurrency, bounded retries, and read-only,
non-root containers limit resource use. PDF/HTML parsing can still be CPU and
memory intensive within those limits; qualify extraction separately from search.
Per-process fetch limits multiply with replicas. The shared search counter is
separate from the deployment-wide outbound-fetch quotas. Neither is a provider
license or a substitute for that provider's limits.

The current `pdf-parse` dependency bundles PDF.js 1.10.100; npm audit does not
inventory that embedded copy separately. It contains older code covered by the
[PDF.js advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq).
The application extracts text with `getTextContent` and does not invoke canvas
rendering; exploitation of that advisory through this text-only path has not
been demonstrated by this review. Migrating to a maintained parser still needs
qualification. Worker threads bound execution time and heap use; they are not
an operating-system sandbox for filesystem or network access. See the
[full review](docs/reviews/2026-11-11-full-review.md) for the remaining work.

## Secrets and telemetry

Keep signing keys, tokens, OIDC credentials, datastore URLs, private settings,
and registry/Git credentials in an encrypted secret workflow. The chart renders
references, not Secret bytes. Secret changes require `secrets.revision` rollout.
Existing external datastore endpoints should use authenticated TLS and a stable
HA endpoint; Sentinel discovery and Redis Cluster are not implemented clients.

Application metrics use fixed route/status/rejection classes, not queries,
tokens, identities, or arbitrary URLs. Configure ingress and platform logging to
omit request bodies, query strings, auth headers, and cookies. Counter retention
is bounded by TTL; no shared search-result cache or training-data pipeline is
enabled. Platform log retention and privacy policy belong to the operator.

Security changes require regression tests for the affected boundary and fresh
independent review of the candidate commit. [Publication checks](docs/publication-boundary.md)
are separate from runtime security and do not prove absence of all sensitive data.
