# Verified public upstream inputs

The following pins and primary references describe public upstream software.
Site-specific configuration and deployment history are not publication inputs.


| Input | Verified identity on November 6, 2026 |
| --- | --- |
| SearXNG source | [`ac11e14c5edf995d4d2f066bfb885a614f52a978`](https://github.com/searxng/searxng/commit/ac11e14c5edf995d4d2f066bfb885a614f52a978) |
| SearXNG OCI index | `ghcr.io/searxng/searxng:2026.11.6-ac11e14c5@sha256:c750ee1d859b26d3aeae51c07f6a48c3a0bfbaa9195d71a18b258862d88c4c3c` |
| Valkey OCI index | `docker.io/valkey/valkey:9.0.0-alpine@sha256:bef37d06d4856710973ee31dd1eac1482e4c8e6e7b847f999ad25433e646587b` |
| OAuth2 Proxy OCI index | `quay.io/oauth2-proxy/oauth2-proxy:v7.15.6@sha256:c3415e8660af553f5e18f5d90db050614c02493c0ac6260ac59442f6d9b12048` |
| Node build/runtime OCI index | `docker.io/library/node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d` |
| Helm verification tool | `v3.19.0`, Linux amd64 archive SHA-256 `a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496` |
| Checkout action | `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (`v4.2.2`) |

Digests were resolved from actual registry manifests, not derived from source
commit hashes. Registry resolution does not prove image startup or vulnerability
clearance; those are release/cluster qualification checks.

Primary references used for design:

- [SearXNG search API](https://docs.searxng.org/dev/search_api.html): both `/` and
  `/search`, GET and form POST; disabled output formats return 403. Native JSON
  must stay available internally while the separate external API flag is off.
- [Pinned native IP limiter](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/botdetection/ip_limit.py):
  its API-specific IP quota is unsuitable for an aggregate MCP gateway. Native
  IP limiting is not a substitute for principal/global admission.
- [Current Granian deployment](https://docs.searxng.org/admin/installation-granian.html)
  and [pinned container](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/container/Dockerfile):
  Granian replaces obsolete uWSGI tuning; writable cache/config paths and runtime
  identity are reflected in the chart.
- [Settings surface](https://docs.searxng.org/admin/settings/settings.html),
  [outgoing settings](https://docs.searxng.org/admin/settings/settings_outgoing.html),
  [engine catalog](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/settings.yml):
  preserve arbitrary upstream configuration while enforcing the deployment's
  secret, transport and format invariants.
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports):
  Origin validation, authentication, and optional sessions; stateless transports
  still require isolated server/transport lifecycles.
- [OAuth2 Proxy v7.15.6 configuration](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/docs/docs/configuration/overview.md)
  and [health endpoints](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/docs/docs/features/endpoints.md):
  explicit trusted proxies, nonce checking, Redis sessions, `/ready` store checks.
