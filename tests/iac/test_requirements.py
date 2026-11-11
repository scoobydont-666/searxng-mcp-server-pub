from pathlib import Path
import re
import unittest

LOCK = Path(__file__).resolve().parents[2] / "requirements-iac.txt"
DIRECT = {"PyYAML", "jsonschema", "ansible-core"}


def parse(text):
    entries, current = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.endswith("\\"):
            line = line[:-1].strip()
        if "==" in line and not line.startswith("--hash"):
            name, _, version = line.partition("==")
            current = name.strip()
            entries[current] = {"version": version.strip(), "hashes": []}
        elif line.startswith("--hash=sha256:"):
            if current is None:
                raise ValueError("hash without a pinned requirement")
            entries[current]["hashes"].append(line.removeprefix("--hash=sha256:"))
        else:
            raise ValueError(f"unpinned or unsupported requirement line: {line}")
    return entries


class HashLockTests(unittest.TestCase):
    def setUp(self):
        self.entries = parse(LOCK.read_text())

    def test_every_distribution_is_exact_and_hashed(self):
        self.assertTrue(DIRECT <= set(self.entries))
        for name, entry in self.entries.items():
            with self.subTest(name=name):
                self.assertRegex(entry["version"], r"^[0-9][0-9A-Za-z.+!_-]*$")
                self.assertTrue(entry["hashes"], "missing sha256 digests")
                for digest in entry["hashes"]:
                    self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_direct_pins_are_unchanged(self):
        self.assertEqual(self.entries["PyYAML"]["version"], "6.0.3")
        self.assertEqual(self.entries["jsonschema"]["version"], "4.25.1")
        self.assertEqual(self.entries["ansible-core"]["version"], "2.19.15")

    def test_parser_rejects_unpinned_and_orphan_hashes(self):
        with self.assertRaises(ValueError):
            parse("PyYAML>=6.0\n")
        with self.assertRaises(ValueError):
            parse("--hash=sha256:" + "a" * 64 + "\n")
        self.assertEqual(
            parse("PyYAML==6.0.3 \\\n    --hash=sha256:" + "a" * 64 + "\n")["PyYAML"]["hashes"], ["a" * 64]
        )
        self.assertNotIn("PyYAML", parse("# PyYAML==6.0.3\n"))


if __name__ == "__main__":
    unittest.main()
