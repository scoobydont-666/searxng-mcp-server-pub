# Operator schemas used by verification

`ServiceMonitor.json` and `PrometheusRule.json` are the `v1`
`openAPIV3Schema` fields extracted from the official Prometheus Operator CRDs.
The source release, exact Git revision, download URLs, and SHA-256 checksums are
recorded in [provenance.json](provenance.json). Upstream is licensed under
[Apache-2.0](https://github.com/prometheus-operator/prometheus-operator/blob/main/LICENSE).

`scripts/check_iac.py` validates every rendered operator object against these
schemas with `jsonschema`. Other objects go through strict kubeconform validation
against Kubernetes 1.32.0. No missing-schema skip flag is used. This validates
the submitted object shape; the target cluster must still have compatible
Prometheus Operator CRDs and selectors installed.

When updating the operator contract, retrieve CRDs from a reviewed immutable
upstream revision, extract the `v1` schemas, update the provenance hashes, and run
the complete rendered matrix. Do not fetch mutable schema files during CI.
