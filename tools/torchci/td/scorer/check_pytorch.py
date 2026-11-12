"""check-pytorch: checks a model file against pytorch's TD scorer code.

It validates the model with pytorch's scorer_model.py, compares its p and r, the budget
constants, the build paths and change_features with the trainer's, and replays the gate's
cut (and its budget) with pytorch's select_tests, on a sample written by `refit --sample`
(or `--budget-sample` for the budget file). It exits 0 when all of that ran and matched,
SKIPPED when pytorch lacks the scorer code, else 1.
"""

import argparse
import importlib.util
import json
import logging
import math
import sys
from pathlib import Path
from typing import Any, Optional

from torchci.td.scorer import model_json, risk


logger = logging.getLogger(__name__)

MAX_DIFF = 1e-6
SKIPPED = 3
SCORER_DIR = Path("tools/testing/target_determination")


def _load_pytorch(module_path: Path) -> Optional[Any]:
    if not module_path.exists():
        return None
    spec = importlib.util.spec_from_file_location(
        "pytorch_td_scorer_model", module_path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _replay_cuts(root: Path, model: Any, jobs: list[dict[str, Any]]) -> Optional[int]:
    """Jobs whose selection or budget by pytorch's select_tests differs from the gate's,
    a NoModel from it taken as TD's include list with no budget; None when pytorch has no
    scorer.py or its scorer.py has no select_tests."""
    if not (root / SCORER_DIR / "scorer.py").exists():
        return None
    sys.path.insert(0, str(root))
    try:
        from tools.testing.target_determination import scorer  # type: ignore[import]
        from tools.testing.test_run import TestRun  # type: ignore[import]
    finally:
        sys.path.remove(str(root))
    if getattr(scorer, "select_tests", None) is None:
        return None
    no_model = getattr(scorer, "NoModel", ())
    mismatches = 0
    for job in jobs:
        block = {
            "model": model,
            "heuristics": job["heuristics"],
            "raised": job["raised"],
            "risk": job["r"],
            "build_files": job["build_files"],
        }
        try:
            selected, _, info = scorer.select_tests(
                block,
                [TestRun(f) for f in job["include"]],
                [TestRun(f) for f in job["exclude"]],
                job["times"],
                job["build_env"],
                job["test_config"],
            )
            files = sorted({t.test_file for t in selected})
            budget_ms = info.get("budget_ms")
        except no_model as e:
            logger.info("pytorch select_tests: %r; TD's cut", e)
            files, budget_ms = sorted(set(job["include"])), None
        mismatches += files != job["selected"] or budget_ms != job["budget_ms"]
    return mismatches


def _contract_problems(
    module: Any, paths: Any, model: dict[str, Any], rows: list[dict[str, Any]]
) -> list[str]:
    """How pytorch's budget rule differs from test-infra's: change_features on the
    sampled changes, and the budget constants (scorer_model.py) and build-path lists
    (scorer_paths.py, `paths`, None when pytorch has none), unless pytorch has no
    budget rule and the model no budget block."""
    files_rows = [row for row in rows if "files" in row]
    features_diff = sum(
        module.change_features(row["files"]) != risk.change_features(row["files"])
        for row in files_rows
    )
    print(
        f"change_features: {features_diff} of {len(files_rows)} sampled changes differ"
    )
    out = [] if files_rows else ["no sampled change has its files"]
    if features_diff:
        out.append(f"change_features differs on {features_diff} changes")
    if getattr(module, "budget_share", None) is None and "budget" not in model:
        print("budget rule: pytorch has none and the model has no budget block")
        return out
    pairs = [(n, module, model_json) for n in model_json.BUDGET_CONSTANTS]
    pairs += [(n, paths, risk) for n in risk.BUILD_PATH_CONSTANTS]
    diffs = [
        n for n, theirs, ours in pairs if getattr(theirs, n, None) != getattr(ours, n)
    ]
    if diffs:
        out.append(f"budget constants or build paths differ: {diffs}")
    else:
        print("budget constants and build paths: same as pytorch's")
    return out


def check_pytorch(args: argparse.Namespace) -> int:
    root = Path(args.pytorch_root)
    module = _load_pytorch(root / SCORER_DIR / "scorer_model.py")
    if module is None:
        print(
            f"SKIP: no {SCORER_DIR}/scorer_model.py in {root} (pytorch main does not have"
            " the TD scorer yet); the model was not checked against pytorch's validator"
        )
        return SKIPPED
    raw = Path(args.model).read_bytes()
    model = module.parse_model(raw)
    sample = json.loads(Path(args.sample).read_text())
    diffs = [
        module.file_probability(
            model,
            row["scores"],
            row["cost"],
            row["build_env"],
            row["test_config"],
            row["raised"],
        )
        - row["p"]
        for row in sample["p"]
    ]
    diffs += [
        module.risk_score(model, row["features"]) - row["r"] for row in sample["r"]
    ]
    if not diffs:
        print("FAIL: empty sample")
        return 1
    if not all(math.isfinite(d) for d in diffs):
        print("FAIL: a p or r difference is not finite")
        return 1
    worst = max(abs(d) for d in diffs)
    print(
        f"pytorch validator: ok; max |diff| of p and r over {len(diffs)} rows:"
        f" {worst:.3g}"
    )
    if worst > MAX_DIFF:
        print(f"FAIL: p or r differ from pytorch's by more than {MAX_DIFF}")
        return 1
    paths = _load_pytorch(root / SCORER_DIR / "scorer_paths.py")
    problems = _contract_problems(module, paths, model, sample["r"])
    if problems and "budget" in model:
        print(f"FAIL: the model has a budget block and pytorch differs: {problems}")
        return 1
    for problem in problems:
        print(f"WARNING (no budget block, so not a failure): {problem}")
    jobs = sample.get("jobs", [])
    mismatches = _replay_cuts(root, model, jobs)
    if mismatches is None:
        print(
            f"SKIP: no {SCORER_DIR}/scorer.py with select_tests: the cut was not"
            " replayed in pytorch"
        )
        return SKIPPED
    print(f"pytorch select_tests: {mismatches} of {len(jobs)} jobs select differently")
    return 0 if jobs and not mismatches else 1


def add_parser(sub: Any) -> None:
    c = sub.add_parser(
        "check-pytorch", help="check a model with pytorch's scorer_model.py"
    )
    c.add_argument("--model", required=True)
    c.add_argument("--sample", required=True)
    c.add_argument(
        "--pytorch-root",
        required=True,
        help="a pytorch checkout holding at least tools/testing and tools/stats",
    )
    c.set_defaults(func=check_pytorch)
