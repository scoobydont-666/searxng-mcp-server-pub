# Development and verification

The application targets Node 22.23.4, matching the pinned OCI base image.
The verification bootstrap also pins Helm 3.19.0, kubeconform 0.7.0, and
Valkey 9.0.0. Python dependencies are hash-locked in `requirements-iac.txt`: every direct and
transitive distribution is pinned to an exact version and sha256 digests, and
must be installed with `--require-hashes`.

On Linux x86_64 with Python 3.12+, a C compiler, make, and git:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r requirements-iac.txt
python3 scripts/bootstrap_verifiers.py --directory artifacts/verifiers
export PATH="$PWD/artifacts/verifiers/bin:$PWD/.venv/bin:$PATH"
npm ci --ignore-scripts
make check
npm audit --omit=dev --audit-level=high
```

Use a new empty verifier directory. The installer checks the official archive
SHA-256 values before extracting or running anything, needs no root, and compiles
only the loopback test server with two build jobs. Other architectures need
independently verified platform binaries. The public CI workflow uses isolated
hosted workers, read-only repository permissions, no persistent checkout
credentials, no cluster credentials, and the same check commands.

`make check` builds TypeScript, runs behavior tests against a disposable real
authenticated Valkey instance, verifies the content-aware load oracle, tests
Python IaC and credential helpers, renders both examples across the capacity
profiles, checks deterministic output and invalid settings, validates all
rendered Kubernetes and monitoring objects, and checks Ansible/Bash syntax.
It does not install into a cluster or send test traffic to public search engines.

`scripts/test_with_valkey.py` starts and stops its own loopback process. If you
already have a verified binary outside PATH, set `VALKEY_SERVER` to its path.
The canonical check fails if the distributed-store test cannot run; skipping it
does not count as verification. `npm test` alone may skip that test without
`TEST_REDIS_URL`, so use the helper or `make check` for release evidence.

`scripts/check_iac.py` creates test-only image pins and endpoint fixtures in a
temporary directory. Those do not identify real images, services, or credentials.
No fixture values are written into deployable examples. Kubernetes resources use
strict kubeconform schemas; monitoring resources use the versioned official CRD
schemas in `tests/schemas`, with no unknown-schema skip option.

To regenerate the lock after a deliberate upgrade, resolve the three direct pins in a
fresh venv with `pip install --dry-run --ignore-installed --report report.json -r`, then
take every distribution's digests from `https://pypi.org/pypi/<name>/<version>/json`
(all `urls[].digests.sha256` values). Verify with a fresh venv and `--require-hashes`
before committing. `make iac-deps` performs the locked install into `PYTHON`.

## Engine upgrades

The catalog is data generated from immutable upstream settings and static Python
AST inspection. `python3 scripts/build_engine_catalog.py --validate` verifies its
internal contract offline. Full source verification and reproduction are
documented in [the catalog guide](engine-catalog.md). Changing an upstream image
requires reviewing both native settings and engine behavior, regenerating the
catalog, checking both examples, rerunning tests, and staging a provider pilot.

## Synthetic load

`load/mock-searxng.mjs` is an isolated deterministic upstream for latency and
failure injection. `load/search.js` supports MCP or REST arrival-rate scenarios
and checks useful results. It refuses unacknowledged live provider load. See
[capacity](capacity.md) for 20/25-QPS sustained and 50-QPS burst qualification,
one-node loss, datastore interruption, and complete evidence requirements.

The OCI build uses rootless Buildah through `bash scripts/build-image.sh`.
Publishing requires its explicit `--push` argument, a clean reviewed commit, and
registry credentials supplied outside git. Static checks and a successful source
build do not prove the image starts with the chart's read-only filesystem and
UID/GID; that is a required deployment qualification step.
