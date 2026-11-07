#!/usr/bin/env python3
"""Render real deployment combinations and reject unsafe configuration regressions.

Fixture image digests, domains and CIDRs exist only in temporary test values.
This is static verification, not an installation or a provider load test.
"""

from __future__ import annotations

import json
import re
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

import jsonschema
import yaml

from prepare_gitops import merge_values


ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "charts/searxng-platform"
HELM = os.environ.get("HELM", "helm")
SCHEMAS = ROOT / "tests/schemas"
FIXTURE = {
    "mcp": {"image": {"digest": "sha256:" + "f" * 64}},
    "valkey": {"externalCidrs": ["192.0.2.10/32"]},
    "ingress": {"tlsSecretName": "validation-only-tls"},
    "web": {
        "oauth2Proxy": {
            "issuerUrl": "https://identity.example.invalid",
            "clientId": "validation-only",
            "emailDomains": ["example.invalid"],
            "allowedGroups": ["search-users"],
            "trustedProxyCidrs": ["10.42.0.0/16"],
        }
    },
}


def values(*paths: str, overlay: dict | None = None) -> dict:
    result = yaml.safe_load((CHART / "values.yaml").read_text())
    for path in paths:
        result = merge_values(result, yaml.safe_load((ROOT / path).read_text()))
    if overlay:
        result = merge_values(result, overlay)
    return result


def render(settings: dict, file: Path, skip_schema: bool = False) -> subprocess.CompletedProcess:
    file.write_text(yaml.safe_dump(settings, sort_keys=False))
    extra = ["--skip-schema-validation"] if skip_schema else []
    return subprocess.run(
        [HELM, "template", "searxng-platform", str(CHART), "--namespace", "searxng-validation", "--values", str(file), *extra],
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )


def check_boundaries(documents: list[dict], settings: dict) -> None:
    identities = [(doc["apiVersion"], doc["kind"], doc["metadata"]["name"]) for doc in documents]
    assert len(set(identities)) == len(identities), "duplicate rendered resource identity"
    assert not any(doc["kind"] in {"Secret", "Node", "ClusterRole", "ClusterRoleBinding"} for doc in documents)
    assert any(doc["kind"] == "NetworkPolicy" for doc in documents)
    extra_egress = settings["networkPolicy"]["extraEgress"]
    for doc in documents:
        if doc["kind"] == "NetworkPolicy":
            component = doc["spec"]["podSelector"].get("matchLabels", {}).get("app.kubernetes.io/component")
            for owner, rules in extra_egress.items():
                for rule in rules:
                    assert (rule in doc["spec"].get("egress", [])) == (owner == component), "extraEgress crossed a component boundary"
            for rule in doc["spec"].get("egress") or []:
                blocks = [peer["ipBlock"] for peer in rule.get("to") or [] if "ipBlock" in peer]
                cidrs = {block["cidr"] for block in blocks}
                if "0.0.0.0/0" in cidrs:
                    assert "::/0" not in cidrs and "2000::/3" in cidrs, "public IPv6 egress must be global unicast"
                    v6 = next(block for block in blocks if block["cidr"] == "2000::/3")
                    assert v6["except"] == ["2001::/23", "2001:db8::/32", "2002::/16"], "public IPv6 exceptions drifted from the address policy"
        if doc["kind"] == "Service":
            assert doc["spec"].get("type", "ClusterIP") == "ClusterIP", "raw NodePort/LoadBalancer exposure"
            if doc["metadata"]["name"].endswith("-mcp"):
                published = any(port["name"] == "admin" for port in doc["spec"]["ports"])
                assert published == bool(settings["monitoring"]["serviceMonitor"]["enabled"]), (
                    "admin port must be published only for the ServiceMonitor"
                )
        if doc["kind"] in {"Deployment", "StatefulSet"}:
            pod = doc["spec"]["template"]["spec"]
            for container in pod["containers"] + pod.get("initContainers", []):
                for entry in container.get("env", []):
                    value = entry.get("value")
                    assert not (isinstance(value, str) and re.fullmatch(r"[0-9.]+e[+-][0-9]+", value)), (
                        f"{entry['name']} renders in scientific notation and fails integer parsing"
                    )
            assert pod["automountServiceAccountToken"] is False
            assert pod["enableServiceLinks"] is False
            assert pod["securityContext"]["seccompProfile"]["type"] == "RuntimeDefault"
            assert not any(pod.get(key, False) for key in ("hostNetwork", "hostPID", "hostIPC"))
            assert not any("hostPath" in volume for volume in pod.get("volumes", []))
            for container in pod["containers"] + pod.get("initContainers", []):
                context = container["securityContext"]
                assert context["runAsNonRoot"] is True
                assert context["allowPrivilegeEscalation"] is False
                assert context["readOnlyRootFilesystem"] is True
                assert context["capabilities"]["drop"] == ["ALL"]
                component = doc["spec"]["template"]["metadata"]["labels"]["app.kubernetes.io/component"]
                if component == "web-auth":
                    for argument in [
                        "--pass-user-headers=true",
                        "--skip-auth-strip-headers=true",
                        "--prefer-email-to-user=false",
                        "--pass-basic-auth=false",
                    ]:
                        assert argument in container["args"], "OAuth identity injection boundary changed"
                if component == "web-admission":
                    environment = {entry["name"]: entry.get("value") for entry in container["env"]}
                    assert environment["SEARXNG_WEB_USER_RATE_LIMIT"] == str(
                        settings["web"]["admission"]["userRateLimit"]
                    )
                    assert environment["SEARXNG_WEB_USER_RATE_LIMIT_WINDOW"] == str(
                        settings["web"]["admission"]["userRateLimitWindowSeconds"]
                    )
                    assert environment["SEARXNG_MCP_USER_AGENT"] == settings["mcp"]["fetch"]["userAgent"]
        if doc["kind"] == "StatefulSet" and doc["metadata"]["name"].endswith("-valkey"):
            script = doc["spec"]["template"]["spec"]["containers"][0]["args"][0]
            assert "--requirepass" not in script, "Valkey password must not be passed on argv"
            assert not any(
                "VALKEY_PASSWORD" in line for line in script.splitlines() if line.lstrip().startswith("exec")
            ), "Valkey password must not appear in the exec command line"
        if doc["kind"] == "Ingress":
            assert doc["spec"]["tls"], "Ingress must configure TLS"
            for rule in doc["spec"]["rules"]:
                for path in rule["http"]["paths"]:
                    backend = path["backend"]["service"]["name"]
                    assert backend.endswith("-mcp") or backend.endswith("-web-auth"), "raw backend ingress"
                    assert path["path"] in {"/mcp", "/api/v1/search", "/"}
        if doc["kind"] == "Deployment" and doc["metadata"]["name"].endswith("-mcp"):
            container = doc["spec"]["template"]["spec"]["containers"][0]
            environment = {entry["name"]: entry.get("value") for entry in container["env"]}
            fetch = settings["mcp"]["fetch"]
            assert environment["SEARXNG_MCP_FETCH_PRINCIPAL_RATE"] == str(fetch["principalRate"])
            assert environment["SEARXNG_MCP_FETCH_SHARED_RATE"] == str(fetch["sharedRate"])
            assert environment["SEARXNG_MCP_FETCH_BUFFER_BYTES"] == str(fetch["bufferBytes"])
            assert {port["name"] for port in container["ports"]} == {"http", "admin"}, (
                "API and admin listeners must stay separate"
            )
            for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
                assert container[probe]["httpGet"]["port"] == "admin", "probes must use the admin listener"
        if doc["kind"] == "ServiceMonitor":
            for endpoint in doc["spec"]["endpoints"]:
                assert endpoint["port"] == "admin" and endpoint["path"] == "/metrics", (
                    "metrics must be scraped from the admin listener"
                )
        if doc["kind"] == "ConfigMap" and "settings.yml" in doc.get("data", {}):
            upstream = yaml.safe_load(doc["data"]["settings.yml"])
            is_web = doc["metadata"]["name"].endswith("-web")
            assert upstream["search"]["formats"] == (["html"] if is_web else ["json"])
            assert upstream["server"]["secret_key"] == ""
            assert upstream["outgoing"]["verify"] is True
            assert upstream["general"]["debug"] is False
            assert upstream["server"]["limiter"] is False
        if doc["kind"] == "ConfigMap" and "engine-policy.json" in doc.get("data", {}):
            policy = json.loads(doc["data"]["engine-policy.json"])
            assert policy == settings["mcp"]["enginePolicy"]
    # Run the actual runtime validators against the exact policy documents rendered by Helm.
    payloads = [
        doc["data"] for doc in documents if doc["kind"] == "ConfigMap" and "engine-policy.json" in doc.get("data", {})
    ]
    code = """
import {readFileSync} from 'node:fs';
import {parseEnginePolicy} from './dist/utils/engine-policy.js';
import {parseFeedPolicy} from './dist/utils/feed-fallback.js';
for (const config of JSON.parse(readFileSync(0, 'utf8'))) {
  parseEnginePolicy(JSON.parse(config['engine-policy.json']));
  if (config['feed-policy.json']) parseFeedPolicy(JSON.parse(config['feed-policy.json']));
}
"""
    subprocess.run(
        ["node", "--input-type=module", "-e", code],
        cwd=ROOT,
        input=json.dumps(payloads),
        text=True,
        capture_output=True,
        timeout=20,
        check=True,
    )


def validate_resources(documents: list[dict], schema_cache: Path) -> tuple[int, int]:
    builtins = []
    custom_count = 0
    for doc in documents:
        if doc["apiVersion"] == "monitoring.coreos.com/v1":
            schema = json.loads((SCHEMAS / f"{doc['kind']}.json").read_text())
            jsonschema.Draft7Validator(schema).validate(doc)
            custom_count += 1
        else:
            builtins.append(doc)
    result = subprocess.run(
        [
            os.environ.get("KUBECONFORM", "kubeconform"),
            "-strict",
            "-summary",
            "-kubernetes-version",
            "1.32.0",
            "-cache",
            str(schema_cache),
        ],
        input=yaml.safe_dump_all(builtins),
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return len(builtins), custom_count


def main() -> None:
    for command in (HELM, os.environ.get("KUBECONFORM", "kubeconform"), "node"):
        if not shutil.which(command):
            raise SystemExit(f"Missing verifier {command}; see docs/development.md")
    subprocess.run([HELM, "lint", "--strict", str(CHART)], check=True, timeout=45)
    subprocess.run(["python3", "scripts/build_engine_catalog.py", "--validate"], cwd=ROOT, check=True, timeout=30)
    positive = {
        "lab": values("environments/lab.yaml"),
        "all-engines-lab": values("environments/lab.yaml", "examples/values-all-engines.yaml"),
        "all-engines-3k": values(
            "environments/enterprise-3k.yaml", "examples/values-all-engines.yaml", overlay=FIXTURE
        ),
        "all-engines-5k": values(
            "environments/enterprise-5k.yaml", "examples/values-all-engines.yaml", overlay=FIXTURE
        ),
        "all-engines-secure-5k": values(
            "environments/enterprise-5k.yaml", "examples/values-all-engines-secure.yaml", overlay=FIXTURE
        ),
    }
    positive["api-only"] = merge_values(positive["lab"], {"mcp": {"enabled": False, "apiEnabled": True}})
    issuer_egress = [{"to": [{"ipBlock": {"cidr": "198.51.100.10/32"}}], "ports": [{"protocol": "TCP", "port": 443}]}]
    positive["browser-only"] = merge_values(
        positive["all-engines-secure-5k"],
        {
            "mcp": {"enabled": False, "apiEnabled": False},
            "web": {"enabled": True},
            "networkPolicy": {"extraEgress": {"web-auth": issuer_egress}},
        },
    )
    negative = [
        (
            "missing production pin",
            positive["all-engines-5k"],
            {"mcp": {"image": {"digest": ""}}},
            "digest is required",
        ),
        (
            "missing HA endpoints",
            positive["all-engines-5k"],
            {"valkey": {"externalCidrs": []}},
            "explicit valkey.externalCidrs",
        ),
        ("production singleton", positive["all-engines-5k"], {"valkey": {"mode": "bundled"}}, "externally managed HA"),
        (
            "isolation disabled",
            positive["all-engines-5k"],
            {"networkPolicy": {"enabled": False}},
            "require NetworkPolicy",
        ),
        (
            "drain prevented",
            positive["all-engines-5k"],
            {"mcp": {"pdb": {"minAvailable": 3}}},
            "allow at least one pod to drain",
        ),
        (
            "plaintext credential",
            positive["lab"],
            {"searxng": {"settings": {"engines": [{"name": "fixture", "api_key": "validation-only"}]}}},
            "secret material",
        ),
        (
            "TLS disabled",
            positive["lab"],
            {"searxng": {"settings": {"outgoing": {"verify": False}}}},
            "TLS verification",
        ),
        (
            "format bypass",
            positive["lab"],
            {"searxng": {"settings": {"search": {"formats": ["html", "json"]}}}},
            "formats is reserved",
        ),
        (
            "unbounded fetch",
            positive["lab"],
            {"mcp": {"fetchEnabled": True, "allowedDomains": []}},
            "allowedDomains must be explicit",
        ),
        (
            "reserved environment",
            positive["lab"],
            {"mcp": {"extraEnv": [{"name": "SEARXNG_MCP_ENABLED", "value": "false"}]}},
            "cannot override",
        ),
        (
            "unauthenticated browser override",
            positive["all-engines-secure-5k"],
            {"web": {"enabled": True, "oauth2Proxy": {"extraArgs": ["--skip-auth-regex=.*"]}}},
            "cannot override authentication",
        ),
        (
            "wildcard identity",
            positive["all-engines-secure-5k"],
            {"web": {"enabled": True, "oauth2Proxy": {"emailDomains": ["*"]}}},
            "Wildcard OIDC",
        ),
        (
            "trust-all proxies",
            positive["all-engines-secure-5k"],
            {"web": {"enabled": True, "oauth2Proxy": {"trustedProxyCidrs": ["0.0.0.0/0"]}}},
            "cannot trust all",
        ),
        (
            "ingress without TLS",
            positive["all-engines-secure-5k"],
            {"ingress": {"tlsSecretName": ""}},
            "tlsSecretName is required",
        ),
        ("native shared-IP limiter", positive["all-engines-secure-5k"], {"web": {"limiter": True}}, "false"),
        (
            "identity stripping disabled",
            positive["all-engines-secure-5k"],
            {"web": {"oauth2Proxy": {"extraArgs": ["--skip-auth-strip-headers=false"]}}},
            "cannot override authentication",
        ),
        (
            "unknown policy category",
            positive["lab"],
            {"mcp": {"enginePolicy": {"categories": {"books": {"primary": ["bing"], "fallbacks": []}}}}},
            "books",
        ),
        (
            "repeated fallback pool",
            positive["lab"],
            {"mcp": {"enginePolicy": {"categories": {"general": {"primary": ["bing"], "fallbacks": [["bing"]]}}}}},
            "pools must be distinct",
        ),
        ("invalid engine name", positive["lab"], {"mcp": {"enginePolicy": {"engines": ["bing", "bad!"]}}}, "pattern"),
        (
            "missing fallback list",
            positive["lab"],
            {"mcp": {"enginePolicy": {"categories": {"general": {"fallbacks": None}}}}},
            "fallbacks",
        ),
        ("duplicate inventory", positive["lab"], {"mcp": {"enginePolicy": {"engines": ["bing", "bing"]}}}, "are equal"),
        ("fetch quota ratio", positive["lab"], {"mcp": {"fetch": {"principalRate": 120, "sharedRate": 600}}}, "at least 10x"),
        ("fetch buffer below cap", positive["lab"], {"mcp": {"fetch": {"bufferBytes": 1024}}}, "bufferBytes must be at least"),
        ("privileged admin port", positive["lab"], {"mcp": {"adminPort": 80}}, "minimum"),
        ("oauth request logging", positive["all-engines-secure-5k"], {"web": {"oauth2Proxy": {"extraArgs": ["--request-logging=true"]}}}, "cannot override authentication"),
        ("oauth debug on error", positive["all-engines-secure-5k"], {"web": {"oauth2Proxy": {"extraArgs": ["--show-debug-on-error=true"]}}}, "cannot override authentication"),
        ("metrics without isolation", positive["lab"], {"monitoring": {"serviceMonitor": {"enabled": True}}, "networkPolicy": {"enabled": False}}, "requires networkPolicy.enabled"),
        ("parser memory over limit", positive["lab"], {"mcp": {"fetch": {"parseWorkers": 8, "parseHeapMb": 2048}}}, "below parseWorkers"),
        ("browser without isolation", positive["browser-only"], {"profile": "lab", "networkPolicy": {"enabled": False}}, "web.enabled requires networkPolicy.enabled"),
        ("datastore extra egress", positive["lab"], {"networkPolicy": {"extraEgress": {"valkey": issuer_egress}}}, "valkey"),
        ("oidc token endpoint override", positive["all-engines-secure-5k"], {"web": {"oauth2Proxy": {"extraArgs": ["--redeem-url=https://attacker.example/token"]}}}, "cannot override authentication"),
        ("alternate jwt issuer", positive["all-engines-secure-5k"], {"web": {"oauth2Proxy": {"extraArgs": ["--extra-jwt-issuers=https://attacker.example=aud"]}}}, "cannot override authentication"),
        ("upstream tls verification disabled", positive["all-engines-secure-5k"], {"web": {"oauth2Proxy": {"extraArgs": ["--ssl-upstream-insecure-skip-verify=true"]}}}, "cannot override authentication"),
        ("nested client secret", positive["lab"], {"searxng": {"settings": {"engines": [{"name": "fixture", "azure_client_secret": "validation-only"}]}}}, "secret material"),
        ("suffixed api credential", positive["lab"], {"searxng": {"settings": {"engines": [{"name": "fixture", "cf_ai_api": "validation-only"}]}}}, "secret material"),
        ("digest credential", positive["lab"], {"searxng": {"settings": {"engines": [{"name": "fixture", "http_digest_auth_pass": "validation-only"}]}}}, "secret material"),
        ("world-open extra egress", positive["lab"], {"networkPolicy": {"extraEgress": {"web-auth": [{"to": [{"ipBlock": {"cidr": "0.0.0.0/0"}}], "ports": [{"protocol": "TCP", "port": 443}]}]}}}, "0.0.0.0/0"),
        ("metadata extra egress", positive["lab"], {"networkPolicy": {"extraEgress": {"web-auth": [{"to": [{"ipBlock": {"cidr": "169.254.169.254/32"}}], "ports": [{"protocol": "TCP", "port": 443}]}]}}}, "169.254.169.254/32"),
        ("broad extra egress", positive["lab"], {"networkPolicy": {"extraEgress": {"web-auth": [{"to": [{"ipBlock": {"cidr": "10.0.0.0/8"}}], "ports": [{"protocol": "TCP", "port": 443}]}]}}}, "10.0.0.0/8"),
        ("selector extra egress", positive["lab"], {"networkPolicy": {"extraEgress": {"web-auth": [{"to": [{"namespaceSelector": {"matchLabels": {"kubernetes.io/metadata.name": "kube-system"}}}], "ports": [{"protocol": "TCP", "port": 443}]}]}}}, "narrow ipBlock"),
        ("extra egress port range", positive["lab"], {"networkPolicy": {"extraEgress": {"web-auth": [{"to": [{"ipBlock": {"cidr": "198.51.100.10/32"}}], "ports": [{"port": 443, "endPort": 8443}]}]}}}, "TCP 80 or 443"),
        ("ingress snippet", positive["all-engines-secure-5k"], {"ingress": {"annotations": {"nginx.ingress.kubernetes.io/configuration-snippet": "proxy_set_header X-Forwarded-User injected;"}}}, "cannot inject snippets"),
    ]
    builtin_count = custom_count = 0
    with tempfile.TemporaryDirectory(prefix="searxng-iac-") as temporary:
        path = Path(temporary) / "validation-only.yaml"
        schema_cache = Path(temporary) / "schema-cache"
        schema_cache.mkdir()
        for label, settings in positive.items():
            result = render(settings, path)
            if result.returncode:
                raise RuntimeError(f"{label}: {result.stderr}")
            repeat = render(settings, path)
            assert repeat.returncode == 0 and repeat.stdout == result.stdout, f"{label}: nondeterministic rendering"
            documents = list(yaml.safe_load_all(result.stdout))
            check_boundaries(documents, settings)
            builtins, custom = validate_resources(documents, schema_cache)
            builtin_count += builtins
            custom_count += custom
            print(f"Validated {label}: {builtins} Kubernetes resources, {custom} operator resources")
        for label, settings, override, expected in negative:
            result = render(merge_values(settings, override), path)
            assert result.returncode != 0 and expected in result.stderr, f"{label}: wrong rejection: {result.stderr}"
        # The template guards must hold even when a pipeline skips schema validation.
        schemaless = [
            ("empty extra egress rule", {"networkPolicy": {"extraEgress": {"mcp": [{}]}}}, "need explicit to and ports"),
            ("extra egress without peers", {"networkPolicy": {"extraEgress": {"mcp": [{"ports": [{"port": 80}]}]}}}, "need explicit to and ports"),
            ("privileged fetch pod", {"mcp": {"securityContext": {"privileged": True, "runAsUser": 0}}}, "mcp.securityContext must stay"),
            ("root search pod", {"searxng": {"securityContext": {"runAsNonRoot": False}}}, "searxng.securityContext must stay"),
        ]
        for label, override, expected in schemaless:
            result = render(merge_values(positive["lab"], override), path, skip_schema=True)
            assert result.returncode != 0 and expected in result.stderr, f"{label}: wrong rejection: {result.stderr}"
        negative += [(label, positive["lab"], override, expected) for label, override, expected in schemaless]
    print(
        f"IaC: {len(positive)} deterministic profiles, {len(negative)} unsafe configurations rejected; "
        f"{builtin_count} Kubernetes + {custom_count} operator schema validations, none skipped"
    )


if __name__ == "__main__":
    main()
