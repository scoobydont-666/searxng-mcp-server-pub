#!/usr/bin/env python3
"""Issue a high-entropy bearer key to a private file; store only its SHA-256 digest."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import tempfile

SCOPES = {"mcp:search", "mcp:fetch", "api:search"}


def issue(manifest: Path, token_file: Path, principal_id: str, scopes: list[str],
          rate_limit: int, expires_at: str | None) -> None:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}", principal_id) or principal_id == "legacy":
        raise ValueError("Invalid or reserved principal id")
    if not scopes or set(scopes) - SCOPES or len(set(scopes)) != len(scopes):
        raise ValueError("Choose unique scopes from mcp:search, mcp:fetch, api:search")
    if not 1 <= rate_limit <= 100000:
        raise ValueError("rate_limit must be between 1 and 100000")
    if expires_at:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z", expires_at):
            raise ValueError("Expiry must use RFC3339 UTC notation, for example 2027-11-06T12:00:00Z")
        parsed = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
        if parsed <= datetime.now(timezone.utc):
            raise ValueError("Expiry must be in the future")
    if manifest.resolve() == token_file.resolve() or manifest.is_symlink() or token_file.is_symlink():
        raise ValueError("Manifest and token must be separate regular files")
    manifest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    token_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock_fd = os.open(str(manifest) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        document = json.loads(manifest.read_text()) if manifest.exists() else {"principals": []}
        principals = document.get("principals")
        if not isinstance(principals, list) or any(p.get("id") == principal_id for p in principals):
            raise ValueError("Invalid manifest or duplicate principal id; rotate using a new id")
        if len(principals) >= 10000:
            raise ValueError("Principal limit reached")
        token = secrets.token_urlsafe(32)
        principal = {"id": principal_id, "token_sha256": hashlib.sha256(token.encode()).hexdigest(),
                     "scopes": scopes, "rate_limit": rate_limit}
        if expires_at:
            principal['expires_at'] = expires_at
        token_fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(token_fd, 'w') as handle:
            handle.write(token + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        principals.append(principal)
        temporary_name = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=manifest.parent, prefix='.principal-', delete=False) as handle:
                temporary_name = handle.name
                os.fchmod(handle.fileno(), 0o600)
                json.dump(document, handle, indent=2)
                handle.write('\n')
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, manifest)
        finally:
            if temporary_name and os.path.exists(temporary_name):
                os.unlink(temporary_name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--token-file', type=Path, required=True)
    parser.add_argument('--id', required=True)
    parser.add_argument('--scopes', required=True)
    parser.add_argument('--rate-limit', type=int, default=120)
    parser.add_argument('--expires-at')
    args = parser.parse_args()
    try:
        issue(args.manifest, args.token_file, args.id, args.scopes.split(','), args.rate_limit, args.expires_at)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    print(f"Issued credential into {args.token_file}; digest manifest updated at {args.manifest}. No secret printed.")


if __name__ == '__main__':
    main()
