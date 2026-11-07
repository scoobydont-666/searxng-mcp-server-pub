# Verification record and qualification boundary

Source candidate checked on 2026-11-07. These results describe implementation
verification, not a deployed service or a 3,000–5,000-user performance result.
The private review handoff records the exact source/export commit and final
review receipts; no private host, repository, or reviewer identity is embedded
in this public document.

## Observed local checks

| Check | Observed result |
| --- | --- |
| TypeScript build | Passed on Node 22.23.4, matching the pinned base image's Node version |
| Runtime behavior | 136 tests passed across 20 files, including per-principal fairness, fetch budget, worker parsing, fetch quota and admin-listener tests; real authenticated Valkey 9.0.0; no skipped tests |
| Load-result oracle | 2 Node tests passed; checks meaningful results rather than HTTP 200 alone |
| Python IaC, catalog, credential and publication tests | 47 tests passed, including hash-lock, delivery ServiceAccount and bundle, and settings argument tests |
| Deployment matrix | Seven deterministic configurations: lab, broad lab, broad 3k, broad 5k, hardened 5k, API only, browser only |
| Kubernetes validation | 133 rendered Kubernetes resources and 2 monitoring resources passed schema checks; none skipped |
| Negative configuration checks | Canonical verifier includes 46 cases, four of them rendered without schema validation, covering credentials, transport, identity, isolation, routing, egress, HA and engine-policy bounds |
| Production dependency audit | 0 reported production vulnerabilities in the audit taken for the previous candidate; dependencies were not changed in this correction |
| Engine provenance | 353 configured entries, 252 implementation modules, 25 additional modules, 261 public candidates (81 not upstream-disabled, 180 upstream-disabled); offline contract and source reproduction checks passed |
| Privacy scan | Generic scan and an operator-private pattern scan passed on the candidate; private pattern inputs were kept outside the repository |
| Verification installer | Checksum-pinned Node, Helm, kubeconform and Valkey installed and executed in a disposable local tool directory |

The independent code reviews identified two concrete issues that were corrected:
schema/runtime mismatch in configurable engine pools, and untrusted HTML/CSS
content appearing in a parser's stderr diagnostics. Regressions cover both
boundaries. Reviews of an earlier working tree do not authorize publishing a
later export; final approval must identify the actual candidate commit.

The public export tool also has an independently inspected tree/history boundary:
it copies only committed allowed blobs, preserves the exact tree ID, and creates
a single fresh root commit without original Git metadata. The actual delivered
bundle must still be checked and reviewed by its commit ID.

## Not established by these checks

No live cluster was changed. There is no recorded application OCI image build or
registry publication for this candidate, no completed SSO login, no live CNI
isolation proof, no installed Flux/Helm convergence or second-apply idempotence
result, and no measured provider throughput. The live 20/25-QPS sustained and
50-QPS synthetic burst scenarios, node-loss behavior, HA datastore failover,
capacity and provider terms remain deployment qualification gates.

The optional ExternalSecret and Certificate examples are incomplete prerequisite
templates. Their YAML syntax was checked; they require real site inputs and the
appropriate installed CRDs before server-side validation or application. The
public CI workflow is supplied, but a local passing command is not proof that a
remote workflow ran successfully.

Public visibility is a separate owner decision. The application is licensed
under the MIT License; third-party obligations are listed in NOTICE. A review
handoff does not count as a completed review. See
[publication boundary](publication-boundary.md) and [capacity](capacity.md).

## Reproduce

Use [development.md](development.md) for the pinned toolchain, then run:

```bash
make check
npm audit --omit=dev --audit-level=high
python3 scripts/check_publication.py
git diff --check
```

Run the publication scanner with `--history` inside the fresh export, and use
`--private-pattern-file` with an operator-owned file outside the repository for
site-specific checks. Record exact source/image/config identities alongside all
later runtime or capacity results. Do not copy private raw logs into public
release evidence.
