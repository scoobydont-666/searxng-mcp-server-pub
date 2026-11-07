# Engine inventory and bounded broad search

`config/engine-catalog.json` inventories the configured engines and the additional
implementation modules in SearXNG revision
[`ac11e14c5edf995d4d2f066bfb885a614f52a978`](https://github.com/searxng/searxng/tree/ac11e14c5edf995d4d2f066bfb885a614f52a978).
It describes source configuration, not measured provider availability, contractual
permission, or a claim that every provider accepts organizational traffic.

At this revision the inventory contains **353 configured engine names**, backed
by **227 implementation modules**, plus **25 additional unconfigured modules**
(252 modules in total). The generated broad profile exposes **261 public online
candidates** for bounded selection. Of those 261, **81 are not marked
upstream-disabled** and **180 are marked upstream-disabled**. The disabled
entries stay selectable only after a live probe; the count is not a count of
providers that answered. The remaining configured entries are 17
credential-dependent entries, 5 requiring an endpoint or Tor configuration, and
70 other inactive entries. These classifications overlap with inactive flags:
the complete record preserves every prerequisite.

## Complete inventory, explicit activation

The `engines` array retains every named entry parsed from the pinned upstream
[`settings.yml`](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/settings.yml).
Each record includes categories, implementation, network override, upstream
disabled/inactive flags, credential setting names, activation prerequisites,
public documentation links and the SHA-256 of its implementation source. It does
not copy credential values into this repository.

`unconfigured_modules` includes implementation files that have no active named
entry in that YAML. A commented example or an importable database adapter is not
automatically a deployable public search service. These modules remain visible
for an operator to configure deliberately.

| Classification | Broad-profile treatment |
| --- | --- |
| `public_online` | Included as a selectable candidate, including upstream `disabled: true` engines when no other prerequisite blocks activation. Live-probe before relying on it. |
| `requires_credentials` | Retained in the inventory; excluded until provider credentials, authorized usage and any inactive flag are addressed. |
| `requires_configuration` | Retained; needs an explicit endpoint, Tor egress or another configuration decision. |
| `offline_or_local` | Retained; needs an authorized local dataset/service and its distinct network policy. |
| `inactive` | Retained; upstream chose not to initialize it. Review that reason before activation. |
| `manual_review` | Retained; the static parser cannot establish a safe classification from literal metadata. |

The classification is conservative source analysis. An engine may have several
prerequisites; inspect `prerequisites`, `requires_credentials` and
`upstream_inactive` as well as the primary classification. An inactive provider
does not become usable merely because an API key is supplied.

The builder checks source behavior as well as `about.require_api_key`. The pinned
metadata incorrectly marks some authenticated adapters as not requiring keys;
reviewed corrections cover GitHub code search, Spotify, Tube Archivist,
WolframAlpha and YouTube API. Their required field names are recorded without
values. LibreTranslate's hosted endpoint requires a key even though another
operator-provided instance may allow anonymous use. Optional credentials, such
as a Discourse API key or MyMemory key, do not exclude an otherwise public entry.
YaCy images inherits its endpoint from the named `yacy` engine; the catalog
records that dependency instead of treating its empty local default as a usable
standalone endpoint. The corresponding pinned
[adapter sources](https://github.com/searxng/searxng/tree/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/engines)
remain the authority for these exceptions.

Upstream differentiates `disabled` from `inactive`: disabled engines can remain
available for selection, while inactive entries are not loaded. `keep_only`
filters the actual loaded inventory by **configured engine name**, including
spaces and punctuation. See the pinned
[settings merge documentation](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/docs/admin/settings/settings.rst)
and [engine loader](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/engines/__init__.py).

## Constructor contract for chart examples and runtime

The generated JSON deliberately separates its complete metadata from its
permitted runtime inventory:

- `engines`: full records for all configured names. **Do not enable this array.**
- `activation`: classification-to-name lists for operator review.
- `runtime_policy`: the gateway policy object described below.
- `searxng_settings`: the matching settings fragment containing
  `use_default_settings.engines.keep_only` and explicit `disabled: false` overrides.

`runtime_policy.engines` and the backend `keep_only` list are identical, sorted
lists. The runtime policy has this shape:

```json
{
  "engines": ["all approved selectable names"],
  "categories": {
    "general": {"primary": ["up to four names"], "fallbacks": [["up to four other names"]]},
    "news": {"primary": ["up to four names"], "fallbacks": []},
    "images": {"primary": ["up to four names"], "fallbacks": []},
    "videos": {"primary": ["up to four names"], "fallbacks": []},
    "science": {"primary": ["up to four names"], "fallbacks": []}
  }
}
```

The example above illustrates structure; use the generated real names for
deployment. Every category has one primary pool and at most two fallback pools.
Pools contain at most four engines, are nonempty, and do not repeat a name within
that category's retry chain. A name can occur in another category when its source
metadata supports both categories.

| Request category | Primary engines | Fallback pools, in order |
| --- | --- | --- |
| `general` | `duckduckgo`, `brave`, `bing` | `google`, `qwant`, `yandex`; then `wikipedia` |
| `news` | `bing news`, `brave.news`, `duckduckgo news` | `google news`, `reuters` |
| `images` | `bing images`, `brave.images`, `duckduckgo images` | `google images`, `qwant images`, `yandex images` |
| `videos` | `bing videos`, `brave.videos`, `duckduckgo videos` | `google videos`, `qwant videos` |
| `science` | `arxiv`, `crossref`, `semantic scholar` | `pubmed`, `openalex` |

These names and their category compatibility are checked against the generated
inventory. Wikipedia's default adapter principally produces an infobox, so its
useful-result behavior should be qualified for the consuming client.

The broad profile makes many providers **selectable**; it must not fan every
search out to the full inventory. Runtime enforcement must bound effective
selection, including explicit engine parameters, `!bang` query syntax and any
other upstream selection mechanism. Browser preferences also affect selection;
use a separate bounded UI policy or charge a conservative maximum. A declarative
catalog alone does not enforce these request-time limits.

An important upstream rule is that sending both `engines` and `categories`
**adds all engines in those categories** to the explicit list. A bounded request
must send its selected engine names while omitting `categories` and every
`category_*` parameter. The gateway category chooses a local policy pool; it is
not forwarded alongside the pool. Explicit specialty names remain usable because
SearXNG assigns each selected engine its own first category. See
[`parse_generic` in the pinned web adapter](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/webadapter.py).

Recommended pools are source-compatible starting choices. An unavailable or
blocked primary may fall back to a configured alternative when admission permits;
each attempt consumes the same shared service budget. Partial useful results
should remain visible with engine errors, rather than silently triggering every
fallback. No provider throughput or availability claim is inferred from this
list.

To activate a credential-backed or custom endpoint engine, review its
prerequisites, provision credentials through the deployment's secret-backed
configuration mechanism, update the actual SearXNG inventory **and** runtime
allowed names together, and add a bounded pool only after a low-rate live probe.
Do not store provider secrets in the catalog, a values file, a ConfigMap or a
rendered HelmRelease. Engine-specific token gates are distinct from service/API
authentication.

## Transparent identification and blocked-provider alternatives

For SearXNG engine requests, configure `outgoing.useragent_suffix` with the service
identity and a real operator contact URL. This suffix is used by engines that
call SearXNG's user-agent helper; engine-specific requests may manage their own
headers. It is not a guarantee that every upstream HTTP request has identical
headers. See the pinned
[outgoing settings](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/docs/admin/settings/settings_outgoing.rst).

For example, the pinned Google adapter explicitly supplies a mobile browser
user-agent and a curl impersonation option; DuckDuckGo also sets a user-agent in
its token acquisition path. A global suffix cannot override every adapter's
protocol behavior. This repository guarantees a fixed service identity for the
gateway's direct page/feed requests and configures a service suffix where native
SearXNG adapters honor it. It does not claim uniform identification across all
261 native candidates. See the
[Google adapter](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/engines/google.py)
and [DuckDuckGo adapter](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/engines/duckduckgo.py).

For direct page/feed fetching, use the gateway's fixed transparent service
user-agent. A challenge response should produce a visible blocked-provider
outcome and a bounded switch to an authorized alternative. Do not impersonate a
browser, replay challenge cookies, or rotate identities to circumvent a block.

Useful alternatives are explicit provider APIs and published feeds. The catalog
records `uses_official_api` and `official_api_documentation` from the source, so
operators can prefer an API when the provider offers one. Examples include:

- SearXNG's `braveapi` and `exaapi` implementations require separately provisioned
  provider credentials; they stay out of automatic activation.
- `arxiv`, `crossref`, `pubmed`, `openalex` and `semantic scholar` expose useful
  research-oriented sources. Their documented rate limits and any optional
  identity/contact fields still apply.
- Published RSS/Atom feeds can substitute for a blocked site's browsing surface
  when a specific feed URL is approved for that domain. A feed is a separate
  declared source; it must not become an arbitrary redirect or URL-fetch bypass.

Source references: [Brave engines](https://docs.searxng.org/dev/engines/online/brave.html),
[Exa API engine](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/engines/exaapi.py),
[arXiv implementation](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/engines/arxiv.py),
[Crossref implementation](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/searx/engines/crossref.py),
[OpenAlex documentation](https://docs.searxng.org/dev/engines/online/openalex.html).
Provider fallback and feed fetching remain subject to the same authentication,
SSRF rules, domain allowlists, deadline/byte limits, shared budgets and audit
redaction as the original request.

## Reproduce and validate

The builder reads the pinned YAML and Python **as data**. It uses `ast` to inspect
literal metadata; it never imports or executes an engine and never sends a search
request to any provider. Network mode reads only the official GitHub source
directory and raw files, bounds each response, and checks each module against its
pinned Git blob identity. The settings file has an independently fixed SHA-256.
The canonical filename-to-Git-blob manifest also has a fixed SHA-256, so an
offline source cache cannot silently add, remove or substitute implementation
files. Literal `EngineAbout(...)` keyword fields are interpreted as data, without
calling their constructor.
There is no timestamp in the generated JSON, so identical source produces
identical bytes.

```bash
# Regenerate from the exact upstream commit; optional cache is scratch data.
python3 scripts/build_engine_catalog.py --cache-dir /tmp/searxng-catalog-source

# Repeat with source verification and require identical checked-in bytes.
python3 scripts/build_engine_catalog.py --cache-dir /tmp/searxng-catalog-source --check

# After the cache has been populated, regenerate and compare without any network.
python3 scripts/build_engine_catalog.py --cache-dir /tmp/searxng-catalog-source --offline-cache --check

# Fast offline CI check of catalog, pools and matching backend/runtime inventory.
python3 scripts/build_engine_catalog.py --validate

# Fully offline regeneration from an existing clean, pinned upstream Git checkout.
python3 scripts/build_engine_catalog.py --source-dir /path/to/pinned/searxng --check
```

`--validate` proves the internal configuration contract, not upstream source
freshness or provider health. `--check` regenerates from the declared revision.
CI can compare the broad example's engine lists and pools to this committed JSON
and run `--validate` without downloading any engine modules. To independently
reproduce the classification, use a previously populated verified cache with
`--offline-cache --check`, or a clean pinned upstream checkout with `--source-dir`.
Updating the revision requires updating the expected settings hash, reviewing
classification changes and provider prerequisites, regenerating examples, and
rerunning both configuration and low-rate service qualification.
