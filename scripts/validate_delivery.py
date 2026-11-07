#!/usr/bin/env python3
"""Reject unpinned or out-of-scope Flux bootstrap input before invoking kubectl."""
from __future__ import annotations

import argparse
from pathlib import Path
import re

import yaml
from prepare_gitops import delivery_objects, validate_repository_url, OWNER_LABEL


def validate(documents: list[dict], expected_repository_url: str) -> None:
    validate_repository_url(expected_repository_url)
    if len(documents) != 3 or any(not isinstance(d, dict) for d in documents):
        raise ValueError("Expected exactly Namespace, GitRepository and HelmRelease")
    by_kind = {d.get("kind"): d for d in documents}
    if set(by_kind) != {"Namespace", "GitRepository", "HelmRelease"}:
        raise ValueError("Unexpected delivery object kinds")
    namespace = by_kind["Namespace"]["metadata"]["name"]
    if namespace in {"default", "kube-system", "kube-public", "kube-node-lease", "flux-system"}:
        raise ValueError("Application namespace must be dedicated")
    source = by_kind["GitRepository"]
    release = by_kind["HelmRelease"]
    if source["metadata"].get("namespace") != "flux-system" or release["metadata"].get("namespace") != "flux-system":
        raise ValueError("Flux objects must be in flux-system")
    ref = source["spec"]["ref"]
    if set(ref) != {"commit"} or not re.fullmatch(r"[a-f0-9]{40}", ref["commit"]):
        raise ValueError("GitRepository requires one immutable commit ref")
    if source["spec"]["url"] != expected_repository_url:
        raise ValueError("Unexpected source repository")
    spec = release["spec"]
    if spec.get("targetNamespace") != namespace or spec.get("storageNamespace") != namespace:
        raise ValueError("Helm release namespace mismatch")
    chart = spec["chart"]["spec"]
    if chart["chart"] != "./charts/searxng-platform" or chart.get("reconcileStrategy") != "Revision":
        raise ValueError("Unexpected chart or non-revision reconciliation")
    if chart["sourceRef"] != {"kind": "GitRepository", "name": source["metadata"]["name"], "namespace": "flux-system"}:
        raise ValueError("Helm chart source mismatch")
    if not isinstance(spec.get("suspend"), bool):
        raise ValueError("HelmRelease must explicitly specify suspend")
    if not spec.get("serviceAccountName"):
        raise ValueError("HelmRelease must set spec.serviceAccountName to a namespace-scoped ServiceAccount")
    if spec.get("postRenderers") or spec.get("valuesFrom"):
        raise ValueError("Use the chart values surface; bootstrap does not accept injected manifests")
    expected = delivery_objects(ref["commit"], namespace, release["metadata"]["name"],
                                source["spec"].get("secretRef", {}).get("name", ""), spec["values"],
                                expected_repository_url, spec["serviceAccountName"], not spec["suspend"])
    for item in expected:
        if by_kind[item["kind"]] != item:
            raise ValueError(f"Unexpected fields or identity in {item['kind']}; regenerate with prepare_gitops.py")


def check_existing_owner(desired: dict, existing: dict | None) -> None:
    if existing is None:
        return
    labels = existing.get("metadata", {}).get("labels", {})
    if any(labels.get(key) != value for key, value in OWNER_LABEL.items()):
        raise ValueError(f"Refusing to adopt foreign-owned {desired['kind']}/{desired['metadata']['name']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--expected-repository-url", required=True)
    parser.add_argument("--context", help="Also reject existing objects owned by another deployment")
    args = parser.parse_args()
    try:
        documents = list(yaml.safe_load_all(args.file.read_text()))
        validate(documents, args.expected_repository_url)
        if args.context:
            import json
            import subprocess
            for desired in documents:
                command = ["kubectl", "--context", args.context, "--request-timeout=10s", "get",
                           desired["kind"], desired["metadata"]["name"], "--ignore-not-found", "-o", "json"]
                if desired["metadata"].get("namespace"):
                    command.extend(["--namespace", desired["metadata"]["namespace"]])
                result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=15)
                check_existing_owner(desired, json.loads(result.stdout) if result.stdout.strip() else None)
    except (KeyError, TypeError, ValueError, yaml.YAMLError) as error:
        parser.error(str(error))
    print("Delivery scope and source pin validated; cluster runtime still requires preflight")


if __name__ == "__main__":
    main()
