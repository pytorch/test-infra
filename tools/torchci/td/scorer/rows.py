"""Training rows: (TD-on job, test file) labels from day shards, plus counted trunk breaks.

- Positive: the file failed in the job (shards.py defines failed), unless it also failed
  in that config on main that day. A file that is neither (shards.py) is no row.
- Negative: the file ran and never failed; kept deterministically for NEG_RATE of
  (run, job, file) by a hash, weighted 1 / NEG_RATE.
- Per PR, job rows are scaled so the PR's positives weigh at most PR_POSITIVE_CAP, then
  its negatives so they weigh at most PR_NEGATIVE_CAP.
- Each counted trunk landing weighs W_TRUNK, split evenly over its (config, file) pairs.
"""

import hashlib
from array import array
from dataclasses import dataclass
from datetime import date
from statistics import median
from typing import Any, Iterable, Mapping

import numpy as np
from torchci.td.scorer.logs import active, TDLog
from torchci.td.scorer.shards import DayShard, Unit
from torchci.td.scorer.trunk import counted_pairs, TrunkLanding


NEG_RATE = 0.05
NEG_WEIGHT = 1 / NEG_RATE
PR_POSITIVE_CAP = 20.0
PR_NEGATIVE_CAP = 10000.0
W_TRUNK = 10.0
OVERHEAD_SECONDS = 24.0
# A file the config records under MIN_RUN_SECONDS skips there (a CUDA-only file on a
# CPU job); pytorch CI logs show such a file starting and exiting in about 3 s.
MIN_RUN_SECONDS = 1.0
SKIP_OVERHEAD_SECONDS = 3.0


def sampled(run_id: int, build_env: str, test_config: str, test_file: str) -> bool:
    key = f"{run_id}\0{build_env}\0{test_config}\0{test_file}".encode()
    value = int.from_bytes(hashlib.sha256(key).digest()[:8], "big")
    return value < NEG_RATE * 2**64


def unit_labels(unit: Unit) -> tuple[list[str], list[str]]:
    """(positives, all negatives) of a TD-on job."""
    failed, neither = set(unit.failed), set(unit.neither)
    positives = sorted(failed - set(unit.main_broken))
    negatives = [f for f in unit.ran if f not in failed and f not in neither]
    return positives, negatives


class JobTimes:
    """Per-file seconds as run_test.py looks them up in test-times.json: the job base
    name's entry for the test config, else "default"'s for the config, else
    "default"/"default"; a file without an entry gets the entry's median. A file's cost
    adds OVERHEAD_SECONDS, or SKIP_OVERHEAD_SECONDS under MIN_RUN_SECONDS."""

    def __init__(self, data: Mapping[str, Any]) -> None:
        self.data = data
        self._entries: dict[tuple[str, str], tuple[Mapping[str, float], float]] = {}

    def entry(self, job: str, config: str) -> tuple[Mapping[str, float], float]:
        key = (job, config)
        if key not in self._entries:
            default = self.data.get("default", {})
            if config in self.data.get(job, {}):
                times = self.data[job][config]
            elif config in default:
                times = default[config]
            else:
                times = default.get("default", {})
            mid = float(median(times.values())) if times else 0.0
            self._entries[key] = (times, mid)
        return self._entries[key]

    def seconds(self, job: str, config: str, test_file: str) -> float:
        times, mid = self.entry(job, config)
        return float(times.get(test_file, mid))

    def cost(self, job: str, config: str, test_file: str) -> float:
        seconds = self.seconds(job, config, test_file)
        if seconds < MIN_RUN_SECONDS:
            return seconds + SKIP_OVERHEAD_SECONDS
        return seconds + OVERHEAD_SECONDS


@dataclass
class Rows:
    heuristics: list[str]
    scores: np.ndarray  # (n, H) raw heuristic scores, 0 where none
    active: np.ndarray  # (n, H) the heuristic ran and did not raise
    build_envs: list[str]
    env: np.ndarray  # index into build_envs
    test_configs: list[str]
    config: np.ndarray  # index into test_configs
    cost: np.ndarray
    label: np.ndarray
    weight: np.ndarray  # base_weight after cap_per_pr over these rows
    pr: np.ndarray
    trunk: np.ndarray
    day: np.ndarray  # date.toordinal() of the row's shard or trunk landing
    base_weight: np.ndarray

    def __len__(self) -> int:
        return len(self.label)

    def subset(self, keep: np.ndarray) -> "Rows":
        """The rows where `keep` holds, with the per-PR cap applied over them alone."""
        return Rows(
            heuristics=self.heuristics,
            scores=self.scores[keep],
            active=self.active[keep],
            build_envs=self.build_envs,
            env=self.env[keep],
            test_configs=self.test_configs,
            config=self.config[keep],
            cost=self.cost[keep],
            label=self.label[keep],
            weight=cap_per_pr(
                self.base_weight[keep],
                self.label[keep],
                self.pr[keep],
                self.trunk[keep],
            ),
            pr=self.pr[keep],
            trunk=self.trunk[keep],
            day=self.day[keep],
            base_weight=self.base_weight[keep],
        )


COLUMNS = {
    "run": "q",
    "env": "q",
    "config": "q",
    "cost": "d",
    "label": "b",
    "weight": "d",
    "pr": "q",
    "trunk": "b",
    "day": "q",
}


class RowBuilder:
    """Collects rows column by column in typed arrays: a full-history window holds
    millions of rows."""

    def __init__(self, times: JobTimes) -> None:
        self.times = times
        self.cols: dict[str, Any] = {k: array(code) for k, code in COLUMNS.items()}
        self.sparse: dict[str, tuple[array, array]] = {}
        self.runs_active: list[frozenset[str]] = []
        self.active_sets: dict[frozenset[str], frozenset[str]] = {}
        self.envs: dict[str, int] = {}
        self.configs: dict[str, int] = {}

    def add_run(self, active: set[str]) -> int:
        key = frozenset(active)
        self.runs_active.append(self.active_sets.setdefault(key, key))
        return len(self.runs_active) - 1

    def add(
        self,
        run: int,
        scores: Mapping[str, Mapping[str, float]],
        build_env: str,
        test_config: str,
        test_file: str,
        label: int,
        weight: float,
        pr: int,
        day: int,
        trunk: bool = False,
    ) -> None:
        row = len(self.cols["label"])
        for h, per_file in scores.items():
            s = per_file.get(test_file)
            if s is not None:
                rows, values = self.sparse.setdefault(h, (array("q"), array("d")))
                rows.append(row)
                values.append(s)
        for col, value in (
            ("run", run),
            ("env", self.envs.setdefault(build_env, len(self.envs))),
            ("config", self.configs.setdefault(test_config, len(self.configs))),
            ("cost", self.times.cost(build_env, test_config, test_file)),
            ("label", label),
            ("weight", weight),
            ("pr", pr),
            ("trunk", trunk),
            ("day", day),
        ):
            self.cols[col].append(value)

    def add_shard(self, shard: DayShard, exclude_prs: set[int]) -> None:
        runs = {r.run_id: r for r in shard.runs}
        keys: dict[int, int] = {}
        day = date.fromisoformat(shard.day).toordinal()
        for unit in shard.units:
            run = runs[unit.run_id]
            if run.pr in exclude_prs:
                continue
            labels = unit_labels(unit)
            if run.run_id not in keys:
                keys[run.run_id] = self.add_run(active(run.heuristics, run.raised))
            key = keys[run.run_id]
            env, config = unit.build_env, unit.test_config
            for f in labels[0]:
                self.add(key, run.scores, env, config, f, 1, 1.0, run.pr, day)
            for f in labels[1]:
                if sampled(run.run_id, env, config, f):
                    self.add(
                        key, run.scores, env, config, f, 0, NEG_WEIGHT, run.pr, day
                    )

    def add_trunk(
        self,
        landings: Iterable[TrunkLanding],
        logs: Mapping[str, TDLog],
        exclude_prs: set[int],
    ) -> int:
        """Adds each landing's pairs that have a TD log at their PR's last head, on the
        landing's day; returns the number of landings added."""
        added = 0
        for landing in landings:
            pairs = counted_pairs(landing, logs, exclude_prs)
            day = date.fromisoformat(landing.day).toordinal()
            for p in pairs:
                log = logs[p.head_sha]
                key = self.add_run(active(log.heuristics, log.raised))
                weight = W_TRUNK / len(pairs)
                self.add(
                    key,
                    log.scores,
                    p.build_env,
                    p.test_config,
                    p.test_file,
                    1,
                    weight,
                    p.pr,
                    day,
                    trunk=True,
                )
            added += bool(pairs)
        return added

    def build(self) -> Rows:
        cols = {k: np.array(v) for k, v in self.cols.items()}
        n = len(cols["label"])
        heuristics = sorted(set(self.sparse) | set().union(*self.runs_active))
        scores = np.zeros((n, len(heuristics)))
        active = np.zeros((n, len(heuristics)), dtype=bool)
        for j, h in enumerate(heuristics):
            rows, values = self.sparse.get(h, (array("q"), array("d")))
            scores[np.array(rows, dtype=np.int64), j] = np.array(values, dtype=float)
            has = np.array([h in a for a in self.runs_active], dtype=bool)
            active[:, j] = has[cols["run"]] if n else False
        label = cols["label"].astype(np.int8)
        trunk = cols["trunk"].astype(bool)
        pr = cols["pr"].astype(np.int64)
        base = cols["weight"].astype(float)
        return Rows(
            heuristics=heuristics,
            scores=scores,
            active=active,
            build_envs=list(self.envs),
            env=cols["env"].astype(np.int64),
            test_configs=list(self.configs),
            config=cols["config"].astype(np.int64),
            cost=cols["cost"].astype(float),
            label=label,
            weight=cap_per_pr(base, label, pr, trunk),
            pr=pr,
            trunk=trunk,
            day=cols["day"].astype(np.int64),
            base_weight=base,
        )


def cap_per_pr(
    weight: np.ndarray, label: np.ndarray, pr: np.ndarray, trunk: np.ndarray
) -> np.ndarray:
    """Scales a PR's job rows so its positives weigh at most PR_POSITIVE_CAP, then its
    negative rows so they weigh at most PR_NEGATIVE_CAP; trunk rows keep their weight."""
    out = weight.copy()
    if not len(out):
        return out
    prs, idx = np.unique(pr, return_inverse=True)

    def capped(rows: np.ndarray, cap: float) -> np.ndarray:
        total = np.bincount(idx, weights=out * rows, minlength=len(prs))
        return np.minimum(1.0, cap / np.maximum(total, 1e-12))  # type: ignore[no-any-return]

    out[~trunk] *= capped((label == 1) & ~trunk, PR_POSITIVE_CAP)[idx[~trunk]]
    negative = (label == 0) & ~trunk
    out[negative] *= capped(negative, PR_NEGATIVE_CAP)[idx[negative]]
    return out
