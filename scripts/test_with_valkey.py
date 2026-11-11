#!/usr/bin/env python3
"""Run the complete runtime suite with a disposable authenticated loopback Valkey."""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time


def main() -> int:
    binary = os.environ.get("VALKEY_SERVER") or shutil.which("valkey-server") or shutil.which("redis-server")
    if not binary:
        raise SystemExit("Install valkey-server/redis-server or set VALKEY_SERVER; distributed tests may not be skipped")
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="searxng-test-") as temporary:
        token = secrets.token_hex(32)
        config = Path(temporary) / "valkey.conf"
        config.write_text(f"bind 127.0.0.1\nport {port}\nprotected-mode yes\nsave \"\"\nappendonly no\nrequirepass {token}\ndir {temporary}\n")
        config.chmod(0o600)
        with (Path(temporary) / "valkey.log").open('w') as log:
            server = subprocess.Popen([binary, str(config)], stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if server.poll() is not None:
                        raise RuntimeError("Disposable Valkey failed to start; inspect your server installation")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError("Disposable Valkey startup deadline exceeded")
                environment = dict(os.environ, TEST_REDIS_URL=f"redis://:{token}@127.0.0.1:{port}/0")
                result = subprocess.run(["npm", "test", "--", "--maxWorkers=2"],
                                        env=environment, timeout=240, check=False)
                return result.returncode
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
