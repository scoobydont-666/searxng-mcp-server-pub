from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from create_principal import issue


class PrincipalTests(unittest.TestCase):
    def test_issue_stores_digest_and_keeps_token_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest, token = Path(temporary) / "principals.json", Path(temporary) / "token"
            issue(manifest, token, "client-one", ["api:search"], 120, "2099-01-01T00:00:00Z")
            secret = token.read_text().strip()
            principal = json.loads(manifest.read_text())["principals"][0]
            self.assertNotIn(secret, manifest.read_text())
            self.assertEqual(principal["token_sha256"], hashlib.sha256(secret.encode()).hexdigest())
            self.assertEqual(stat.S_IMODE(token.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(manifest.stat().st_mode), 0o600)
            before = manifest.read_bytes()
            with self.assertRaises(ValueError):
                issue(manifest, Path(temporary) / "another", "client-one", ["api:search"], 120, None)
            self.assertEqual(manifest.read_bytes(), before)

    def test_concurrent_issuance_does_not_lose_principals(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = [executor.submit(issue, root / 'principals.json', root / f'token-{n}',
                                           f'client-{n}', ["mcp:search"], 10, None) for n in range(8)]
                for future in futures:
                    future.result()
            principals = json.loads((root / 'principals.json').read_text())["principals"]
            self.assertEqual(len(principals), 8)
            self.assertEqual(len({p['token_sha256'] for p in principals}), 8)

    def test_invalid_expiry_and_paths_do_not_write_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for expiry in ["2099-01-01 00:00:00Z", "2099-01-01T00:00:00+00:00", "2020-01-01T00:00:00Z"]:
                with self.assertRaises(ValueError):
                    issue(root / 'principals.json', root / 'token', 'client', ["api:search"], 10, expiry)
                self.assertFalse((root / 'token').exists())
            with self.assertRaises(ValueError):
                issue(root / 'same', root / 'same', 'client', ["api:search"], 10, None)


if __name__ == '__main__':
    unittest.main()
