"""Stand-ins shared by the entry-point and sweep tests.

Every seam that reaches outside the process lives here, patched onto both
``__main__`` and ``sweep``: no model is invoked, no ClickHouse connection is
opened and no GitHub or git call is made. They live in one module because both
test files drive the same ``main()`` and two copies would drift.

``run_replay`` builds its scratch root under ``/tmp/greenlight-`` rather than in
an arbitrary temporary directory, because the path constraint the reviewer's
read sandbox imposes is one of the things under test.
"""

import contextlib
import csv
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import torchci.greenlight_replay.__main__ as cli
from torchci.greenlight_replay import sweep as sweep_module
from torchci.greenlight_replay.checkout import WorktreePool
from torchci.greenlight_replay.frame import (
    CANNED_TOO_LARGE_MESSAGES,
    FUNNEL_STAGES,
    LAND,
    Landing,
)
from torchci.greenlight_replay.runner import Outcome


POLICY_MODEL = "global.anthropic.claude-opus-5"
POLICY_MARKER = "policy-marker"
SANITIZE_RELPATH = ".claude/hooks/greenlight/sanitize-untrusted-checkout.sh"
SCRATCH_PREFIX = "greenlight-replay-test-"
VERDICTS = frozenset({"LAND", "NO_LAND"})
VALID_SCHEMA = '{"type": "object"}'
CANNED_TOO_LARGE = sorted(CANNED_TOO_LARGE_MESSAGES)[0]


def replay_row(pr_number, **extra):
    """One framed row, shaped like the decision export's CSV."""
    return {
        "pr_number": str(pr_number),
        "repo": "pytorch/pytorch",
        "base_ref": "main",
        "decision": "LAND",
        "decision_reason": "clean",
        "decision_head_sha": f"{pr_number:040d}",
        "decision_version": "2026-08-14T09:30:00.000Z",
        "lifecycle_status": "decided",
        "landed": "true",
        "verdict_staleness": "exact",
        **extra,
    }


def run_result(status="LAND", outcome=Outcome.SUCCESS):
    return SimpleNamespace(
        outcome=outcome,
        status=status,
        reason="clean",
        message="Only tests changed.",
        cost_usd=1.25,
        duration_s=540.0,
        model="claude-opus-5[1m]",
    )


class FakePool:
    """Lays slots out as the real pool does: ``<workspace>/pytorch``, one per slot."""

    def __init__(self, bare_clone, slots, repo_url=None):
        self.bare_clone = Path(bare_clone)
        self.slots = slots
        self.repo_url = repo_url
        self.slot_root = self.bare_clone.parent / f"{self.bare_clone.name}-slots"
        self.cloned = False
        self.acquired = []
        self._lock = threading.Lock()
        self._free = [
            self.slot_root / f"slot-{index}" / "pytorch" for index in range(slots)
        ]

    def ensure_clone(self):
        self.cloned = True

    def acquire(self, head_sha, *, pr_number=None):
        with self._lock:
            worktree = self._free.pop()
            self.acquired.append((worktree, head_sha, pr_number))
        worktree.mkdir(parents=True, exist_ok=True)
        return worktree

    def release(self, path):
        with self._lock:
            self._free.append(Path(path))

    @contextlib.contextmanager
    def checkout(self, head_sha, *, pr_number=None):
        worktree = self.acquire(head_sha, pr_number=pr_number)
        try:
            yield worktree
        finally:
            self.release(worktree)


class PoolFactory:
    """Stands in for the WorktreePool class, keeping its real workspace_of rule."""

    workspace_of = staticmethod(WorktreePool.workspace_of)

    def __init__(self, made):
        self.made = made

    def __call__(self, bare_clone, slots, repo_url=None):
        pool = FakePool(bare_clone, slots, repo_url)
        self.made.append(pool)
        return pool


class Fakes:
    """Stand-ins for every module the CLI orchestrates, plus what they recorded."""

    def __init__(
        self,
        rows,
        *,
        statuses=None,
        policy_claude=None,
        policy_model=POLICY_MODEL,
        policy_schema=VALID_SCHEMA,
        append_fails=None,
        decline_after=None,
        hooks_missing=False,
        too_large=False,
        outcomes=None,
        on_review=None,
    ):
        self.rows = [dict(row) for row in rows]
        self.statuses = dict(statuses or {})
        self.policy_claude = policy_claude or ("skills", "hooks")
        self.policy_model = policy_model
        self.policy_schema = policy_schema
        self.append_fails = set(append_fails or ())
        self.decline_after = decline_after
        self.hooks_missing = hooks_missing
        self.too_large = too_large
        self.outcomes = dict(outcomes or {})
        self.on_review = on_review
        self.checkpoint = {}
        self.pools = []
        self.workspaces = []
        self.reviewed = []
        self.comment_cutoffs = []
        self.models = []
        self.run_dirs = []
        self.written = []
        self.sanitize_log = None
        self.lock = threading.Lock()

    def install(self, stack, scratch):
        self.sanitize_log = Path(scratch) / "sanitize.log"
        entry_point = {
            "load_rows": self.load_rows,
            "connect": mock.MagicMock(),
            "fetch_landings": self.fetch_landings,
            "fetch_first_verdicts": lambda client, repo: {},
            "apply_frame": self.apply_frame,
            "rederive_first_landing": self.rederive_first_landing,
            "sample_rows": self.sample_rows,
            "load_checkpoint": self.load_checkpoint,
            "write_replay_csv": self.write_replay_csv,
        }
        machinery = {
            "materialize_policy": self.materialize_policy,
            "materialize_trusted_skills": self.materialize_trusted_skills,
            "WorktreePool": PoolFactory(self.pools),
            "build_inputs": self.build_inputs,
            "check_binaries": lambda path=None: None,
            "assert_hooks_present": self.assert_hooks_present,
            "run_review": self.run_review,
            "append_checkpoint": self.append_checkpoint,
        }
        for module, names in ((cli, entry_point), (sweep_module, machinery)):
            for name, replacement in names.items():
                stack.enter_context(mock.patch.object(module, name, replacement))
        return self

    def fetch_landings(self, client, repo):
        if self.decline_after is None:
            return {}
        # Two landings of kind "land" send the row down the re-derivation branch.
        return {
            self.decline_after: [
                Landing(kind=LAND, sha="a" * 40, ts=datetime(2026, 8, 1)),
                Landing(kind=LAND, sha="b" * 40, ts=datetime(2026, 8, 9)),
            ]
        }

    def rederive_first_landing(self, client, repo, row, first_land_ts):
        # The canned message frame.is_size_gate_decline matches on.
        return {
            **row,
            "decision": "NO_LAND",
            "decision_message": CANNED_TOO_LARGE,
        }

    def load_rows(self, path):
        return [dict(row) for row in self.rows]

    def apply_frame(self, rows, landings, first_verdicts=None):
        # Every stage the real one reports, so a caller touching a counter this
        # stub forgot fails here rather than in a sweep.
        rows = list(rows)
        stats = dict.fromkeys(FUNNEL_STAGES, 0)
        stats["input"] = len(rows)
        stats["kept"] = len(rows)
        return rows, stats

    def sample_rows(self, rows, *, frac, n, seed):
        return list(rows)

    def materialize_policy(self, ref, workdir, **kwargs):
        root = Path(workdir)
        for name in self.policy_claude:
            (root / ".claude" / name).mkdir(parents=True, exist_ok=True)
        (root / POLICY_MARKER).write_text(ref, encoding="utf-8")
        script = root / SANITIZE_RELPATH
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(
            "#!/bin/sh\n"
            f'printf "%s\\n" "$#|$1|$2" >> {self.sanitize_log}\n'
            '[ "$#" -eq 2 ] || exit 1\n',
            encoding="utf-8",
        )
        script.chmod(0o755)
        schema = root / ".claude/hooks/greenlight/verdict-schema.json"
        schema.write_text(self.policy_schema, encoding="utf-8")
        return SimpleNamespace(
            root=root,
            model=self.policy_model,
            ref=ref,
            sanitize_script=script,
            schema_path=schema,
        )

    def assert_hooks_present(self, policy):
        if self.hooks_missing:
            raise RuntimeError("hook scripts are missing")

    def materialize_trusted_skills(self, dest):
        dest = Path(dest)
        (dest / ".claude" / "skills").mkdir(parents=True, exist_ok=True)
        return dest

    def build_inputs(self, repo, pr, base_ref, head_sha, comments_before, run_dir, pol):
        with self.lock:
            self.comment_cutoffs.append(comments_before)
        return SimpleNamespace(too_large=self.too_large, diff_lines=10, diff_bytes=400)

    def run_review(self, policy, workspace, inputs, run_dir, **kwargs):
        pr_number = kwargs["pr_number"]
        with self.lock:
            self.workspaces.append(Path(workspace))
            self.reviewed.append(pr_number)
            self.models.append(kwargs["model"])
            self.run_dirs.append(Path(run_dir))
        if self.on_review is not None:
            self.on_review(pr_number)
        return run_result(
            status=self.statuses.get(pr_number, "LAND"),
            outcome=self.outcomes.get(pr_number, Outcome.SUCCESS),
        )

    def append_checkpoint(self, path, row, result):
        # Mirrors emit: a status outside the verdict vocabulary reaches no
        # column, a harness failure is recorded as a prefixed reason, and the
        # run metrics ride alongside so a resumed sweep can still total its cost.
        pr_number = int(row["pr_number"])
        if pr_number in self.append_fails:
            raise OSError("no space left on device")
        status = result.status if result.status in VERDICTS else ""
        reason = (
            result.reason
            if status
            else cli.HARNESS_REASON_PREFIX + result.outcome.name.lower()
        )
        self.checkpoint[pr_number] = {
            "new_decision": status,
            "new_decision_reason": reason,
            "new_decision_summary": result.message,
            "new_decision_message": result.message,
            "cost_usd": result.cost_usd,
            "duration_s": result.duration_s,
            # The identity matching_entries checks a resumed entry against.
            "repo": row.get("repo", ""),
            "base_ref": row.get("base_ref", ""),
            "decision_head_sha": row.get("decision_head_sha", ""),
        }

    def load_checkpoint(self, path):
        return dict(self.checkpoint)

    def write_replay_csv(self, path, rows):
        rows = list(rows)
        fields = list(rows[0]) if rows else ["pr_number", "new_decision"]
        with open(path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        self.written.append(Path(path))
        return len(rows)

    def unreachable(self, *args, **kwargs):
        raise AssertionError("this seam should not have been reached")


@contextlib.contextmanager
def run_replay(fakes, argv):
    """Run ``main`` over ``fakes`` in a real scratch root; yield (code, csv path)."""
    with tempfile.TemporaryDirectory(prefix=SCRATCH_PREFIX, dir="/tmp") as directory:
        root = Path(directory)
        output = root / "out.csv"
        with contextlib.ExitStack() as stack:
            fakes.install(stack, root)
            code = cli.main(
                [
                    "--input",
                    str(root / "in.csv"),
                    "--policy-pr",
                    "8830",
                    "--sample-frac",
                    "1.0",
                    "--workdir",
                    str(root / "work"),
                    "--output",
                    str(output),
                    *argv,
                ]
            )
        yield code, output


def read_csv(path):
    return list(csv.DictReader(path.read_text(encoding="utf-8").splitlines()))
