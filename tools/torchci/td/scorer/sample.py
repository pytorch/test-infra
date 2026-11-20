"""The sample check-pytorch replays in pytorch: p rows, r rows with their changed files,
and whole jobs with r, the build-file count and the budget. It includes jobs with an
unknown r, with build paths and with must-run files over the budget when the scanned
shards have them.
"""

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from torchci.td.scorer.cut import Evaluator, Job, job_budget
from torchci.td.scorer.risk import change_features, collect_heads, Head, risk_r
from torchci.td.scorer.rows import JobTimes
from torchci.td.scorer.shards import DayShard


SAMPLE_ROWS = 500
SAMPLE_JOBS = 30
SAMPLE_SCAN_JOBS = 2000
SAMPLE_FLAGS = ("null_r", "build_paths", "must_run_over_budget")


@dataclass
class Sample:
    """Rows check-pytorch replays: p per file, r per head, and whole cuts."""

    p: list[dict[str, Any]] = field(default_factory=list)
    r: list[dict[str, Any]] = field(default_factory=list)
    jobs: list[dict[str, Any]] = field(default_factory=list)
    flags: set[str] = field(default_factory=set)

    def dump(self) -> dict[str, Any]:
        return {"p": self.p, "r": self.r, "jobs": self.jobs}

    @property
    def full(self) -> bool:
        return len(self.p) >= SAMPLE_ROWS and len(self.jobs) >= SAMPLE_JOBS

    def add(self, ev: Evaluator, job: Job) -> None:
        """The job's p rows while p is short (a served job only: pytorch computes no p
        elsewhere), and its whole cut while jobs are short or it is a served job showing
        a SAMPLE_FLAGS case no sampled job showed yet (pytorch replays no budget for an
        unserved job: its NoModel gives none, so its budget_ms is None)."""
        if job.served and len(self.p) < SAMPLE_ROWS:
            stride = max(1, len(job.files) // 5)
            self.p.extend(
                {
                    "scores": {h: v[f] for h, v in job.run.scores.items() if f in v},
                    "raised": sorted(job.raised),
                    "cost": float(c),
                    "build_env": job.unit.build_env,
                    "test_config": job.unit.test_config,
                    "p": float(pi),
                }
                for f, c, pi in list(zip(job.files, job.costs, job.p))[::stride]
            )
        budget = job_budget(ev.model, job)
        must_ms = job.used_ms(job.must_run & set(job.files))
        cases = (job.r is None, bool(job.build_files), must_ms > budget["budget_ms"])
        flags = {name for name, on in zip(SAMPLE_FLAGS, cases) if on and job.served}
        if len(self.jobs) >= SAMPLE_JOBS and not flags - self.flags:
            return
        self.flags |= flags
        unit = job.unit
        self.jobs.append(
            {
                "heuristics": job.run.scores,
                "raised": sorted(job.raised | set(job.run.raised)),
                "include": sorted(job.include),
                "exclude": sorted(set(job.files) - job.include),
                "times": dict(ev.times.entry(unit.build_env, unit.test_config)[0]),
                "build_env": unit.build_env,
                "test_config": unit.test_config,
                "r": job.r,
                "build_files": job.build_files,
                "budget_ms": budget["budget_ms"] if job.served else None,
                "selected": sorted(ev.cuts(job).budgeted),
            }
        )


def sample_model(
    model: Mapping[str, Any], shards: Iterable[DayShard], times: JobTimes
) -> Sample:
    """Sample rows of the model on the shards' jobs and PR heads, until full; then up to
    SAMPLE_SCAN_JOBS more jobs for the SAMPLE_FLAGS cases no sampled job showed."""
    ev, sample = Evaluator(model, times), Sample()
    heads: dict[str, Head] = {}
    scanned = 0
    for shard in shards:
        collect_heads(shard, heads, exclude_prs=set())
        runs = {r.run_id: r for r in shard.runs}
        for unit in shard.units:
            done = sample.flags >= set(SAMPLE_FLAGS) or scanned >= SAMPLE_SCAN_JOBS
            if sample.full and done:
                break
            scanned += sample.full
            sample.add(ev, ev.prepare(runs[unit.run_id], unit))
        if sample.full and len(heads) >= SAMPLE_ROWS:
            break
    for h in list(heads.values())[:SAMPLE_ROWS]:
        features = change_features(h.files)
        sample.r.append(
            {"files": h.files, "features": features, "r": risk_r(model, features)}
        )
    return sample
