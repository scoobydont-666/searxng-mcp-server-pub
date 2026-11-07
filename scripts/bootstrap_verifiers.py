#!/usr/bin/env python3
"""Install checksum-verified local verification tools without root or a container daemon."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

ASSETS = {
    "node": ("https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz",
             "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce"),
    "helm": ("https://get.helm.sh/helm-v3.19.0-linux-amd64.tar.gz",
             "a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496"),
    "kubeconform": ("https://github.com/yannh/kubeconform/releases/download/v0.7.0/kubeconform-linux-amd64.tar.gz",
                   "c31518ddd122663b3f3aa874cfe8178cb0988de944f29c74a0b9260920d115d3"),
    "valkey": ("https://github.com/valkey-io/valkey/archive/refs/tags/9.0.0.tar.gz",
               "088f47e167eb640ea31af48c81c5d62ee56321f25a4b05d4e54a0ef34232724b"),
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() not in {"x86_64", "amd64"}:
        parser.error("This verifier lock supports Linux x86_64; install independently verified tools on other systems")
    destination = args.directory.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        parser.error("Use a new empty destination to avoid trusting stale executable files")
    binaries = destination / "bin"
    binaries.mkdir()
    for name, (url, expected) in ASSETS.items():
        archive = destination / f"{name}.tar.gz"
        with urllib.request.urlopen(url, timeout=45) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        with archive.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                raise RuntimeError(f"{name}: checksum mismatch; refusing extraction or execution")
        extracted = destination / name
        extracted.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(extracted, filter="data")
        if name == "node":
            for command in ("node", "npm", "npx"):
                (binaries / command).symlink_to(extracted / "node-v22.23.4-linux-x64/bin" / command)
        elif name == "helm":
            shutil.copy2(extracted / "linux-amd64/helm", binaries / "helm")
        elif name == "kubeconform":
            shutil.copy2(extracted / "kubeconform", binaries / "kubeconform")
        else:
            source = extracted / "valkey-9.0.0"
            subprocess.run(["make", "-j2", "MALLOC=libc", "BUILD_TLS=no", "valkey-server"],
                           cwd=source, check=True, timeout=480, stdout=subprocess.DEVNULL)
            shutil.copy2(source / "src/valkey-server", binaries / "valkey-server")
        print(f"Verified and installed {name}")
    if os.environ.get("GITHUB_PATH"):
        with open(os.environ["GITHUB_PATH"], "a", encoding="utf-8") as output:
            output.write(f"{binaries}\n")
    print(f"Add {binaries} to PATH for local verification")


if __name__ == "__main__":
    main()
