# Full repository review — 2026-11-11

## Verdict and scope

**Production-readiness gate: not passed.** The repository has substantial working
security and deployment controls, and this PR corrects reproduced defects. A
source review and passing CI do not establish a production installation. The
embedded PDF parser and the deployment qualification tasks below remain open.

Reviewed baseline:
[`486b9fe6c4b6887ca02b3f57ee669896a2827ffe`](https://github.com/scoobydont-666/searxng-mcp-server-pub/commit/486b9fe6c4b6887ca02b3f57ee669896a2827ffe).
At the start of review, the repository was public, had one root commit, one
successful initial workflow run, and no open PRs. Its 128 tracked files included
generated engine inventory and monitoring schemas; those generated data sets
were checked through their validators, not treated as hand-reviewed engine code.

The review covered runtime entry points, authentication and scopes, MCP/REST
contracts, outbound fetching, quotas, parsing, browser admission, chart templates
and values, Flux/Ansible delivery, credential tooling, dependencies, CI, licensing,
publication controls, and operational documentation. Separate review sessions
examined runtime, deployment, and release concerns. The release reviewer prepared
an isolated dependency-upgrade experiment and is a contributor to that change.
Final independent review must come from the nonauthor runtime and deployment
reviewers; the PR records their reviewed revision and conclusions.

## Findings corrected in this PR

Severity describes the affected boundary. Advisory severity is not proof that
the production API exposes an exploit.

| ID | Severity / boundary | Baseline finding | Correction and evidence |
| --- | --- | --- | --- |
| R1 | Medium — availability | `safeFetch` retained a blocked response's principal permit and bytes while trying alternatives that needed those resources. A single permit, a one-body budget, concurrent blocked requests, or a stalled challenge could starve a healthy alternative. Large declared challenges could also prevent fallback. | Cancel eligible primary bodies at headers without reserving their bytes or permits. Preserve original status metadata if all alternatives fail. Bound and cancel other blocking previews at their limit. Regressions cover contention, oversized and stalled challenges, redirects, failed alternatives, and ineligible rules. |
| R2 | Medium — cancellation | `ParsePool.run` checked cancellation before awaiting a permit, then installed an abort listener without checking again. Cancellation during the await was lost. | Check cancellation again in `enqueue`. The regression aborts immediately with principal limiting enabled, verifies no worker was created, and confirms subsequent work succeeds. |
| R3 | Medium — extraction integrity | `pdf-parse` silently substitutes empty text for page failures while reporting the planned page count. A damaged two-page PDF was accepted with only first-page text. | Count successful page extractions and require the count to match the positive declared page count. Real PDFs cover complete, blank, and missing pages. An MCP test checks sanitized failure and released buffer reservations. |
| D1 | High — development tooling | Full npm audit flagged five packages through Vitest 1.6.1. CI audited only production dependencies. The audit classified Vitest/Tinypool critical, Vite high, and Vite-node/esbuild moderate. | Pin Vitest 5.1.0 and Vite 8.3.8, regenerate the lock, remove obsolete `--minWorkers`, and include development dependencies in CI audit. Full audit now reports zero; production dependency identities are unchanged. |
| D2 | High — deployment tooling | Ansible Core 2.19.3 was affected by the malicious Galaxy role argument-injection advisory and predated later security fixes. | Update within the same minor series to 2.19.15 with official hashes. Fresh hash-enforced installation, lock tests, and playbook syntax pass. The other 14 Python distributions are unchanged. |
| P1 | Medium — publication guard | The email exemption accepted unrelated domains whose names ended in an example domain, missing possible private addresses. | Require an exact domain or dot-delimited subdomain and normalize case. Negative tests fail before the fix and pass afterwards. No actual private email leak was found. |
| P2 | Medium — attribution | The runtime recipe omitted the application license/notices and the full Apache license for PDF.js bundled inside the MIT-licensed `pdf-parse` wrapper. | Copy `LICENSE`, `NOTICE`, and `licenses/` into the image and identify embedded PDF.js in `NOTICE`. The recipe was inspected; an actual image build remains open. |

Implementation and regression locations:

- R1: [fetch client](../../src/utils/fetch-client.ts), [feed tests](../../tests/feed-integration.test.ts), [API compatibility note](../api.md).
- R2: [parser pool](../../src/utils/parse-pool.ts), [worker tests](../../tests/parse-pool.test.ts).
- R3: [document parser](../../src/utils/document-parser.ts), [PDF tests](../../tests/document-parser.test.ts), [MCP tests](../../tests/fetch-budget.test.ts), [PDF generator](../../tests/fixtures/pdf.ts).
- D1/D2: [npm manifest](../../package.json), [npm lock](../../package-lock.json), [Python lock](../../requirements-iac.txt), [CI](../../.github/workflows/validate.yaml), [test helper](../../scripts/test_with_valkey.py).
- P1/P2: [scanner](../../scripts/check_publication.py), [scanner tests](../../tests/iac/test_publication.py), [container recipe](../../Containerfile), [notices](../../NOTICE).

### Reproduction and compatibility

R1 was reproduced with a healthy HTTP 200 alternative behind a blocked primary.
With one principal permit, or a byte budget equal to the body cap, the baseline
returned the original HTTP 403 after the alternative deadline. A larger-budget
positive control returned the identical alternative successfully. Concurrent
blocked requests reproduced contention under the default two permits. The fix
preserves the safety budgets rather than increasing them.

Independent review of the first candidate found that a challenge filling the
preview cap exactly could still stall before fallback. Additional failing-before
tests covered declared and unknown lengths with zero bytes, half the cap, and
exactly the cap, plus a redirected primary and previews without matching rules.
The final correction cancels eligible primary bodies immediately after headers
and cancels other blocking previews as soon as they reach the cap. Nine new
failure-path cases failed before that correction and passed afterwards; a
same-origin HTTP 429 control preserves the original body and avoids fallback.

The intentional API change concerns blocked originals with an eligible
alternative: their body is discarded without reading it before fallback. If all
alternatives fail, the original status and URL remain, with an empty body, zero retained bytes, and
truncation indicated when an unread stream was discarded. Without an eligible
alternative, the ordinary bounded body is retained; blocking bodies reaching
the preview cap are conservatively marked truncated.

R2 used the existing spin-worker fixture. It stayed busy after immediate
cancellation on the baseline and needed explicit pool closure. The corrected
path rejects before creating a worker.

R3 used PDFs with real object tables and cross-reference offsets. The damaged
fixture removes the second page object while retaining its page-tree reference.
The baseline reported two pages with only first-page text. Successful callback
counting detects this; a valid blank page still counts. Metadata and text order
are preserved. Incomplete extraction now returns `pdf_parse_failed`.

The test-tool upgrade changes no production dependency versions, registry URLs,
or integrity values. Vitest 4 was evaluated but hit reproducible npm resolver
failures under the pinned toolchain, including a clean isolated graph. The
adopted Vitest 5/Vite 8 combination installed and passed the original 141 tests
before being applied here. No peer-dependency bypass flags were used.

## Verification results

The canonical suite ran under Node 22.23.4, real authenticated Valkey 9.0.0,
Helm 3.19.0, kubeconform 0.7.0, and Python 3.12. The candidate Python environment
was installed from scratch using the complete hash lock.

| Verification | Baseline | Candidate |
| --- | --- | --- |
| Runtime tests | 141 passed / 21 files | 161 passed / 21 files, no skips |
| Load-result oracle | 2 passed | 2 passed |
| Python tests | 47 passed | 48 passed |
| TypeScript, Ansible, Bash | Passed | Passed |
| Deterministic profiles | 7 | 7 |
| Rejected unsafe configurations | 46 | 46 |
| Kubernetes / monitoring schemas | 133 / 2 | 133 / 2, none skipped |
| Full npm advisory audit | 5 affected packages | 0 reported vulnerabilities |
| Production npm advisory audit | 0 reported vulnerabilities | Included in the clean full audit |
| Python advisory metadata | Old Ansible pin flagged | No advisories returned for all 15 locked candidate distributions |

Failing-before evidence exists for R1, R2, R3, and the email guard. Positive
controls retain authentication, scopes, shared Valkey quotas, allowed public
fetches, redirect rejection, parser recovery, and valid blank pages. Controlled
upstream responses do not establish real provider availability.

The old verification document stated 136 tests across 20 files. [The record is
updated](../verification.md) with freshly observed counts. The PR's remote
workflow must be checked on its own head/integration revision; the successful
initial workflow on `main` does not establish this candidate's status.

## Controls found to be implemented

| Area | Source and isolated-test observations | Evidence limit |
| --- | --- | --- |
| Authentication | Bearer auth, hashed principals, expiry, scope-specific tools, bounded requests, exact origins | Deployment issuance, rotation and revocation still need testing |
| SSRF / credentials | Public-address checks, checked DNS used for the connection, redirect validation, downgrade denial, credential stripping | Live CNI and egress routing unverified |
| Search admission | Bounded pools, override rejection, per-attempt shared quotas, fail-closed store errors | Provider acceptance, permissions and capacity unmeasured |
| Browser | Proxy path restrictions, identity-header contract, preference/cookie filtering, dedicated network peers | OIDC group/login and direct-backend isolation unverified |
| Containers / Kubernetes | Non-root, read-only roots, dropped capabilities, seccomp, no service tokens, Secret references, image digests, component network policy | Static manifests do not prove startup or enforcement |
| Delivery | Source-pinned suspended Flux bundle, explicit ServiceAccount, target/ownership checks, rollback procedures | Cluster convergence, repeat apply and recovery unverified |
| CI / dependencies | Isolated hosted workers, read-only token, pinned checkout, no persisted credentials, locks, ignored npm install scripts | CI is not a release build, image scan or deployment verification |
| Privacy | No query/body logging in reviewed application paths, bounded metric labels, TTL quotas, generic publication scan | Platform/IdP/ingress retention and unknown private strings require operator checks |

Rendered secret-revision changes updated all five hardened application pod
templates. Other settings affected their expected consumers. Hardened HPA maxima
plus one surge pod per Deployment fit the CPU quota: 62.15 requested against 64,
and 147 limits against 160. This is configuration arithmetic, not measured load.

The pinned upstream SearXNG [Dockerfile](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/container/Dockerfile)
and [entrypoint](https://github.com/searxng/searxng/blob/ac11e14c5edf995d4d2f066bfb885a614f52a978/container/entrypoint.sh)
were checked against chart paths, UID/GID and Granian assumptions.

## Remaining work, ordered by consequence

### 1. Qualify replacement of embedded PDF.js

`pdf-parse@1.1.1` embeds PDF.js 1.10.100 outside npm's separate dependency
inventory. It retains older glyph-function code associated with
[CVE-2024-4367](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq).
The application calls `getTextContent`, not canvas glyph rendering. Exploitation
through the current API was not demonstrated. Worker threads limit time/heap;
they inherit Node capabilities and are not an operating-system sandbox.

**Owner: runtime maintainers.** Qualify a maintained parser/wrapper with complete,
blank, malformed, partial, encrypted, large, and adversarial-font documents.
Preserve cancellation, byte accounting, text/metadata contracts, and sanitized
errors. Verify the loaded version and security options. Passing
`isEvalSupported: false` to the current wrapper is insufficient: it does not
forward that option. This PR's completeness fix does not resolve parser age or
the embedded advisory.

### 2. Enforce repository integration controls

GitHub reported `main` as unprotected and returned no repository rulesets at
review time. A workflow's existence does not enforce its use.

**Owner: repository administrator.** Configure the intended PR/review policy,
required validation check, stale-review handling, and force-push/deletion
restrictions. Confirm a deliberately failing candidate cannot merge under that
policy. Repository settings were inspected, not changed by this PR.

### 3. Close scanning coverage gaps

Generic scans and manual searches found no recognizable live credentials or
internal identifiers. No operator-specific private pattern list was supplied.
`--history` scans metadata/messages, not historical blobs. The baseline has one
root commit, but future changes can add and remove a secret while the final tree
looks clean.

**Owner: maintainers.** Add credential-focused history/range scanning to existing
PR checks and prove it catches a secret committed and then removed. Keep public
contributor identities distinct from secret detection. Add advisory checking for
Python tooling and inventory vendored code in the release SBOM. The Python check
here was a point-in-time registry query, not a new CI gate. Dedicated full-history
scanning, SAST and application-image vulnerability scanning were not executed.

### 4. Qualify the actual release and deployment

**Owner: deployment operators with runtime maintainers.** Use the existing
operations and capacity procedures.

| Required evidence | Acceptance condition |
| --- | --- |
| OCI artifact | Build reviewed source; record digest/inventory; inspect licenses; scan and start it with chart UID/read-only filesystem constraints |
| Identity / network | Complete valid SSO login; deny wrong groups/tokens/scopes; prove backend/admin isolation and egress enforcement; exercise rotation |
| GitOps lifecycle | First apply, unchanged repeated apply, upgrade, interrupted reconciliation and recovery of identified artifact/configuration |
| HA / failure | Datastore interruption/failover, node loss, draining, quota failure and recovery without weakened security |
| Capacity / fairness | 20/25-QPS sustained and 50-QPS burst; useful results, latency/rejections, parser-heavy traffic, multiple principals and resource budgets |
| Operations / privacy | Actual ingress/IdP/platform retention, no query/token leakage, and named release/rollback ownership |

The 3k/5k profiles remain capacity assumptions. No application image was published
and no service was deployed. Elapsed idle time is not qualification evidence.

## Dependency reference basis

- [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp): UI/API exposure conditions, not evidence of a production MCP exploit.
- [Tinypool worker-options](https://github.com/tinylibs/tinypool/security/advisories/GHSA-5gmw-xhrv-c9v3) and [run-options](https://github.com/tinylibs/tinypool/security/advisories/GHSA-85c8-ppgw-ccpr) advisories: prototype-pollution preconditions.
- [Vitest migration](https://vitest.dev/guide/migration/) and official registry metadata for [Vitest 5.1.0](https://registry.npmjs.org/vitest/5.1.0) / [Vite 8.3.8](https://registry.npmjs.org/vite/8.3.8).
- [Ansible advisory](https://github.com/advisories/GHSA-w8p5-mx5w-cpqj), [official changelog](https://github.com/ansible/ansible/blob/v2.19.15/changelogs/CHANGELOG-v2.19.rst), and [release hashes](https://pypi.org/pypi/ansible-core/2.19.15/json). Current CI does not install Galaxy roles; the vulnerable pin is not a demonstrated exploit of that workflow.
