#!/usr/bin/env python3
"""Render a revision-pinned, suspended-by-default Flux delivery unit."""
from __future__ import annotations

import argparse
import copy
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit

import yaml


ROOT = Path(__file__).resolve().parents[1]
OWNER_LABEL = {"app.kubernetes.io/managed-by": "searxng-platform-gitops"}


def validate_repository_url(value: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme not in {"https", "ssh"} or not parsed.hostname or parsed.password
            or parsed.query or parsed.fragment
            or (parsed.scheme == "https" and parsed.username)
            or (parsed.scheme == "ssh" and parsed.username != "git")
            or not re.fullmatch(r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+\.git", parsed.path)
            or any(part in {".", "..", ""} for part in parsed.path.split('/')[1:])):
        raise ValueError("Use an explicit credential-free HTTPS or ssh://git@host/owner/repository.git source URL")
    return value


def merge_values(base: dict, overlay: dict) -> dict:
    """Helm-style maps merge recursively; scalars and lists replace."""
    result = copy.deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_values(result[key], value)
        else:
            result[key] = copy.deepcopy(value)
    return result


def delivery_objects(revision: str, namespace: str, release: str, secret_name: str,
                     values: dict, repository_url: str, service_account: str, active: bool = False) -> list[dict]:
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Source revision must be a full 40-character commit SHA")
    validate_repository_url(repository_url)
    if repository_url.startswith("ssh:") and not secret_name:
        raise ValueError("SSH sources require a referenced Git authentication Secret")
    for name in (namespace, release, service_account, *([secret_name] if secret_name else [])):
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?", name):
            raise ValueError("Use DNS labels of at most 53 characters for delivery names")
    if service_account == "default":
        raise ValueError("HelmRelease requires a dedicated ServiceAccount, not default")
    if not re.fullmatch(r"searxng(?:-[a-z0-9-]+)?", namespace) or not release.startswith("searxng-"):
        raise ValueError("Use a searxng[-suffix] namespace and searxng- prefixed release")
    return [
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {
            "name": namespace, "labels": {**OWNER_LABEL, "pod-security.kubernetes.io/enforce": "restricted",
            "pod-security.kubernetes.io/enforce-version": "v1.30",
            "pod-security.kubernetes.io/audit": "restricted",
            "pod-security.kubernetes.io/warn": "restricted"}}},
        {"apiVersion": "source.toolkit.fluxcd.io/v1", "kind": "GitRepository",
         "metadata": {"name": release, "namespace": "flux-system", "labels": OWNER_LABEL.copy()}, "spec": {
             "interval": "10m", "timeout": "60s",
             "url": repository_url,
             "ref": {"commit": revision}, **({"secretRef": {"name": secret_name}} if secret_name else {})}},
        {"apiVersion": "helm.toolkit.fluxcd.io/v2", "kind": "HelmRelease",
         "metadata": {"name": release, "namespace": "flux-system", "labels": OWNER_LABEL.copy()}, "spec": {
             "suspend": not active, "interval": "10m", "timeout": "5m", "serviceAccountName": service_account,
             "releaseName": release, "targetNamespace": namespace,
             "storageNamespace": namespace,
             "chart": {"spec": {"chart": "./charts/searxng-platform", "reconcileStrategy": "Revision",
                 "sourceRef": {"kind": "GitRepository", "name": release, "namespace": "flux-system"}}},
             "install": {"createNamespace": False, "remediation": {"retries": 1}},
             "upgrade": {"remediation": {"retries": 1, "strategy": "rollback"}},
             "values": values}},
    ]


def write_bundle(output_dir: Path, objects: list[dict]) -> list[Path]:
    """Write the reviewable delivery unit plus a kustomization for a deployment repository."""
    output_dir.mkdir(parents=True, exist_ok=True)
    delivery = output_dir / "delivery.yaml"
    kustomization = output_dir / "kustomization.yaml"
    delivery.write_text(yaml.safe_dump_all(objects, sort_keys=False))
    kustomization.write_text(yaml.safe_dump({"apiVersion": "kustomize.config.k8s.io/v1beta1",
                                             "kind": "Kustomization", "resources": ["delivery.yaml"]}, sort_keys=False))
    return [delivery, kustomization]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--repository-url", required=True)
    parser.add_argument("--values", type=Path, action="append", required=True)
    parser.add_argument("--namespace", default="searxng")
    parser.add_argument("--release", default="searxng-platform")
    parser.add_argument("--git-secret", default="", help="Existing Flux source credential Secret; required for SSH/private sources")
    parser.add_argument("--service-account", required=True,
                        help="Namespace-scoped ServiceAccount in flux-system that helm-controller impersonates")
    parser.add_argument("--output-dir", type=Path, required=True,
                        help="Directory to commit to the deployment repository; receives delivery.yaml and kustomization.yaml")
    parser.add_argument("--helm", default="helm")
    parser.add_argument("--active", action="store_true", help="Generate active intent for an authorized promotion")
    args = parser.parse_args()
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
                          capture_output=True, text=True, timeout=10).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, check=True,
                           capture_output=True, text=True, timeout=10).stdout.strip()
    if head != args.revision or dirty:
        parser.error("Check out the exact requested source revision with a clean worktree before rendering")
    values: dict = {}
    for path in args.values:
        document = yaml.safe_load(path.read_text())
        if not isinstance(document, dict):
            parser.error(f"{path} must contain a YAML map")
        values = merge_values(values, document)
    try:
        objects = delivery_objects(args.revision, args.namespace, args.release, args.git_secret, values,
                                   args.repository_url, args.service_account, args.active)
    except ValueError as error:
        parser.error(str(error))
    # Render exactly the overlay list to catch missing pins and chart guard violations.
    command = [args.helm, "template", args.release, str(ROOT / "charts/searxng-platform"),
               "--namespace", args.namespace]
    for path in args.values:
        command.extend(["--values", str(path.resolve())])
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, timeout=60)
    written = write_bundle(args.output_dir, objects)
    print(f"Prepared {args.output_dir} ({', '.join(path.name for path in written)}); suspend={not args.active}; source={args.revision}")


if __name__ == "__main__":
    main()
