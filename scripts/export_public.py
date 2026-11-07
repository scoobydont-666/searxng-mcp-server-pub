#!/usr/bin/env python3
"""Export the approved committed tree into a fresh, anonymous private-review repository."""

from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
AUTHOR_NAME = "SearXNG Platform Contributors"
AUTHOR_EMAIL = "contributors@example.invalid"
ROOT_FILES = {
    ".containerignore",
    ".dockerignore",
    ".editorconfig",
    ".gitattributes",
    ".gitignore",
    "README.md",
    "NOTICE",
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "CHANGELOG.md",
    "Containerfile",
    "Dockerfile",
    "Makefile",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "requirements-iac.txt",
}
ROOT_DIRECTORIES = {
    ".github",
    "ansible",
    "charts",
    "config",
    "docs",
    "environments",
    "examples",
    "gitops",
    "licenses",
    "load",
    "scripts",
    "src",
    "tests",
}
FORBIDDEN_PARTS = {
    ".git",
    ".secrets",
    "secrets",
    "node_modules",
    "dist",
    "artifacts",
    ".venv",
    "__pycache__",
    ".cache",
    ".kin",
    ".ai",
    "reconciliation",
    "private",
    "credentials",
    "worktrees",
}
PRIVATE_PATH = re.compile(r"(?i)(?:^|[/_.-])(?:task-[0-9]{4,}|pane:[0-9]+)(?:$|[/_.-])")


class ExportError(Exception):
    """Safe diagnostic without file contents or inherited Git metadata."""


def git_environment() -> dict[str, str]:
    # Prevent inherited Git worktrees, indexes, object stores, identities and config
    # from redirecting an operation or importing workstation metadata.
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"})
    return env


def run_git(directory: Path, *args: str, env: dict[str, str] | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "commit.gpgsign=false", *args],
        cwd=directory,
        env=env or git_environment(),
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ExportError(f"Git operation failed ({args[0]}); inspect the repository locally")
    return result.stdout


def inside(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def approved_path(path: str) -> bool:
    pure = PurePosixPath(path)
    if pure.is_absolute() or str(pure) != path or not pure.parts or "\\" in path or ":" in path:
        return False
    if any(part in {"", ".", ".."} or part.casefold() in FORBIDDEN_PARTS for part in pure.parts):
        return False
    if any(ord(character) < 32 or ord(character) == 127 for character in path):
        return False
    name = pure.name.casefold()
    if (
        name == ".env"
        or name.startswith(".env.")
        or name.endswith((".local.yaml", ".local.yml", ".log", ".pyc", ".pem", ".key", ".p12", ".pfx",
                          ".p8", ".jks", ".keystore", ".kdbx", ".bundle"))
        or PRIVATE_PATH.search(path) is not None
    ):
        return False
    return path in ROOT_FILES or (len(pure.parts) > 1 and pure.parts[0] in ROOT_DIRECTORIES)


def tracked_files() -> list[tuple[str, str, str]]:
    entries = []
    for record in run_git(ROOT, "ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode, object_id, stage = metadata.decode("ascii").split()
        path = raw_path.decode("utf-8")
        if stage != "0" or mode not in {"100644", "100755"}:
            raise ExportError(f"Unsupported tracked entry (symlink/submodule/conflict): {path}")
        if not approved_path(path):
            raise ExportError(f"Tracked path is outside the publication allowlist: {path}")
        entries.append((path, mode, object_id))
    if not entries:
        raise ExportError("The committed source tree is empty")
    if "scripts/check_publication.py" not in {path for path, _, _ in entries}:
        raise ExportError("The publication gate must be committed in scripts/check_publication.py")
    return entries


def publication_gate(directory: Path, history: bool = False, private_pattern_file: Path | None = None) -> None:
    command = [sys.executable, str(directory / "scripts/check_publication.py")]
    if history:
        command.append("--history")
    if private_pattern_file is not None:
        command.extend(["--private-pattern-file", str(private_pattern_file.resolve())])
    result = subprocess.run(command, cwd=directory, env=git_environment(), capture_output=True, check=False)
    if result.returncode:
        raise ExportError(
            "Publication gate failed; run scripts/check_publication.py locally for location-only findings"
        )


def export(output: Path, bundle: Path | None, private_pattern_file: Path | None = None) -> None:
    output = output.absolute()
    if output.is_symlink() or output.exists():
        raise ExportError("Output must be a new directory; existing paths are never overwritten")
    output = output.resolve()
    if not output.name.endswith("-pub") or output.name == "-pub":
        raise ExportError("Output directory basename must end in -pub")
    if inside(output, ROOT):
        raise ExportError("Output must be outside the source checkout")
    if not output.parent.is_dir():
        raise ExportError("Create the intended output parent directory first")
    if bundle is not None:
        if bundle.is_symlink() or bundle.exists():
            raise ExportError("Bundle output already exists; it will not be overwritten")
        bundle = bundle.resolve()
        if inside(bundle, ROOT) or inside(bundle, output):
            raise ExportError("Bundle must be outside both source and exported repositories")
        if not bundle.parent.is_dir():
            raise ExportError("Create the intended bundle parent directory first")

    if Path(run_git(ROOT, "rev-parse", "--show-toplevel").decode().strip()).resolve() != ROOT:
        raise ExportError("Run the committed exporter from its repository root")
    if run_git(ROOT, "status", "--porcelain=v1", "--untracked-files=all").strip():
        raise ExportError("Commit and review all source changes before exporting a clean tree")
    source_commit = run_git(ROOT, "rev-parse", "HEAD").strip()
    source_tree = run_git(ROOT, "rev-parse", "HEAD^{tree}").strip()
    object_format = run_git(ROOT, "rev-parse", "--show-object-format").decode().strip()
    entries = tracked_files()
    publication_gate(ROOT, private_pattern_file=private_pattern_file)

    output.mkdir(mode=0o755)
    try:
        for path, mode, object_id in entries:
            destination = output / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            # Read committed object bytes, never workspace/ignored-file contents.
            destination.write_bytes(run_git(ROOT, "cat-file", "blob", object_id))
            destination.chmod(0o755 if mode == "100755" else 0o644)

        with tempfile.TemporaryDirectory(prefix="searxng-empty-git-template-") as template:
            run_git(
                output, "init", "--initial-branch=main", f"--object-format={object_format}", f"--template={template}"
            )
        run_git(output, "config", "user.name", AUTHOR_NAME)
        run_git(output, "config", "user.email", AUTHOR_EMAIL)
        run_git(output, "config", "core.autocrlf", "false")
        run_git(output, "config", "core.filemode", "true")
        run_git(output, "add", "--all")
        if run_git(output, "write-tree").strip() != source_tree:
            raise ExportError("Exported index differs from the source HEAD tree; nothing may be filtered or rewritten")
        identity = git_environment()
        # A local-time commit would disclose the exporter's timezone offset.
        utc_now = f"@{int(time.time())} +0000"
        identity.update(
            {
                "GIT_AUTHOR_NAME": AUTHOR_NAME,
                "GIT_AUTHOR_EMAIL": AUTHOR_EMAIL,
                "GIT_COMMITTER_NAME": AUTHOR_NAME,
                "GIT_COMMITTER_EMAIL": AUTHOR_EMAIL,
                "GIT_AUTHOR_DATE": utc_now,
                "GIT_COMMITTER_DATE": utc_now,
            }
        )
        run_git(output, "commit", "--no-gpg-sign", "-m", "Initial public-source review snapshot", env=identity)
        if run_git(output, "log", "-1", "--format=%ai%n%ci").split()[2::3] != [b"+0000", b"+0000"]:
            raise ExportError("Exported commit dates must use UTC")
        if run_git(output, "rev-parse", "HEAD^{tree}").strip() != source_tree:
            raise ExportError("Exported commit differs from the source HEAD tree")
        if run_git(output, "rev-list", "--count", "--all").strip() != b"1":
            raise ExportError("Exported repository must contain exactly one root commit")
        if (
            run_git(output, "remote").strip()
            or run_git(output, "for-each-ref", "--format=%(refname)").strip() != b"refs/heads/main"
        ):
            raise ExportError("Exported repository unexpectedly contains a remote, tag, or additional ref")
        publication_gate(output, history=True, private_pattern_file=private_pattern_file)
        if (
            run_git(ROOT, "rev-parse", "HEAD").strip() != source_commit
            or run_git(ROOT, "status", "--porcelain=v1", "--untracked-files=all").strip()
        ):
            raise ExportError("Source changed during export; retry from a clean reviewed revision")

        if bundle is not None:
            # Stage the bundle beside its destination and publish with an exclusive
            # hard link, so a concurrent file cannot be overwritten.
            descriptor, name = tempfile.mkstemp(prefix=".searxng-public-", suffix=".bundle", dir=bundle.parent)
            os.close(descriptor)
            temporary = Path(name)
            try:
                run_git(output, "bundle", "create", str(temporary), "main")
                run_git(output, "bundle", "verify", str(temporary))
                os.link(temporary, bundle)
            finally:
                temporary.unlink(missing_ok=True)
    except Exception:
        # This directory was created exclusively by this invocation.
        shutil.rmtree(output)
        raise
    print(f"Exported {len(entries)} tracked files to {output}; identical committed tree, fresh anonymous main history")
    if bundle is not None:
        print(f"Created standalone main-only review bundle: {bundle}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--private-pattern-file", type=Path,
                        help="Operator-owned JSON array outside this repository; forwarded to the publication gate and never printed")
    args = parser.parse_args()
    try:
        export(args.output, args.bundle, args.private_pattern_file)
    except (ExportError, OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
