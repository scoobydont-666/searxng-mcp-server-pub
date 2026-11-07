# Capacity envelope for 3,000–5,000 users

**Status: proposed capacity envelope; not a measured throughput claim.** User
count is registered population. It does not mean 5,000 simultaneous searches.
Run `python3 scripts/capacity.py` to reproduce or change the assumptions.

## Workload and budgets

| Input or calculated demand | 3,000 users | 5,000 users |
| --- | ---: | ---: |
| Searches per person per working day (assumed) | 20 | 20 |
| Daily interactive searches | 60,000 | 100,000 |
| Average QPS over an 8-hour active day | 2.08 | 3.47 |
| Busy population: 10% active, one search every 30s | 10 QPS | 16.67 QPS |
| Reserved agent/API demand (assumed) | 5 QPS | 5 QPS |
| Busy combined demand | 15 QPS | 21.67 QPS |
| Initial sustained qualification target | 20 QPS | 25 QPS |
| Separate short burst qualification target | 50 QPS | 50 QPS |

Human and machine traffic share a bounded service budget. Individual API/MCP
quotas do not entitle every principal to consume its full quota simultaneously.
The deployment-wide search limit is enforced at the actual backend search call,
including retries. Scaling the gateway must not multiply that limit. Rate windows
are admission controls, not billing-grade counters; adjacent windows can create a
short boundary burst. A Valkey failure rejects search work instead of removing
the quota. CPU autoscaling cannot create upstream provider capacity.

Agent demand deserves its own variable: 100 concurrent agents each issuing five
searches every 30 seconds adds **16.67 QPS**, which is larger than the 5-QPS reserve
above. Increase an authorized provider budget before increasing the shared limit;
do not just add replicas.

At an illustrative four engine invocations per search, 20/25/50 search QPS means
roughly 80/100/200 engine invocations per second before retries, pagination,
autocomplete or extraction. This is a scenario, not an exact network-rate bound.
The managed gateways restrict effective selection to four engines per attempt,
including query syntax and browser preferences. At most three distinct pools are
attempted per query; every attempt consumes the same shared budget. An engine
may perform more than one HTTP transaction. Recalculate with `--engines` when
changing the selected pool size.

The upstream [limiter documentation](https://docs.searxng.org/admin/searx.limiter.html)
describes provider blocking and CAPTCHA pressure. The
[outgoing settings](https://docs.searxng.org/admin/settings/settings_outgoing.html)
control timeouts/retries/connections. Use approved upstream APIs or permissions
where sustained organizational traffic requires them. Adding replicas behind the
same egress IP does not increase a provider's allowance. Do not use proxy rotation
as a substitute for provider authorization.

## Initial resources to validate

The profiles reserve capacity for three gateway and three search replicas. The
chart is the exact resource source of truth; these are planning ranges:

| Layer | Starting replicas | Per-pod requested CPU/RAM | Expansion and reason |
| --- | ---: | --- | --- |
| MCP/API gateway | 3 | approximately 0.5–1 CPU, 512 MiB–1 GiB | HPA with bounded per-pod inflight work; extraction increases CPU/RAM sharply. |
| SearXNG JSON backend | 3 | 1 CPU/1 GiB for 3k; 2 CPU/2 GiB for 5k | 1 Granian worker/pod; bounded thread concurrency; HPA only inside the shared provider budget. |
| Optional human UI search | 3 when enabled | 1 CPU/1 GiB for 3k; 2 CPU/2 GiB for 5k | Separate HTML-only surface and admission, so external API disabling remains meaningful. |
| Optional OIDC proxy and UI admission | at least 2–3 | additional explicit requests in chart | Human SSO sessions and aggregate budget enforcement; include these in node planning. |
| Production Valkey | external HA endpoint | size/placement owned by platform | Shared counters and optional SSO sessions. In-chart singleton is a lab option only. |

At two-second mean search latency, 20/25/50 QPS holds roughly 40/50/100 searches
in flight. With three SearXNG pods, four blocking threads per pod cannot support
that envelope if each search occupies a thread for its full duration. Start with
one worker and an explicit 16–32 blocking threads per pod; measure actual CPU,
memory and queueing. The [Granian guide](https://docs.searxng.org/admin/installation-granian.html)
warns against indiscriminately increasing worker count.

Use at least three independently schedulable workers for one-node-loss tests.
The minimum reservation is not the maximum: sum all HPA maxima, sidecars/init
containers, observability and optional UI requests, then prove the required
service level still fits on N−1 nodes. Keep CPU search work within dedicated placement and quotas; this workload
requires no GPU. A starting pool of three general-purpose workers with 8 vCPU and 16 GiB
each is a **candidate lab envelope**, not a guarantee that every optional maximum
fits or that the same envelope fits every provider mix.

No dollar estimate is asserted because hosting, existing spare CPU capacity,
provider contracts, IdP and HA Valkey ownership have not been specified.

## Qualification sequence

1. Run `make check`: runtime behavior, chart profiles, invalid-value guards,
   secret handling, deterministic render, and bootstrap syntax/scope.
2. Build the actual OCI artifact, record its source SHA and registry digest, and
   render enterprise values with that digest. Run the container with a read-only
   root filesystem, the chart's UID/GID and mounted Secrets.
3. Install in a disposable K3s namespace. Server-side dry run and first apply,
   identical second apply, rollout, interruption and recovery are distinct
   checks. Verify the CNI actually blocks bypass from an unrelated pod.
4. Use `load/mock-searxng.mjs` or an equivalent isolated fixed-latency backend,
   with no calls to public search engines. Run the 3k profile at 20 QPS and the
   5k profile at 25 QPS for 15 minutes. Run 50 QPS for two minutes with an explicit
   50-QPS test budget. Include 0.5–5s backend delays, 503s and large responses.
5. Run a separately budgeted, low-rate live provider pilot. Validate nonempty,
   relevant results, per-engine failures, CAPTCHA/429 and partial results. A
   gateway HTTP 200 alone does not prove search quality.
6. Kill one application pod and then one worker in staging; interrupt Valkey;
   revoke/rotate a key; disable the external API while MCP remains available;
   test each CORS/SSRF/control bypass and verify recovery.

Example synthetic gateway command (the token is supplied through the environment):

```bash
SEARCH_SYNTHETIC=true SEARCH_QPS=25 SEARCH_DURATION=15m \
  SEARCH_PROTOCOL=mcp k6 run load/search.js
```

Also supply `SEARCH_BASE_URL` and `SEARCH_TOKEN`. The principal's protocol request
quota must exceed the test load without disabling the shared search budget.
Run `SEARCH_PROTOCOL=api` separately with the API enabled, and run the MCP SDK
initialize/list/search smoke transaction separately from the arrival-rate test.
The load script does not store queries, tokens or identities as metric labels.

**Proposed acceptance:** at least 99% successful admitted searches, gateway p95
under 5 seconds and p99 under 10 seconds for the specified healthy synthetic
upstream mix; no dropped iterations, OOMs, unbounded queues or restart loop;
identical quota across one and three gateway replicas. Intentional denials are
counted and tested separately, never silently subtracted from overload results.
Measure live-provider latency separately because external engines determine much
of it. Record tested source/image/config, hardware, results, errors and provider
permissions alongside the result.

## Observability and data retention

Collect request rate, latency, admission rejections, active work, upstream status,
empty/partial results, pod resource use, restarts, HPA saturation, endpoint health,
Valkey latency/failover and provider failures. Native per-engine metrics require
the upstream metrics configuration and protected scrape credentials; do not claim
gateway request metrics alone are complete provider observability.

There is no result-cache layer enabled by default. Avoid sharing sensitive query
results across principals accidentally. Valkey counters expire and are not an
audit archive. Use bounded platform log/metric retention; no query text, fetched
page content, Authorization headers or raw API keys belong in telemetry. A
separate privacy review is required before repurposing search contents.
