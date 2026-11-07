#!/usr/bin/env python3
"""Check publication files without printing potentially sensitive matching text.

Optional private patterns stay outside the repository. This gate supplements,
and does not replace, independent human review of a clean-history export.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ALLOWED_TOP_LEVEL = {".containerignore", ".gitignore", ".github", "Containerfile", "Makefile",
                     "README.md", "NOTICE", "SECURITY.md", "LICENSE", "package.json", "package-lock.json",
                     "requirements-iac.txt", "tsconfig.json", "ansible", "charts", "config", "docs",
                     "environments", "examples", "gitops", "licenses", "load", "scripts", "src", "tests"}
FORBIDDEN_PARTS = {".git", "node_modules", "dist", ".secrets", "artifacts", ".venv", "__pycache__",
                   "reconciliation", "private", "credentials", "worktrees"}
RULES = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "cloud-access-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "github-credential": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b"),
    "bearer-secret": re.compile(r"(?i)bearer[ \t]+[A-Za-z0-9_-]{32,}"),
    "personal-home-path": re.compile(r"(?<![A-Za-z0-9:/])/(?:home|Users)/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]*"),
    "workspace-path": re.compile(r"/work" r"space/(?:scratch|[^/\s]+)[^\s\"'`]*"),
    "private-task-reference": re.compile(r"\b(?:task-[0-9]{4,}|pane:[0-9]+)\b"),
}
EMAIL = re.compile(r"\b[A-Za-z0-9_.+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b")
PRIVATE_PATH = re.compile(r"(?i)(?:^|[/_.-])(?:task-[0-9]{4,}|pane:[0-9]+)(?:$|[/_.-])")
SECRET_SUFFIXES = (".pem", ".key", ".bundle", ".log", ".local.yaml", ".local.yml",
                   ".p12", ".pfx", ".p8", ".jks", ".keystore", ".kdbx")


def scan_text(path: str, text: str, private_patterns: list[str] | None = None) -> list[tuple[str, int, str]]:
    findings = []
    for number, line in enumerate(text.splitlines(), 1):
        for rule, expression in RULES.items():
            if expression.search(line):
                findings.append((path, number, rule))
        # Upstream license notices retain legally required attribution.
        if not path.startswith("licenses/"):
            for email in EMAIL.findall(line):
                if not email.rsplit('@', 1)[1].endswith((".invalid", ".test", "example.com", "example.org", "example.net")):
                    findings.append((path, number, "non-example-email"))
        for pattern in private_patterns or []:
            if pattern.casefold() in line.casefold():
                findings.append((path, number, "operator-private-pattern"))
                break
    return findings


def approved_path(path: str) -> bool:
    candidate = Path(path)
    folded = {part.casefold() for part in candidate.parts}
    name = candidate.name.casefold()
    return (not candidate.is_absolute() and bool(candidate.parts) and candidate.parts[0] in ALLOWED_TOP_LEVEL
            and not folded & {part.casefold() for part in FORBIDDEN_PARTS}
            and not any(part in {"..", "."} for part in candidate.parts)
            and not name.endswith(SECRET_SUFFIXES)
            and not (name == ".env" or name.startswith(".env."))
            and PRIVATE_PATH.search(path) is None)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-pattern-file", type=Path,
                        help="Operator-owned JSON array outside this repository; never print or commit it")
    parser.add_argument("--history", action="store_true", help="Also scan reachable commit metadata; use on a clean export")
    args = parser.parse_args()
    patterns: list[str] = []
    if args.private_pattern_file:
        private_file = args.private_pattern_file.resolve()
        if private_file.is_relative_to(ROOT):
            parser.error("Keep private-pattern files outside the publication repository")
        patterns = json.loads(private_file.read_text())
        if not isinstance(patterns, list) or any(not isinstance(p, str) or len(p) < 3 for p in patterns):
            parser.error("Private patterns must be a JSON array of nonempty strings of at least three characters")
    result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                            cwd=ROOT, check=True, capture_output=True, timeout=15)
    paths = sorted(set(path for path in result.stdout.decode().split('\0') if path))
    findings = []
    for path in paths:
        file = ROOT / path
        if not approved_path(path):
            findings.append((path, 0, "unapproved-publication-path"))
            continue
        if file.is_symlink() or not file.is_file():
            findings.append((path, 0, "non-regular-or-missing-file"))
            continue
        try:
            text = file.read_text(encoding="utf-8")
        except UnicodeError:
            findings.append((path, 0, "unreviewed-binary-file"))
            continue
        findings.extend(scan_text(path, text, patterns))
    if args.history:
        metadata = subprocess.run(["git", "log", "--all", "--format=%an <%ae>%n%cn <%ce>%n%B"],
                                  cwd=ROOT, check=True, text=True, capture_output=True, timeout=15).stdout
        findings.extend(scan_text("git-history", metadata, patterns))
    for path, line, rule in sorted(set(findings)):
        print(f"{path}:{line}: {rule}")
    if findings:
        raise SystemExit("Publication scan failed; matching contents were deliberately not printed")
    print(f"Publication scan passed: {len(paths)} text files; "
          f"private-pattern check={'enabled' if patterns else 'not supplied'}; "
          f"history={'checked' if args.history else 'not checked'}")


if __name__ == "__main__":
    main()
