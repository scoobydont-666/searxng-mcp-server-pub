#!/usr/bin/env python3
"""Build a deterministic engine inventory from pinned, unexecuted SearXNG source.

The complete inventory is not an enable-all instruction. Only configured public
online candidates without credential, endpoint, Tor or inactive prerequisites
enter the matching settings fragment and bounded runtime policy.
"""
from __future__ import annotations

import argparse
import ast
from concurrent.futures import ThreadPoolExecutor
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

import yaml


ROOT = Path(__file__).resolve().parents[1]
REVISION = "ac11e14c5edf995d4d2f066bfb885a614f52a978"
SETTINGS_SHA256 = "94941a09202b24a2d7b908a0dceea0fafad156835904df92aa26c0ff47de450e"
MODULE_MANIFEST_SHA256 = "9992ea173a0fe07b8a36bc54196590b4f430a5a29ac9995b172fc81f557784a0"
RAW_BASE = f"https://raw.githubusercontent.com/searxng/searxng/{REVISION}/"
MODULE_LIST_URL = f"https://api.github.com/repos/searxng/searxng/contents/searx/engines?ref={REVISION}"
MAX_SOURCE_BYTES = 2 * 1024 * 1024
USER_AGENT = "searxng-platform-catalog/1.0 (pinned upstream source inventory)"
CATEGORIES = ("general", "news", "images", "videos", "science")
CREDENTIAL_KEYS = re.compile(r"^(?:api_?key|api_?token|access_?token|access_?key|auth_?token|auth_?key|password|secret|secret_?key|client_?secret|bearer_?token|token|api_client_id|api_client_secret|azure_client_secret|ta_token|cf_ai_api|http_digest_auth_pass)$", re.I)
ENDPOINT_KEYS = {"base_url", "search_url", "url", "server", "host", "frontend_url", "backend_url"}
# Reviewed exceptions where the pinned source's about.require_api_key is absent
# or incorrect. These fields are names only: credential values are never copied.
REQUIRED_CREDENTIALS = {
    "azure": ["azure_client_secret"],
    "cloudflareai": ["cf_ai_api"],
    "github_code": ["ghc_auth.token"],
    "spotify": ["api_client_id", "api_client_secret"],
    "tubearchivist": ["ta_token"],
    "wolframalpha_api": ["api_key"],
    "youtube_api": ["api_key"],
}
REQUIRED_CONFIGURATION = {
    "azure": ["azure_tenant_id", "azure_client_id"],
    "cloudflareai": ["cf_account_id", "cf_ai_gateway"],
    "elasticsearch": ["base_url", "index"],
    "invidious": ["base_url"],
    "meilisearch": ["base_url", "index"],
    "tubearchivist": ["base_url"],
}
TEMPLATE_MODULES = {"dummy", "dummy-offline", "demo_online", "demo_offline"}
CLASSIFICATIONS = ("public_online", "requires_credentials", "requires_configuration",
                   "offline_or_local", "inactive", "manual_review")
POLICY_POOLS = {
    "general": [["duckduckgo", "brave", "bing"], ["google", "qwant", "yandex"], ["wikipedia"]],
    "news": [["bing news", "brave.news", "duckduckgo news"], ["google news", "reuters"]],
    "images": [["bing images", "brave.images", "duckduckgo images"], ["google images", "qwant images", "yandex images"]],
    "videos": [["bing videos", "brave.videos", "duckduckgo videos"], ["google videos", "qwant videos"]],
    "science": [["arxiv", "crossref", "semantic scholar"], ["pubmed", "openalex"]],
}


def fetch(url: str) -> bytes:
    """Only callers construct fixed official source URLs; no engine is queried."""
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    with urlopen(request, timeout=30) as response:
        data = response.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        raise ValueError("Upstream source exceeds the inventory size bound")
    return data


def canonical_manifest(manifest: dict[str, str]) -> bytes:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()


def source_files(source_dir: Path | None, cache_dir: Path | None = None,
                 offline_cache: bool = False) -> tuple[bytes, dict[str, bytes]]:
    if source_dir is not None:
        source_dir = source_dir.resolve()
        actual = subprocess.run(["git", "-C", str(source_dir), "rev-parse", "HEAD"], check=True,
                                capture_output=True, text=True, timeout=15).stdout.strip()
        if actual != REVISION:
            raise ValueError(f"Local upstream checkout must be at {REVISION}")
        dirty = subprocess.run(["git", "-C", str(source_dir), "status", "--porcelain", "--",
                                "searx/settings.yml", "searx/engines"], check=True,
                               capture_output=True, text=True, timeout=15).stdout
        if dirty:
            raise ValueError("Local upstream settings or engine source has uncommitted changes")
        settings = (source_dir / "searx/settings.yml").read_bytes()
        modules = {path.stem: path.read_bytes() for path in sorted((source_dir / "searx/engines").glob("*.py"))
                   if path.name != "__init__.py"}
        tree = subprocess.run(["git", "-C", str(source_dir), "ls-tree", "HEAD:searx/engines"],
                              check=True, capture_output=True, text=True, timeout=15).stdout
        expected = {}
        for line in tree.splitlines():
            attributes, filename = line.split("\t", 1)
            if filename.endswith(".py") and filename != "__init__.py":
                expected[filename[:-3]] = attributes.split()[2]
    else:
        if cache_dir is not None:
            cache_dir = cache_dir / REVISION
        if offline_cache:
            if cache_dir is None:
                raise ValueError("--offline-cache requires --cache-dir")
            settings = (cache_dir / "settings.yml").read_bytes()
            expected = json.loads((cache_dir / "module-manifest.json").read_bytes())
        else:
            settings = fetch(RAW_BASE + "searx/settings.yml")
            listing = json.loads(fetch(MODULE_LIST_URL))
            if not isinstance(listing, list):
                raise ValueError("GitHub did not return an engine source directory")
            expected = {item["name"][:-3]: item["sha"] for item in listing
                        if item.get("type") == "file" and item.get("name", "").endswith(".py")
                        and item["name"] != "__init__.py"}
        if hashlib.sha256(canonical_manifest(expected)).hexdigest() != MODULE_MANIFEST_SHA256:
            raise ValueError("Engine source manifest differs from the pinned revision")
        names = sorted(expected)
        if not names or any(not re.fullmatch(r"[a-zA-Z0-9_-]+", name) for name in names):
            raise ValueError("Unexpected engine source filename")
        if cache_dir is not None and not offline_cache:
            cache_dir.mkdir(parents=True, exist_ok=True)

        def load_module(name: str) -> bytes:
            path = cache_dir / f"{name}.py" if cache_dir is not None else None
            if offline_cache and (path is None or not path.exists()):
                raise ValueError(f"Offline cache is missing {name}")
            content = path.read_bytes() if path is not None and path.exists() else fetch(RAW_BASE + f"searx/engines/{name}.py")
            git_digest = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
            if git_digest != expected[name]:
                raise ValueError(f"Source content disagrees with pinned Git blob for {name}")
            if path is not None and not path.exists():
                path.write_bytes(content)
            return content

        with ThreadPoolExecutor(max_workers=8) as executor:
            modules = dict(zip(names, executor.map(load_module, names)))
        if cache_dir is not None and not offline_cache:
            (cache_dir / "settings.yml").write_bytes(settings)
            (cache_dir / "module-manifest.json").write_bytes(canonical_manifest(expected))
    if hashlib.sha256(settings).hexdigest() != SETTINGS_SHA256:
        raise ValueError("Pinned settings digest differs; do not silently regenerate from another revision")
    if hashlib.sha256(canonical_manifest(expected)).hexdigest() != MODULE_MANIFEST_SHA256:
        raise ValueError("Engine source manifest differs from the pinned revision")
    if set(modules) != set(expected):
        raise ValueError("Engine source files differ from the pinned module manifest")
    for name, content in modules.items():
        if len(content) > MAX_SOURCE_BYTES:
            raise ValueError(f"Source exceeds the inventory size bound for {name}")
        if hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest() != expected[name]:
            raise ValueError(f"Source content disagrees with pinned Git blob for {name}")
    return settings, modules


def static_value(node: ast.AST, values: dict[str, Any]) -> Any:
    """Read literals and literal aliases, never import or execute engine modules."""
    if isinstance(node, ast.Name) and node.id in values:
        return values[node.id]
    # EngineAbout is a TypedDict constructor. Parse its literal keywords as data;
    # do not call or import the constructor.
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "EngineAbout" and not node.args:
        if any(keyword.arg is None for keyword in node.keywords):
            raise ValueError("Dynamic EngineAbout expansion")
        return {keyword.arg: static_value(keyword.value, values) for keyword in node.keywords}
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        if isinstance(node, ast.Dict):
            result = {}
            for key, value in zip(node.keys, node.values):
                if key is None:
                    raise ValueError("Dynamic dictionary expansion")
                result[static_value(key, values)] = static_value(value, values)
            return result
        raise ValueError("Nonliteral source expression") from None


def module_metadata(content: bytes) -> dict[str, Any]:
    tree = ast.parse(content)
    values: dict[str, Any] = {}
    unresolved: set[str] = set()
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        for target in targets:
            if not isinstance(target, ast.Name):
                continue
            try:
                values[target.id] = static_value(node.value, values)
                unresolved.discard(target.id)
            except ValueError:
                values.pop(target.id, None)
                unresolved.add(target.id)
    return {"values": values, "unresolved": sorted(unresolved),
            "sha256": hashlib.sha256(content).hexdigest()}


def credential_paths(value: Any, prefix: str = "") -> list[str]:
    paths = []
    if isinstance(value, dict):
        for key, child in sorted(value.items()):
            path = f"{prefix}.{key}" if prefix else key
            if CREDENTIAL_KEYS.fullmatch(str(key)) or str(key).lower() == "authorization":
                paths.append(path)
            elif isinstance(child, dict):
                paths.extend(credential_paths(child, path))
    return paths


def endpoint_prerequisites(values: dict[str, Any]) -> list[str]:
    reasons = []
    for key in sorted(ENDPOINT_KEYS & values.keys()):
        value = values[key]
        if value is None or value == "" or value == []:
            reasons.append(f"configure {key}")
            continue
        if isinstance(value, list):
            for endpoint in value:
                reasons.extend(endpoint_prerequisites({key: endpoint}))
            continue
        if not isinstance(value, str) or not value.startswith(("http://", "https://")):
            continue
        try:
            host = urlsplit(value).hostname or ""
            if host in {"localhost", "example.com", "example.org"} or host.endswith((".localhost", ".local", ".internal", ".onion", ".example.com", ".example.org")):
                reasons.append(f"configure public {key} endpoint")
                continue
            try:
                address = ipaddress.ip_address(host)
            except ValueError:
                address = None
            if address is not None and not address.is_global:
                reasons.append(f"configure public {key} endpoint")
        except ValueError:
            reasons.append(f"review {key} endpoint")
    return reasons


def engine_record(setting: dict[str, Any], metadata: dict[str, Any], tabs: set[str], configured: bool = True,
                  configured_settings: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    values = dict(metadata["values"])
    values.update(setting)
    inherited_configuration = {}
    # Pinned yacy._base_url explicitly uses the named yacy engine's endpoint
    # when an image variant has no own base_url. Network sharing alone does not
    # imply this inheritance for any other engine.
    if setting["engine"] == "yacy" and not values.get("base_url") and configured_settings is not None:
        owner = configured_settings.get("yacy", {})
        if owner.get("base_url"):
            values["base_url"] = owner["base_url"]
            inherited_configuration["base_url"] = "yacy"
    about = dict(metadata["values"].get("about", {}))
    about.update(setting.get("about", {}))
    categories = values.get("categories", ["general"])
    if isinstance(categories, str):
        categories = [item.strip() for item in categories.split(",")]
    if not isinstance(categories, list) or any(not isinstance(item, str) for item in categories):
        raise ValueError(f"Invalid static categories for {setting['name']}")
    if not any(category in tabs for category in categories):
        categories = [*categories, "other"]
    engine_type = values.get("engine_type", "online")
    credentials = sorted(set(credential_paths(setting) + credential_paths(metadata["values"])))
    credential_requirements = list(REQUIRED_CREDENTIALS.get(setting["engine"], []))
    # This engine supports keyless custom instances, but its hosted default
    # explicitly returns no request without an API key.
    endpoints = values.get("base_url", [])
    endpoints = endpoints if isinstance(endpoints, list) else [endpoints]
    if setting["engine"] == "libretranslate" and endpoints and all(str(endpoint).startswith("https://libretranslate.com") for endpoint in endpoints):
        credential_requirements.append("api_key")
    credentials = sorted(set(credentials + credential_requirements))
    requires_credentials = (about.get("require_api_key") is True or bool(credential_requirements)
                            or bool(credential_paths(setting)))
    endpoint_reasons = endpoint_prerequisites(values)
    if "onions" in categories:
        endpoint_reasons.append("configure and authorize Tor egress")
    unresolved = [key for key in ("categories", "engine_type") if key in metadata["unresolved"] and key not in setting]
    inactive = bool(values.get("inactive", False))
    prerequisites = []
    if not str(engine_type).startswith("online"):
        classification = "offline_or_local"
        prerequisites.append("provision and authorize the local data/service dependency")
    elif endpoint_reasons:
        classification = "requires_configuration"
    elif requires_credentials:
        classification = "requires_credentials"
    elif inactive:
        classification = "inactive"
    elif unresolved or setting["engine"] in TEMPLATE_MODULES:
        classification = "manual_review"
    else:
        classification = "public_online"
    prerequisites.extend(endpoint_reasons)
    if requires_credentials:
        prerequisites.append("supply provider credentials through a secret-backed settings overlay")
    if inactive:
        prerequisites.append("review upstream inactive reason and explicitly activate only after a live probe")
    if unresolved:
        prerequisites.append("review nonliteral source metadata: " + ", ".join(unresolved))
    if setting["engine"] in TEMPLATE_MODULES:
        prerequisites.append("review demonstration/test implementation before defining an operational engine")
    if not configured:
        prerequisites.append("define a named engine configuration; this module is not an active settings.yml entry")
    return {
        "name": setting["name"], "engine": setting["engine"],
        "configured": configured, "categories": sorted(set(categories)),
        "engine_type": engine_type, "shortcut": setting.get("shortcut"),
        "upstream_disabled": bool(values.get("disabled", False)),
        "upstream_inactive": inactive,
        "network": setting.get("network"), "classification": classification,
        "auto_enable": configured and classification == "public_online",
        "requires_credentials": requires_credentials, "credential_setting_paths": credentials,
        "reviewed_required_credential_fields": sorted(credential_requirements),
        "required_configuration_fields": REQUIRED_CONFIGURATION.get(setting["engine"], []),
        "inherited_configuration": inherited_configuration,
        "prerequisites": sorted(set(prerequisites)),
        "website": about.get("website"),
        "official_api_documentation": about.get("official_api_documentation"),
        "uses_official_api": about.get("use_official_api"),
        "upstream_result_format": about.get("results"),
        "source_path": f"searx/engines/{setting['engine']}.py",
        "source_sha256": metadata["sha256"],
    }


def build_catalog(settings_data: bytes, modules: dict[str, bytes]) -> dict[str, Any]:
    settings = yaml.safe_load(settings_data)
    configured = settings["engines"]
    if len({item["name"] for item in configured}) != len(configured):
        raise ValueError("Upstream configured engine names are not unique")
    metadata = {name: module_metadata(content) for name, content in modules.items()}
    missing = {item["engine"] for item in configured} - metadata.keys()
    if missing:
        raise ValueError("Missing engine modules: " + ", ".join(sorted(missing)))
    tabs = set(settings["categories_as_tabs"])
    configured_settings = {item["name"]: item for item in configured}
    engines = [engine_record(item, metadata[item["engine"]], tabs, configured_settings=configured_settings)
               for item in sorted(configured, key=lambda item: item["name"])]
    configured_modules = {item["engine"] for item in configured}
    unconfigured = [engine_record({"name": name, "engine": name}, metadata[name], tabs, False)
                    for name in sorted(metadata.keys() - configured_modules)]
    enabled = [item["name"] for item in engines if item["auto_enable"]]
    policy = {"engines": enabled, "categories": {
        category: {"primary": pools[0], "fallbacks": pools[1:]} for category, pools in POLICY_POOLS.items()}}
    catalog = {
        "schema_version": 1,
        "source": {"repository": "https://github.com/searxng/searxng", "revision": REVISION,
                   "settings_url": RAW_BASE + "searx/settings.yml", "settings_sha256": SETTINGS_SHA256,
                   "module_manifest_sha256": MODULE_MANIFEST_SHA256,
                   "engine_loader_url": RAW_BASE + "searx/engines/__init__.py",
                   "metadata_method": "AST literals and literal EngineAbout keyword fields; engine code is never executed"},
        "evidence": "SOURCE_CONFIGURATION_INVENTORY_NOT_LIVE_PROVIDER_AVAILABILITY",
        "counts": {"configured_engines": len(engines), "engine_modules": len(metadata),
                   "unconfigured_modules": len(unconfigured), "auto_enable_candidates": len(enabled)},
        "engines": engines, "unconfigured_modules": unconfigured,
        "activation": {classification: [item["name"] for item in engines if item["classification"] == classification]
                       for classification in CLASSIFICATIONS},
        "runtime_policy": policy,
        "searxng_settings": {"use_default_settings": {"engines": {"keep_only": enabled}},
                            "engines": [{"name": name, "disabled": False} for name in enabled]},
    }
    validate_catalog(catalog)
    return catalog


def validate_catalog(catalog: dict[str, Any]) -> None:
    """Offline cross-layer contract check; does not claim live provider health."""
    if catalog.get("schema_version") != 1 or catalog["source"]["revision"] != REVISION:
        raise ValueError("Unexpected catalog schema or upstream revision")
    if catalog["source"]["settings_sha256"] != SETTINGS_SHA256:
        raise ValueError("Unexpected settings provenance")
    if catalog["source"]["module_manifest_sha256"] != MODULE_MANIFEST_SHA256:
        raise ValueError("Unexpected engine manifest provenance")
    records = catalog["engines"]
    by_name = {item["name"]: item for item in records}
    if len(by_name) != len(records):
        raise ValueError("Duplicate catalog engine name")
    if [item["name"] for item in records] != sorted(by_name):
        raise ValueError("Catalog engine records must use deterministic name order")
    unconfigured = catalog["unconfigured_modules"]
    if len({item["engine"] for item in unconfigured}) != len(unconfigured):
        raise ValueError("Duplicate unconfigured module")
    configured_modules = {item["engine"] for item in records}
    if configured_modules & {item["engine"] for item in unconfigured}:
        raise ValueError("Module is both configured and unconfigured")
    module_digests = {}
    for engine in [*records, *unconfigured]:
        if engine["classification"] not in CLASSIFICATIONS:
            raise ValueError("Unexpected classification")
        if engine["auto_enable"] != (engine["configured"] and engine["classification"] == "public_online"):
            raise ValueError(f"Auto-enable flag disagrees with classification for {engine['name']}")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", engine["engine"]) or engine["source_path"] != f"searx/engines/{engine['engine']}.py":
            raise ValueError("Unexpected engine source path")
        if not re.fullmatch(r"[0-9a-f]{64}", engine["source_sha256"]):
            raise ValueError("Unexpected engine source digest")
        if module_digests.setdefault(engine["engine"], engine["source_sha256"]) != engine["source_sha256"]:
            raise ValueError("Named entries disagree about their shared module digest")
    if any(not item["configured"] for item in records) or any(item["configured"] for item in unconfigured):
        raise ValueError("Configured module flags disagree with inventory arrays")
    expected_activation = {classification: [item["name"] for item in records if item["classification"] == classification]
                           for classification in CLASSIFICATIONS}
    if catalog["activation"] != expected_activation:
        raise ValueError("Activation buckets disagree with engine records")
    enabled = sorted(item["name"] for item in records if item["auto_enable"])
    expected_counts = {"configured_engines": len(records),
                       "engine_modules": len(configured_modules) + len(unconfigured),
                       "unconfigured_modules": len(unconfigured), "auto_enable_candidates": len(enabled)}
    if catalog["counts"] != expected_counts:
        raise ValueError("Catalog counts disagree with inventory")
    policy = catalog["runtime_policy"]
    backend = catalog["searxng_settings"]
    if policy["engines"] != enabled or backend["use_default_settings"]["engines"]["keep_only"] != enabled:
        raise ValueError("Runtime and backend engine inventories must match auto-enable candidates exactly")
    if backend["engines"] != [{"name": name, "disabled": False} for name in enabled]:
        raise ValueError("Backend overrides must explicitly enable exactly the permitted inventory")
    for name in enabled:
        engine = by_name[name]
        if engine["classification"] != "public_online" or engine["upstream_inactive"] or engine["requires_credentials"] or engine["prerequisites"]:
            raise ValueError(f"Unsafe implicit activation for {name}")
        network = engine["network"]
        if isinstance(network, str) and network in by_name and network not in enabled:
            raise ValueError(f"Enabled engine {name} refers to excluded network owner {network}")
        if any(owner not in enabled for owner in engine["inherited_configuration"].values()):
            raise ValueError(f"Enabled engine {name} inherits configuration from an excluded engine")
    if set(policy["categories"]) != set(CATEGORIES):
        raise ValueError("Runtime policy must define all five supported categories")
    for category, pools in policy["categories"].items():
        groups = [pools["primary"], *pools["fallbacks"]]
        flattened = [name for group in groups for name in group]
        if len(groups) > 3 or any(not 1 <= len(group) <= 4 for group in groups):
            raise ValueError(f"Invalid bounded pool sizes for {category}")
        if len(flattened) != len(set(flattened)):
            raise ValueError(f"Duplicate engines across {category} pools")
        for name in flattened:
            if name not in enabled or category not in by_name[name]["categories"]:
                raise ValueError(f"Engine {name!r} is not a ready {category} candidate")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "config/engine-catalog.json")
    parser.add_argument("--source-dir", type=Path, help="Clean upstream Git checkout at the pinned revision; avoids network access")
    parser.add_argument("--cache-dir", type=Path, help="Optional scratch cache; every cached module is verified against its pinned Git blob")
    parser.add_argument("--offline-cache", action="store_true", help="Use an already populated --cache-dir without any network access")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Rebuild from pinned source and require byte-for-byte equality")
    mode.add_argument("--validate", action="store_true", help="Validate the existing inventory/policy contract offline")
    args = parser.parse_args()
    try:
        if args.offline_cache and (args.cache_dir is None or args.source_dir is not None):
            raise ValueError("--offline-cache requires --cache-dir and cannot be combined with --source-dir")
        if args.validate:
            catalog = json.loads(args.output.read_text())
            validate_catalog(catalog)
        else:
            settings, modules = source_files(args.source_dir, args.cache_dir, args.offline_cache)
            catalog = build_catalog(settings, modules)
            rendered = json.dumps(catalog, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
            if args.check:
                if args.output.read_text() != rendered:
                    raise ValueError("Checked-in catalog differs from pinned source regeneration")
            else:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(rendered)
        print(json.dumps({"catalog": str(args.output), "counts": catalog["counts"],
                          "validation": "source inventory and runtime/backend policy consistency"}, sort_keys=True))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, yaml.YAMLError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
