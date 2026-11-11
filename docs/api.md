# API, MCP, and access policy

Machine access uses high-entropy bearer credentials. Browser access uses the
separate OIDC interface. OIDC browser sessions are not machine API credentials.
The platform does not implement an OAuth authorization server for MCP clients.

## Independent enable switches

| Helm value | Runtime environment | Default |
| --- | --- | --- |
| `mcp.enabled` | `SEARXNG_MCP_ENABLED` | true |
| `mcp.apiEnabled` | `SEARXNG_API_ENABLED` | false |
| `mcp.fetchEnabled` | `SEARXNG_MCP_FETCH_ENABLED` | false |
| `mcp.allowedOrigins` | `SEARXNG_MCP_ALLOWED_ORIGINS` | No browser origins allowed |
| `mcp.allowedDomains` | `SEARXNG_MCP_ALLOWED_DOMAINS` | Empty; fetch cannot be enabled until supplied |

An absent Origin header is allowed for authenticated machine clients. A present
Origin must exactly match the allowlist. No wildcard-origin default is used.
Disabling a protocol returns 404 for its route and removes that Ingress route.
JSON output remains enabled internally because MCP needs it; the native JSON
service has no public Ingress and the browser backend allows only HTML.

## Fetch limits, errors and the admin listener

| Runtime environment | Default | Effect |
| --- | --- | --- |
| `SEARXNG_MCP_FETCH_PRINCIPAL_RATE` | 120 (chart: 60) | Outbound fetch attempts per principal per quota window (retries and alternatives count) |
| `SEARXNG_MCP_FETCH_SHARED_RATE` | 600 (chart: 1200; must be at least 10x the per-principal rate) | Outbound fetch attempts per window across all principals |
| `SEARXNG_MCP_FETCH_BUFFER_BYTES` | 64 MiB | Process-wide budget for buffered fetch bodies; must be at least the per-fetch maximum |
| `SEARXNG_MCP_HTML_PARSE_MAX_CHARS` | 2 MiB | HTML above this is reduced to plain text without building a DOM |
| `SEARXNG_MCP_PARSE_WORKERS` / `SEARXNG_MCP_PARSE_HEAP_MB` | 2 / 256 | Worker threads that parse HTML, feeds and PDFs, and each worker's heap limit; a worker past its deadline is terminated |
| `SEARXNG_MCP_FETCH_PRINCIPAL_CONCURRENCY` | 2 | Concurrent buffered fetches and parse jobs per principal; others queue without blocking other principals |
| `SEARXNG_MCP_ADMIN_BIND_HOST` / `SEARXNG_MCP_ADMIN_PORT` | 127.0.0.1 / 8528 | Listener for `/health`, `/ready` and `/metrics`; these paths return 404 on the API port |
| `SEARXNG_MCP_LOG_LEVEL` | info | `debug` adds a per-fetch line with host and a principal digest |

`SEARXNG_MCP_GLOBAL_RATE` (chart `mcp.fetch.globalRate`) is a per-pod outbound
token bucket, so total egress scales with the replica count; the fetch quotas
above are the deployment-wide limits. `fetch_batch` accepts at most 5 URLs. Every fetch denial or network failure is
returned as `fetch_failed`; the specific reason is logged server-side only.
Fetch quota exhaustion returns HTTP 429 (`fetch_rate_limit_exceeded` or
`fetch_capacity_exhausted`), and an unavailable quota store returns 503. Size
the pod memory limit for the buffer budget plus the worker heaps.

## Credential manifest

`SEARXNG_MCP_PRINCIPALS_FILE` points to a mounted JSON Secret with this shape:

```json
{
  "principals": [
    {
      "id": "research-agent",
      "token_sha256": "<64 lowercase hexadecimal characters generated from the key>",
      "scopes": ["mcp:search", "mcp:fetch", "api:search"],
      "rate_limit": 120,
      "expires_at": "2027-12-01T00:00:00Z"
    }
  ]
}
```

The angle-bracket digest above is documentation, not an accepted value. Use
`scripts/create_principal.py` to create a random 256-bit token and valid digest.
It writes the key and manifest with mode 0600, serializes concurrent manifest
updates, refuses duplicate identities, and does not print the key. The optional
expiry uses UTC RFC3339 notation. Store the raw token only in the client's secret
manager; give the server the digest manifest. At most 10,000 principals are
accepted. Duplicate IDs, duplicate digests, unknown scopes, empty manifests, and
invalid files fail startup.

Scopes are independent. `search_and_extract` requires both MCP scopes. Tools
without the necessary grants are omitted from discovery and rejected on calls.
`api:search` does not grant URL fetching. An older `SEARXNG_MCP_TOKEN` can be used
temporarily as a single all-scope legacy principal; prefer the manifest for
deployment and revoke the legacy token after migration. Missing credentials
never enable anonymous access.

To rotate: issue a new ID/key, add it to the encrypted manifest, roll out by
incrementing `secrets.revision`, move the client, remove the old principal, and
roll out again. Removing a principal does not affect already running requests;
the short request deadline bounds their lifetime. Do not leave legacy keys
configured after the migration window. To revoke all access, disable the
interfaces or remove network exposure while replacing the manifest.

## REST search

`POST /api/v1/search` accepts JSON; `GET` accepts the same fields as query
parameters. Prefer POST to keep query text out of ordinary URL access logs.

```http
POST /api/v1/search
Authorization: Bearer <key supplied by the client's secret manager>
Content-Type: application/json

{"q":"distributed systems","category":"science","max_results":5}
```

| Field | Accepted values |
| --- | --- |
| `q` | Required nonblank string, at most 2,048 characters |
| `category` | `general`, `news`, `images`, `videos`, `science`; default general |
| `max_results` | Integer 1–50; default 10 |
| `page` | Integer 1–5; default 1 |
| `language` | Bounded language tag such as `en` or `en-US` |
| `time_range` | Empty, day, week, month, or year |
| `safesearch` | 0, 1, or 2; default 0 |
| `engines` | Optional comma-separated string or array of one to four configured engine names |

Unknown fields, arbitrary upstream URLs, formats, plugins, cookies, and timeout
overrides are not accepted. Explicit engine choices do not silently substitute
a different source. Omit `engines` to use the category's primary and alternate
pools. Specialty catalog entries can be selected explicitly. Category selection
is local policy; only the bounded explicit engine list is sent to SearXNG.

The response contains `query`, `category`, `returned`, `results`, `partial`, and
`search_policy`. Each result has a title, HTTP(S) URL, snippet, engine, and score.
For example, a successful fallback reports:

```json
{"search_policy":{"attempts":2,"fallback_used":true,"engines":["pubmed","openalex"],"fallback_reason":"http_403"}}
```

HTTP 200 can contain no results. `partial` indicates unresponsive engines in the
returned pool. Use content-aware success checks, not only HTTP status.

## MCP

Use an MCP client that supports authenticated Streamable HTTP and configure the
HTTPS `/mcp` URL with an Authorization bearer header. The endpoint is stateless:
each request receives an isolated SDK server/transport, with no sticky session
requirement. Send protocol initialization according to your SDK, then discover
tools and invoke one. A `tools/call` request body is:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"web_search","arguments":{"query":"distributed systems","max_results":5}}}
```

The MCP search field is `query`; the REST field is `q`. MCP `engines` is a
comma-separated string. Tool responses contain JSON as text content, including
source-engine and fallback metadata. Search bangs and inline numeric timeout
directives are rejected so a query cannot expand the configured pool.

The protocol reference is the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).
The native [SearXNG search API](https://docs.searxng.org/dev/search_api.html) is an
internal upstream, not the public API contract of this repository.

## Budgets, errors, and alternatives

Every authenticated machine request, including discovery and initialization,
consumes the principal's fixed-window quota. Browser searches consume a separate
per-authenticated-user quota. Every actual backend search attempt consumes the
shared deployment search budget. The quotas fail closed if Valkey is unavailable.
These counters are admission controls, not billing records or rolling-window
guarantees. Separate process-local in-flight and fetch limits multiply with
replica count; the shared search quota does not.

Typical HTTP errors are 400 for invalid input, 401 for invalid/expired credentials,
403 for denied scope/origin, 404 for disabled routes, 413 for oversized requests,
429 for exhausted quota, 502 for unavailable search pools, 503 for overload,
drain or quota-store failure, and 504 for the total request deadline. MCP tool
errors may instead be represented in protocol tool-result/error content. Respect
Retry-After and use bounded client backoff; do not immediately retry rejected work.

Search fallback switches pools on 403, 429, 503, attempt timeout, or empty results
with unresponsive-engine diagnostics. It does not treat an ordinary empty result
as a failure. Browser fallback handles blocking statuses and timeouts before
headers; it does not parse HTML to guess whether an individual engine failed.

Fetch fallback uses exact configured publisher rules and at most two official
RSS/Atom/API alternatives. It never forwards the original page's credentials or
query string to an alternative. A same-origin 429 does not cause an immediate
retry on a different path. HTML challenges, malformed feeds, API error payloads,
and truncated alternatives are not reported as successful feed retrieval.

When a primary GET has an eligible alternative, the fetcher cancels the blocked
page's body as soon as its headers arrive, without reading it or reserving a
body buffer. Fallback can proceed even when the challenge stalls or only one
body fits in the configured budget. If all alternatives fail, the original
HTTP status and final URL are returned with an empty body, `bytes: 0`, and
`truncated: true` when an unread body stream was discarded. Eligibility continues
to use the originally requested publisher URL through redirects.

Without an eligible alternative, the bounded original body is retained.
Blocking responses are previewed up to the smaller of the configured cap and
64 KiB, then cancelled immediately and marked truncated. This conservatively
includes bodies that reach the preview limit exactly. A large declared size
does not prevent returning that preview. Non-GET requests never use alternatives.

An alternative result includes `alternative.original_url`, `original_status`,
the actual alternative URL/name/kind, and
`semantics: "alternative_source_not_original_page"`. Consumers must retain this
provenance. Metadata, a publisher feed, and a question API response are not
interchangeable with the original full page. Authentication failures do not
trigger alternative-source access.

PDF extraction succeeds only when every declared page was loaded and its text
extraction completed. A blank or image-only page is valid. If the underlying
parser suppresses a page error, `fetch_pdf` returns the existing sanitized
`pdf_parse_failed` error instead of presenting incomplete text as a full result.
