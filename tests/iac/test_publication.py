import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from check_publication import approved_path, scan_text


class PublicationTests(unittest.TestCase):
    def test_paths_reject_secrets_binaries_and_internal_history(self):
        for path in [".secrets/token", "docs/reconciliation/notes.md", "artifacts/source.bundle",
                     "../outside", "/absolute", "config/private/settings.yaml", "site-values.local.yaml",
                     "docs/Private/notes.md", "charts/Credentials/note.md", "src/Worktrees/patch.diff",
                     "config/client.p12", "docs/" + "task-" + "1234567.md", "docs/" + "pane:" + "13.md"]:
            self.assertFalse(approved_path(path), path)
        for path in ["README.md", "scripts/check_publication.py", "examples/site-values.yaml.example"]:
            self.assertTrue(approved_path(path), path)

    def test_secret_findings_never_include_the_matched_value(self):
        fixture = "gh" + "p_" + "A" * 40
        findings = scan_text("config/example.txt", fixture)
        self.assertEqual(findings, [("config/example.txt", 1, "github-credential")])
        self.assertNotIn(fixture, str(findings))

    def test_private_patterns_are_external_inputs_and_case_insensitive(self):
        self.assertEqual(scan_text("README.md", "PrivateFixtureHost", ["privatefixturehost"]),
                         [("README.md", 1, "operator-private-pattern")])
        self.assertEqual(scan_text("README.md", "contributors@example.invalid"), [])
        self.assertEqual(scan_text("licenses/upstream.txt", "upstream@upstream.test"), [])


if __name__ == "__main__":
    unittest.main()
