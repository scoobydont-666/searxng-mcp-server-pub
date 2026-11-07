import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

import yaml

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from prepare_gitops import delivery_objects, merge_values, write_bundle, OWNER_LABEL
from validate_delivery import validate, check_existing_owner
REPOSITORY = "https://github.com/example-org/searxng-mcp-server-pub.git"
SERVICE_ACCOUNT = "searxng-deployer"


class DeliveryTests(unittest.TestCase):
    def bundle(self):
        return delivery_objects("a" * 40, "searxng-staging", "searxng-platform", "", {"mcp":{"apiEnabled":False}}, REPOSITORY, SERVICE_ACCOUNT)

    def test_promotion_is_pinned_and_suspended_until_explicitly_selected(self):
        bundle = self.bundle()
        validate(bundle, REPOSITORY)
        self.assertTrue(bundle[2]["spec"]["suspend"])
        self.assertEqual(bundle[1]["spec"]["ref"], {"commit":"a" * 40})
        self.assertEqual(bundle[2]["spec"]["targetNamespace"], "searxng-staging")

    def test_remote_cluster_or_source_injection_is_rejected(self):
        for kind, key, value in [
            (2, "kubeConfig", {"secretRef":{"name":"other-cluster"}}),
            (1, "include", [{"repository":{"name":"other"},"fromPath":".","toPath":"charts"}]),
            (2, "postRenderers", [{"kustomize":{"patches":[]}}]),
            (2, "releaseName", "unrelated"),
        ]:
            with self.subTest(key=key):
                bundle = self.bundle()
                bundle[kind]["spec"][key] = value
                with self.assertRaises(ValueError):
                    validate(bundle, REPOSITORY)

    def test_foreign_owned_resources_are_not_adopted(self):
        desired = self.bundle()[0]
        check_existing_owner(desired, None)
        check_existing_owner(desired, {"metadata":{"labels":OWNER_LABEL}})
        with self.assertRaises(ValueError):
            check_existing_owner(desired, {"metadata":{"labels":{"app.kubernetes.io/managed-by":"other"}}})
        with self.assertRaises(ValueError):
            delivery_objects("a" * 40, "unrelated-workload", "searxng-platform", "git-auth", {}, REPOSITORY, SERVICE_ACCOUNT)

    def test_source_identity_is_explicit_and_credentials_are_not_embedded(self):
        with self.assertRaises(ValueError):
            validate(self.bundle(), "https://github.com/example-org/different.git")
        for url in ["https://user:password@git.example.org/org/repo.git", "https://git.example.org/org/repo.git?token=fixture", "file:///tmp/repo.git"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                delivery_objects("a" * 40, "searxng", "searxng-platform", "", {}, url, SERVICE_ACCOUNT)
        with self.assertRaises(ValueError):
            delivery_objects("a" * 40, "searxng", "searxng-platform", "", {}, "ssh://git@git.example.org/org/repo.git", SERVICE_ACCOUNT)

    def test_overlay_maps_merge_but_lists_replace_without_mutating_inputs(self):
        base = {"mcp":{"apiEnabled":False,"allowedOrigins":["https://old.invalid"]}}
        original = copy.deepcopy(base)
        merged = merge_values(base, {"mcp":{"allowedOrigins":["https://new.invalid"]}})
        self.assertEqual(merged, {"mcp":{"apiEnabled":False,"allowedOrigins":["https://new.invalid"]}})
        self.assertEqual(base, original)

    def test_helmrelease_runs_as_a_namespace_scoped_service_account(self):
        bundle = self.bundle()
        self.assertEqual(bundle[2]["spec"]["serviceAccountName"], SERVICE_ACCOUNT)
        for service_account in ["", "default", "Bad_Name"]:
            with self.subTest(service_account=service_account), self.assertRaises(ValueError):
                delivery_objects("a" * 40, "searxng", "searxng-platform", "", {}, REPOSITORY, service_account)

    def test_validation_rejects_missing_or_default_service_account(self):
        for mutate in [lambda spec: spec.pop("serviceAccountName"),
                       lambda spec: spec.update({"serviceAccountName": ""}),
                       lambda spec: spec.update({"serviceAccountName": "default"})]:
            bundle = self.bundle()
            mutate(bundle[2]["spec"])
            with self.subTest(), self.assertRaises(ValueError):
                validate(bundle, REPOSITORY)

    def test_write_bundle_emits_committable_delivery_and_kustomization(self):
        bundle = self.bundle()
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "deployment" / "searxng"
            written = write_bundle(target, bundle)
            self.assertEqual([path.name for path in written], ["delivery.yaml", "kustomization.yaml"])
            documents = list(yaml.safe_load_all((target / "delivery.yaml").read_text()))
            kustomization = yaml.safe_load((target / "kustomization.yaml").read_text())
        validate(documents, REPOSITORY)
        self.assertEqual(kustomization, {"apiVersion": "kustomize.config.k8s.io/v1beta1",
                                         "kind": "Kustomization", "resources": ["delivery.yaml"]})


if __name__ == '__main__':
    unittest.main()
