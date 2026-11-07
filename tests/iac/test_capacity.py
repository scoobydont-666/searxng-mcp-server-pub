"""Acceptance examples for the capacity arithmetic and invalid workload guard."""
import importlib.util
from pathlib import Path
import sys
import unittest

SPEC = importlib.util.spec_from_file_location("capacity", Path(__file__).resolve().parents[2] / "scripts/capacity.py")
capacity = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = capacity
SPEC.loader.exec_module(capacity)


class CapacityTests(unittest.TestCase):
    def test_five_thousand_users_are_not_five_thousand_concurrent_searches(self):
        estimate = capacity.Workload(users=5000).estimate()
        self.assertEqual(estimate["daily_searches"], 100000)
        self.assertEqual(estimate["average_interactive_qps"], 3.472)
        self.assertEqual(estimate["busy_total_qps_including_agents"], 21.667)
        self.assertEqual(estimate["concurrent_searches_at_mean_latency"], 44)

    def test_fanout_and_retries_increase_provider_demand(self):
        estimate = capacity.Workload(users=3000, agent_searches_per_second=0, engine_retries=1).estimate()
        self.assertEqual(estimate["busy_interactive_qps"], 10)
        self.assertEqual(estimate["upstream_engine_rps_worst_retry_case"], 80)

    def test_invalid_workloads_do_not_produce_reassuring_estimates(self):
        for kwargs in ({"users": 0}, {"users": 5000, "active_fraction": 1.1},
                       {"users": 5000, "agent_searches_per_second": -1},
                       {"users": 5000, "mean_search_seconds": float('nan')}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                capacity.Workload(**kwargs)


if __name__ == '__main__':
    unittest.main()
