import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("prepare_settings", ROOT / "charts/searxng-platform/files/prepare_settings.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SettingsBoundaryTests(unittest.TestCase):
    def test_private_overlay_cannot_open_reserved_output_or_network_boundaries(self):
        base = {"engines": [{"name": "allowed", "disabled": False}], "use_default_settings": True}
        private = {"server": {"secret_key": "fixture-only", "public_instance": True, "image_proxy": True},
                   "search": {"formats": ["html", "json"]}, "outgoing": {"verify": False},
                   "general": {"debug": True, "enable_metrics": True},
                   "engines": [{"name": "allowed", "api_key": "fixture-only"}, {"name": "unapproved"}]}
        with tempfile.TemporaryDirectory() as temporary:
            source, overlay = Path(temporary) / "base.yaml", Path(temporary) / "private.yaml"
            source.write_text(yaml.safe_dump(base))
            overlay.write_text(yaml.safe_dump(private))
            result = MODULE.prepare(source, overlay, "searxng", 8080, "http://search:8080", ["allowed"])
        self.assertEqual(result["search"]["formats"], ["json"])
        self.assertFalse(result["server"]["public_instance"])
        self.assertFalse(result["server"]["image_proxy"])
        self.assertEqual(result["server"]["secret_key"], "")
        self.assertTrue(result["outgoing"]["verify"])
        self.assertFalse(result["general"]["debug"])
        self.assertEqual(result["engines"], [{"name": "allowed", "disabled": False, "api_key": "fixture-only"}])
        self.assertEqual(result["use_default_settings"]["engines"]["keep_only"], ["allowed"])

    def test_browser_format_and_limiter_are_independent_of_private_overlay(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "base.yaml"
            source.write_text("use_default_settings: true\n")
            result = MODULE.prepare(source, None, "web", 8080, "https://search.example.invalid", ["bing"])
        self.assertEqual(result["search"]["formats"], ["html"])
        self.assertFalse(result["server"]["limiter"])
        self.assertEqual(result["server"]["base_url"], "https://search.example.invalid")

    def test_limiter_argument_is_removed_because_native_limiter_is_fixed_off(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "base.yaml"
            source.write_text("use_default_settings: true\n")
            completed = subprocess.run(
                [sys.executable, str(ROOT / "charts/searxng-platform/files/prepare_settings.py"),
                 "--source", str(source), "--destination", str(Path(temporary) / "out.yml"),
                 "--limiter-source", str(source), "--component", "web", "--port", "8080",
                 "--base-url", "https://search.example.invalid", "--engines", "bing",
                 "--limiter", "false"],
                capture_output=True, text=True, timeout=30, check=False)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("unrecognized arguments", completed.stderr)


if __name__ == "__main__":
    unittest.main()
