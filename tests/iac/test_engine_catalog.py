"""Offline regression checks for the engine inventory and activation contract."""

import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "engine_catalog_builder", ROOT / "scripts/build_engine_catalog.py"
)
catalog_builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog_builder)
CATALOG = json.loads((ROOT / "config/engine-catalog.json").read_text())


class EngineCatalogTests(unittest.TestCase):
    def setUp(self):
        self.catalog = copy.deepcopy(CATALOG)
        self.fetch_guard = patch.object(
            catalog_builder, "fetch", side_effect=AssertionError("Offline tests must not fetch sources")
        )
        self.fetch_guard.start()
        self.addCleanup(self.fetch_guard.stop)

    def record(self, name):
        return next(record for record in self.catalog["engines"] if record["name"] == name)

    def assert_rejected(self, message):
        with self.assertRaisesRegex(ValueError, message):
            catalog_builder.validate_catalog(self.catalog)

    def test_committed_catalog_validates_without_source_downloads(self):
        catalog_builder.validate_catalog(self.catalog)
        catalog_builder.fetch.assert_not_called()

    def test_ready_inventory_excludes_credentials_inactive_and_local_dependencies(self):
        allowed = set(self.catalog["runtime_policy"]["engines"])
        for record in self.catalog["engines"]:
            with self.subTest(engine=record["name"]):
                if record["requires_credentials"] or record["upstream_inactive"] or record["prerequisites"]:
                    self.assertFalse(record["auto_enable"])
                    self.assertNotIn(record["name"], allowed)
        for record in self.catalog["unconfigured_modules"]:
            with self.subTest(module=record["engine"]):
                self.assertFalse(record["auto_enable"])

    def test_reviewed_credential_and_endpoint_exceptions_remain_excluded(self):
        records = {record["name"]: record for record in
                   self.catalog["engines"] + self.catalog["unconfigured_modules"]}
        for name in ("github code", "spotify", "youtube_api", "wolframalpha_api", "tubearchivist", "libretranslate"):
            with self.subTest(engine=name):
                self.assertTrue(records[name]["requires_credentials"])
                self.assertFalse(records[name]["auto_enable"])
                self.assertTrue(records[name]["credential_setting_paths"])
        self.assertEqual(records["invidious"]["classification"], "requires_configuration")
        for name in ("caddy.community", "mymemory translated"):
            with self.subTest(optional_credentials=name):
                self.assertTrue(records[name]["auto_enable"])
        self.assertTrue(records["yacy images"]["auto_enable"])
        self.assertEqual(records["yacy images"]["inherited_configuration"], {"base_url": "yacy"})

    def test_runtime_inventory_must_match_backend_and_catalog_exactly(self):
        self.catalog["runtime_policy"]["engines"].pop()
        self.assert_rejected("inventories must match")

    def test_backend_keep_only_must_match_runtime_and_catalog_exactly(self):
        self.catalog["searxng_settings"]["use_default_settings"]["engines"]["keep_only"].pop()
        self.assert_rejected("inventories must match")

    def test_backend_override_cannot_reenable_an_excluded_engine(self):
        self.catalog["searxng_settings"]["engines"].append({"name": "braveapi", "disabled": False})
        self.assert_rejected("Backend overrides")

    def test_backend_override_cannot_leave_an_allowed_engine_disabled(self):
        self.catalog["searxng_settings"]["engines"][0]["disabled"] = True
        self.assert_rejected("Backend overrides")

    def test_new_credential_or_inactive_requirement_invalidates_existing_activation(self):
        for field, value in (
            ("requires_credentials", True),
            ("upstream_inactive", True),
            ("prerequisites", ["operator configuration required"]),
        ):
            with self.subTest(field=field):
                self.catalog = copy.deepcopy(CATALOG)
                self.record("bing")[field] = value
                self.assert_rejected("Unsafe implicit activation")

    def test_auto_enable_cannot_disagree_with_classification(self):
        self.record("braveapi")["auto_enable"] = True
        self.assert_rejected("Auto-enable flag disagrees")

    def test_all_supported_categories_are_required(self):
        self.catalog["runtime_policy"]["categories"].pop("science")
        self.assert_rejected("all five supported categories")

    def test_unknown_policy_categories_are_rejected(self):
        self.catalog["runtime_policy"]["categories"]["unbounded"] = {"primary": ["bing"], "fallbacks": []}
        self.assert_rejected("all five supported categories")

    def test_pool_cardinality_bounds_are_enforced(self):
        cases = (
            {"primary": [], "fallbacks": []},
            {"primary": ["bing"], "fallbacks": [[]]},
            {"primary": ["bing", "brave", "duckduckgo", "qwant", "yandex"], "fallbacks": []},
            {"primary": ["bing"], "fallbacks": [["brave"], ["duckduckgo"], ["qwant"]]},
        )
        for pools in cases:
            with self.subTest(pools=pools):
                self.catalog = copy.deepcopy(CATALOG)
                self.catalog["runtime_policy"]["categories"]["general"] = pools
                self.assert_rejected("Invalid bounded pool sizes")

    def test_duplicate_engines_within_or_across_attempts_are_rejected(self):
        for pools in (
            {"primary": ["bing", "bing"], "fallbacks": []},
            {"primary": ["bing"], "fallbacks": [["bing"]]},
        ):
            with self.subTest(pools=pools):
                self.catalog = copy.deepcopy(CATALOG)
                self.catalog["runtime_policy"]["categories"]["general"] = pools
                self.assert_rejected("Duplicate engines")

    def test_pool_engine_must_support_the_requested_category(self):
        self.catalog["runtime_policy"]["categories"]["science"]["primary"][0] = "bing"
        self.assert_rejected("not a ready science candidate")

    def test_excluded_or_unknown_engine_cannot_enter_a_pool(self):
        for name in ("braveapi", "nonexistent engine"):
            with self.subTest(engine=name):
                self.catalog = copy.deepcopy(CATALOG)
                self.catalog["runtime_policy"]["categories"]["general"]["primary"][0] = name
                self.assert_rejected("not a ready general candidate")

    def test_counts_are_checked_against_actual_inventory(self):
        for field in self.catalog["counts"]:
            with self.subTest(count=field):
                self.catalog = copy.deepcopy(CATALOG)
                self.catalog["counts"][field] += 1
                self.assert_rejected("Catalog counts disagree")

    def test_activation_buckets_are_checked_against_records(self):
        self.catalog["activation"]["public_online"].pop()
        self.assert_rejected("Activation buckets disagree")

    def test_pinned_source_provenance_cannot_silently_change(self):
        for field in ("revision", "settings_sha256", "module_manifest_sha256"):
            with self.subTest(field=field):
                self.catalog = copy.deepcopy(CATALOG)
                self.catalog["source"][field] = "0" * len(self.catalog["source"][field])
                self.assert_rejected("Unexpected")

    def test_source_path_and_digest_format_are_checked(self):
        for field, value in (("source_path", "../other.py"), ("source_sha256", "unverified")):
            with self.subTest(field=field):
                self.catalog = copy.deepcopy(CATALOG)
                self.record("bing")[field] = value
                self.assert_rejected("Unexpected engine source")

    def test_variants_cannot_disagree_about_shared_source_identity(self):
        self.record("brave.images")["source_sha256"] = "0" * 64
        self.assert_rejected("shared module digest")

    def test_network_or_configuration_owner_must_remain_enabled(self):
        self.record("bing")["network"] = "braveapi"
        self.assert_rejected("excluded network owner")
        self.catalog = copy.deepcopy(CATALOG)
        self.record("yacy images")["inherited_configuration"]["base_url"] = "braveapi"
        self.assert_rejected("inherits configuration from an excluded engine")

    def test_private_endpoint_arrays_are_not_public_candidates(self):
        reasons = catalog_builder.endpoint_prerequisites({"base_url": ["http://127.0.0.1:8080"]})
        self.assertIn("configure public base_url endpoint", reasons)

    def test_static_metadata_parser_never_executes_engine_code(self):
        metadata = catalog_builder.module_metadata(
            b'raise RuntimeError("MUST NOT EXECUTE")\nabout=EngineAbout(require_api_key=True)\n'
        )
        self.assertTrue(metadata["values"]["about"]["require_api_key"])

    def test_dynamic_assignment_does_not_retain_stale_literal_metadata(self):
        metadata = catalog_builder.module_metadata(b'categories=["general"]\ncategories=unknown_function()\n')
        self.assertNotIn("categories", metadata["values"])
        self.assertIn("categories", metadata["unresolved"])


if __name__ == "__main__":
    unittest.main()
