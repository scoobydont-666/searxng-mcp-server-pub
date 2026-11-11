# Verification record and qualification boundary

Review updated on 2026-11-11 against baseline
`486b9fe6c4b6887ca02b3f57ee669896a2827ffe`. The
[full repository review](reviews/2026-11-11-full-review.md) records findings,
corrections, and remaining release work. These checks describe source behavior,
not a deployed service or a 3,000–5,000-user performance result. The pull request
records its exact final head and the associated remote CI outcome.

## Observed local checks

| Check | Observed result |
| --- | --- |
| TypeScript build | Passed on Node 22.23.4, matching the pinned application base image |
| Runtime behavior | 151 tests passed across 21 files, up from 141 on the baseline; real authenticated Valkey 9.0.0; no skipped tests |
| New failure-path evidence | Fallback contention, parser cancellation, and incomplete PDF extraction failed before their fixes and passed afterwards; healthy alternatives, complete PDFs, and blank pages remain accepted |
| Load-result oracle | 2 Node tests passed; checks meaningful results rather than HTTP 200 alone |
| Python tests | 48 tests passed, up from 47; includes domain-boundary controls for the publication scanner |
| Deployment matrix | Seven deterministic configurations: lab, broad lab, broad 3k, broad 5k, hardened 5k, API only, browser only |
| Kubernetes validation | 133 rendered Kubernetes resources and 2 monitoring resources passed schema checks; none skipped |
| Negative configuration checks | 46 unsafe configurations rejected, including four exercised without schema validation |
| npm dependency audit | Full audit, including development dependencies: zero reported vulnerabilities; baseline full audit flagged five packages |
| Production dependency identities | All 193 non-root production lock entries retain their baseline version, registry URL, and integrity values |
| Python installation | Fresh venv installed the complete lock with `--require-hashes`; Ansible Core updated to 2.19.15 |
| Python advisory check | PyPI per-version metadata checked for all 15 locked distributions: no advisories returned; this does not cover vendored code or undisclosed flaws |
| Engine inventory | Offline contracts validated: 353 configured entries, 252 modules, 25 additional modules, 261 public candidates; provider availability was not tested |
| Publication review | Generic scan passed; baseline root metadata inspected; no operator-specific private pattern list supplied |
| Syntax and patch hygiene | Ansible syntax, Bash syntax, and `git diff --check` passed |

The full npm audit is now the CI command. A passing dependency audit does not
cover the PDF.js source embedded in `pdf-parse`; see [SECURITY.md](../SECURITY.md)
and the review. The image recipe now copies the project license, notices, and
bundled-component license text.

## Not established by these checks

No live cluster was changed. There is no recorded application OCI image build or
registry publication for this candidate, no completed SSO login, no live CNI
isolation proof, no installed Flux/Helm convergence or second-apply idempotence
result, and no measured provider throughput. The live 20/25-QPS sustained and
50-QPS synthetic burst scenarios, node-loss behavior, HA datastore failover,
capacity and provider terms remain deployment qualification gates.

The optional ExternalSecret and Certificate examples are incomplete prerequisite
templates. Their YAML syntax is checked; they require real site inputs and the
appropriate installed CRDs before server-side validation or application.
Local results do not substitute for the remote workflow result on the PR head.

The publication scanner's `--history` option checks commit metadata and messages,
not historical file blobs. The reviewed baseline has one root commit; future
multi-commit changes need historical secret scanning as well as the current-tree
gate. No dedicated full-history secret scanner or image vulnerability scanner
was run in this review.

## Reproduce

Use [development.md](development.md) for the pinned toolchain, then run:

```bash
make check
npm audit --audit-level=high
python3 scripts/check_publication.py
git diff --check
```

Use `--private-pattern-file` with an operator-owned file outside the repository
for site-specific publication checks. Record exact source/image/config identities
alongside later runtime or capacity results. Keep private raw logs out of public
release evidence.
