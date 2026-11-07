#!/usr/bin/env python3
"""Transparent workload arithmetic, not a SearXNG performance benchmark."""
from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Workload:
    users: int
    searches_per_user_day: float = 20
    active_hours: float = 8
    active_fraction: float = 0.10
    search_interval_seconds: float = 30
    agent_searches_per_second: float = 5
    mean_search_seconds: float = 2
    engines_per_search: int = 4
    engine_retries: int = 0

    def __post_init__(self) -> None:
        for name in ("users", "searches_per_user_day", "active_hours", "search_interval_seconds", "mean_search_seconds", "engines_per_search"):
            value = getattr(self, name)
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f"{name} must be finite and positive")
        if not 0 <= self.active_fraction <= 1:
            raise ValueError("active_fraction must be between zero and one")
        if not math.isfinite(self.agent_searches_per_second) or self.agent_searches_per_second < 0:
            raise ValueError("agent_searches_per_second must be finite and nonnegative")
        if self.engine_retries < 0:
            raise ValueError("engine_retries must be nonnegative")

    def estimate(self) -> dict[str, object]:
        interactive_peak = self.users * self.active_fraction / self.search_interval_seconds
        peak = interactive_peak + self.agent_searches_per_second
        return {
            "evidence": "ASSUMPTION_MODEL_NOT_MEASURED",
            "inputs": asdict(self),
            "daily_searches": self.users * self.searches_per_user_day,
            "average_interactive_qps": round(self.users * self.searches_per_user_day / (self.active_hours * 3600), 3),
            "busy_interactive_qps": round(interactive_peak, 3),
            "busy_total_qps_including_agents": round(peak, 3),
            "concurrent_searches_at_mean_latency": math.ceil(peak * self.mean_search_seconds),
            "upstream_engine_rps_worst_retry_case": round(peak * self.engines_per_search * (1 + self.engine_retries), 3),
            "excludes": ["autocomplete", "page fetches and extraction", "additional pages", "provider-specific limits"],
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--users", type=int, nargs="+", default=[3000, 5000])
    parser.add_argument("--active-fraction", type=float, default=0.10)
    parser.add_argument("--agent-qps", type=float, default=5)
    parser.add_argument("--engines", type=int, default=4)
    parser.add_argument("--latency", type=float, default=2)
    args = parser.parse_args()
    try:
        result = [Workload(users=count, active_fraction=args.active_fraction,
                           agent_searches_per_second=args.agent_qps,
                           engines_per_search=args.engines,
                           mean_search_seconds=args.latency).estimate() for count in args.users]
    except ValueError as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
