#!/usr/bin/env python3
"""Materialize a private settings overlay, then restore mandatory trust boundaries.

Runs with the pinned SearXNG image's own Python/PyYAML as an unprivileged init
container. No settings, credentials, URLs, or parser exception text are logged.
"""
import argparse
import os
from pathlib import Path
import shutil
import sys
import yaml


def read_mapping(path):
    with open(path, encoding="utf-8") as source:
        data = yaml.safe_load(source)
    if not isinstance(data, dict):
        raise ValueError("settings must be a mapping")
    return data


def merge(base, overlay):
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge(base[key], value)
        elif key == "engines" and isinstance(value, list) and isinstance(base.get(key), list):
            # Credentials overlay an engine by name without dropping activation
            # settings for the rest of the public catalog.
            by_name = {item.get("name"): item for item in base[key] if isinstance(item, dict)}
            for engine in value:
                if not isinstance(engine, dict) or not isinstance(engine.get("name"), str):
                    raise ValueError("invalid engine override")
                if engine["name"] in by_name:
                    merge(by_name[engine["name"]], engine)
                else:
                    base[key].append(engine)
        else:
            base[key] = value
    return base


def prepare(source, overlay, component, port, base_url, engines):
    data = read_mapping(source)
    if overlay:
        merge(data, read_mapping(overlay))
    for section in ("server", "search", "outgoing", "general"):
        if not isinstance(data.setdefault(section, {}), dict):
            raise ValueError("invalid reserved settings section")
    data["server"].update({
        "secret_key": "",  # The entrypoint imports the existing Secret via SEARXNG_SECRET.
        "bind_address": "0.0.0.0",
        "port": port,
        "base_url": base_url,
        "limiter": False,  # Both frontends have authenticated distributed admission; no client-IP forwarding.
        "public_instance": False,
        "image_proxy": False,
    })
    data["search"]["formats"] = ["html"] if component == "web" else ["json"]
    data["outgoing"]["verify"] = True
    data["general"]["debug"] = False
    data["general"]["enable_metrics"] = False
    if "pool_maxsize" in data["outgoing"]:
        raise ValueError("obsolete pool_maxsize")
    if not engines:
        raise ValueError("an explicit engine allowlist is required")
    defaults = data.get("use_default_settings", True)
    if defaults is not False:
        if defaults is True:
            defaults = {}
        if not isinstance(defaults, dict):
            raise ValueError("invalid use_default_settings")
        defaults["engines"] = {"keep_only": engines}
        data["use_default_settings"] = defaults
    if "engines" in data:
        if not isinstance(data["engines"], list):
            raise ValueError("engines must be a list")
        if any(not isinstance(engine, dict) or not isinstance(engine.get("name"), str) for engine in data["engines"]):
            raise ValueError("invalid engine definition")
        data["engines"] = [engine for engine in data["engines"] if engine["name"] in engines]
    if defaults is False and not data.get("engines"):
        raise ValueError("custom engine definitions are required with use_default_settings=false")
    return data


def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--overlay")
    parser.add_argument("--destination", required=True)
    parser.add_argument("--limiter-source", required=True)
    parser.add_argument("--component", choices=("searxng", "web"), required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--engines", required=True)
    args = parser.parse_args()
    try:
        data = prepare(args.source, args.overlay, args.component, args.port,
                       args.base_url, args.engines.split(","))
        destination = Path(args.destination)
        temporary = destination.with_suffix(".tmp")
        with open(temporary, "w", encoding="utf-8") as output:
            os.chmod(temporary, 0o600)
            yaml.safe_dump(data, output, sort_keys=False, allow_unicode=True)
        os.replace(temporary, destination)
        shutil.copyfile(args.limiter_source, destination.parent / "limiter.toml")
        os.chmod(destination.parent / "limiter.toml", 0o600)
    except Exception:
        print("Private settings preparation failed; verify settings structure and chart configuration.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
