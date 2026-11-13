"""Claude's estimate of the test files a pytorch change can break, as a score per test
file for the `LLMSelection` heuristic of pytorch's target determination (TD).

    python -P -m torchci.td.llm_select.selector --pytorch ~/pytorch \
        --base origin/main --head HEAD --out llm_selection.json

The model reads the change's title, description and diff next to TD's test list and
names the files the change can break, each with a confidence (prompt.md). It has no
tools. The answer becomes one score per named file (SCORES, DIR_SCORE, RUN_ALL_SCORE),
written with what made it to `--out`:

    {"version": 1, "base_sha": ..., "head_sha": ..., "model": ..., "effort": ...,
     "scores": {"test_nn": 1.0, "dynamo/test_misc": 0.5, ...}, "run_all": false,
     "reason": ..., "unknown": [...], "changed_files": 12, "cost_usd": 0.31}

`scores` holds only names of the test list, with scores in (0, 1]; a file it leaves out
scores 0. No file is written when there is nothing to say: the change is too large to
read, or the model call or its answer failed (exit 1). pytorch's heuristic then raises,
which TD's scorer reads as "did not run", not as "nothing selected".

The test list is the `TESTS` that the working tree's `tools/testing/discover_tests.py`
computes, so `--pytorch` must be a checkout of trusted code (main in CI). The change is
only read through git, as the commits `--base` and `--head`: nothing of it is executed.
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Collection, Optional, Sequence

from torchci.td.llm import diff


logger = logging.getLogger(__name__)

VERSION = 1
SYSTEM_PROMPT = (Path(__file__).parent / "prompt.md").read_text()
DEFAULT_MODEL = (
    "global.anthropic.claude-opus-5-5"
    if os.environ.get("CLAUDE_CODE_USE_BEDROCK", "").lower() in ("1", "true", "yes")
    else "claude-opus-5-5"
)
EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_EFFORT = "medium"
# The score of a file by how the answer names it. TD's scorer calibrates a heuristic's
# score into the chance the file fails with a monotone table fitted on a year of TD
# logs, so only the order matters, and a changed value mixes two scales in that year.
SCORES = {"high": 1.0, "medium": 0.75, "low": 0.25}
DIR_SCORE = 0.5
RUN_ALL_SCORE = 0.125
DIFF_BUDGET = 120_000
BODY_BUDGET = 4_000
# A larger change is not worth an oversized prompt: no selection.
MAX_CHANGED_FILES = 1000
QUERY_TIMEOUT_SECONDS = 600
DISCOVER_TIMEOUT_SECONDS = 120
# Room for the note that replaces a truncated file's tail.
TRUNCATION_MARKER = 40
MAX_REASON_CHARS = 2000
MAX_UNKNOWN = 50
MAX_NAME_CHARS = 200
TESTS_CODE = (
    "import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1])['TESTS']))"
)
# The change's text is wrapped in these tags and the prompt marks it as untrusted, so
# the change must not be able to close them.
CLOSING_TAG_RE = re.compile(
    r"<\s*/\s*(pr_title|pr_description|changed_files|diff)\b(?:\s*(>))?",
    re.IGNORECASE,
)

REQUIRED = ("run_all", "reason", "dirs", "tests")
SCHEMA = {
    "type": "object",
    "properties": {
        "run_all": {
            "type": "boolean",
            "description": "true only if the change is so broad that no file can be"
            " ruled out",
        },
        "reason": {"type": "string", "description": "one or two sentences"},
        "dirs": {
            "type": "array",
            "items": {"type": "string"},
            "description": "test directory prefixes whose files the change can break,"
            " e.g. dynamo or inductor",
        },
        "tests": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file": {"type": "string"},
                    "confidence": {"type": "string", "enum": list(SCORES)},
                },
                "required": ["file", "confidence"],
            },
        },
    },
    "required": list(REQUIRED),
}


class SelectionError(RuntimeError):
    """The model call failed or its answer is not SCHEMA's."""


def truncate_diff(text: str, budget: int = DIFF_BUDGET) -> str:
    """Share the budget across files so that one huge generated file cannot crowd out
    the rest.

    Files under the fair share are kept whole and the rest of the budget is split evenly
    among the larger ones. A truncated file always keeps its `diff --git` line, so with
    hundreds of files the budget is soft."""
    if len(text) <= budget:
        return text
    parts = text.split("\ndiff --git ")
    parts = [parts[0]] + ["diff --git " + p for p in parts[1:]]
    remaining = budget - (len(parts) - 1)
    cap = 0
    for i, size in enumerate(sorted(len(p) for p in parts)):
        cap = remaining // (len(parts) - i)
        if size > cap:
            break
        remaining -= size
    out = []
    for p in parts:
        if len(p) <= cap:
            out.append(p)
            continue
        keep = max(cap - TRUNCATION_MARKER, len(p.split("\n", 1)[0]))
        out.append(f"{p[:keep]}\n... [{len(p) - keep} chars truncated]")
    return "\n".join(out)


def build_prompt(
    title: str, body: str, diffstat: str, diff_text: str, candidates: Sequence[str]
) -> str:
    body = body.strip()
    if len(body) > BODY_BUDGET:
        body = body[:BODY_BUDGET] + "\n...[truncated]"
    # Escape after truncating, so that a cut cannot make or split an escape.
    title, body, diffstat, diff_text = (
        CLOSING_TAG_RE.sub(r"<\\/\1\2", t)
        for t in (title, body, diffstat, truncate_diff(diff_text))
    )
    return "\n".join(
        [
            f"# PR title\n<pr_title>\n{title}\n</pr_title>",
            f"# PR description\n<pr_description>\n{body or '(none)'}\n</pr_description>",
            f"# Changed files\n<changed_files>\n{diffstat}\n</changed_files>",
            f"# Diff\n<diff>\n{diff_text}\n</diff>",
            f"# Candidate test files ({len(candidates)})",
            "\n".join(candidates),
            "\nName the test files this change can break. Use the exact names from the"
            " candidate list.",
        ]
    )


def query_model(
    prompt: str, model: str, effort: str, timeout: int = QUERY_TIMEOUT_SECONDS
) -> dict[str, Any]:
    """Run `claude -p` with no tools and return the CLI's JSON envelope (the answer
    under `structured_output`); SelectionError if the call fails."""
    command = [
        "claude",
        "-p",
        "--bare",
        "--no-session-persistence",
        "--model",
        model,
        "--effort",
        effort,
        "--system-prompt",
        SYSTEM_PROMPT,
        "--tools",
        "",
        "--output-format",
        "json",
        "--json-schema",
        json.dumps(SCHEMA),
    ]
    # An empty working directory keeps the CLI from picking up any project settings.
    with tempfile.TemporaryDirectory() as tmp:
        try:
            p = subprocess.run(
                command,
                input=prompt,
                capture_output=True,
                text=True,
                cwd=tmp,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            # Its message is mostly the claude argv, prompt included.
            raise SelectionError(f"model call timed out after {e.timeout}s") from None
        except (OSError, UnicodeError) as e:
            raise SelectionError(f"{type(e).__name__}: {e}") from None
    try:
        result = json.loads(p.stdout)
    except json.JSONDecodeError:
        result = None
    if p.returncode != 0 or not isinstance(result, dict):
        raise SelectionError((p.stdout + p.stderr)[-MAX_REASON_CHARS:])
    if result.get("is_error"):
        raise SelectionError(str(result.get("result"))[-MAX_REASON_CHARS:])
    return result


def normalize_name(name: str, candidates: Collection[str]) -> Optional[str]:
    """The candidate a model-written name such as `test/dynamo/test_misc.py` or
    `dynamo.test_misc::TestX` names, if any."""
    n = name.strip().split("::")[0]
    n = n.removeprefix("./").removeprefix("test/").removesuffix(".py")
    for m in (n, n.replace(".", "/")):
        if m in candidates:
            return m
    return None


def scores_from_answer(
    answer: Any, candidates: Sequence[str]
) -> tuple[dict[str, float], list[str]]:
    """The score of each candidate the answer names, and the names it gives that match
    no candidate; SelectionError if the answer is not SCHEMA's, or names files and
    directories of which none matches.

    A `tests` entry scores its confidence's SCORES value, whatever its directory; the
    other candidates under a `dirs` prefix score DIR_SCORE; and with `run_all`, every
    candidate left scores RUN_ALL_SCORE."""
    if not isinstance(answer, dict):
        raise SelectionError("the answer is not an object")
    if missing := sorted(set(REQUIRED) - answer.keys()):
        raise SelectionError(f"the answer lacks {missing}")
    tests, dirs = answer["tests"], answer["dirs"]
    if not isinstance(tests, list) or not all(
        isinstance(t, dict)
        and isinstance(t.get("file"), str)
        and t.get("confidence") in SCORES
        for t in tests
    ):
        raise SelectionError("tests is not a list of {file, confidence} objects")
    if not isinstance(dirs, list) or not all(isinstance(d, str) for d in dirs):
        raise SelectionError("dirs is not a list of strings")
    if not isinstance(answer["run_all"], bool):
        raise SelectionError("run_all is not a boolean")
    if not isinstance(answer["reason"], str):
        raise SelectionError("reason is not a string")
    known = set(candidates)
    scores = dict.fromkeys(candidates, RUN_ALL_SCORE) if answer["run_all"] else {}
    unknown = []
    for d in dirs:
        prefix = re.sub(r"(/\*\*?)?/*$", "", d.strip())
        prefix = prefix.removeprefix("./").removeprefix("test/")
        inside = [c for c in candidates if c.startswith(prefix + "/")]
        if not inside:
            unknown.append(d)
        scores.update(dict.fromkeys(inside, DIR_SCORE))
    named: dict[str, float] = {}
    for t in tests:
        name = normalize_name(t["file"], known)
        if name is None:
            unknown.append(t["file"])
        else:
            named[name] = max(named.get(name, 0.0), SCORES[t["confidence"]])
    scores.update(named)
    if unknown and not scores:
        raise SelectionError(f"no name of the answer is a test file: {unknown[:10]}")
    return scores, unknown


def candidate_tests(repo: Path) -> list[str]:
    """pytorch's TESTS without the C++ tests, as the working tree's discover_tests.py
    computes them. This runs that file, so the working tree must be trusted code."""
    script = repo / "tools" / "testing" / "discover_tests.py"
    with tempfile.TemporaryDirectory() as empty:
        env = {"PATH": os.environ.get("PATH", ""), "CPP_TESTS_DIR": empty}
        out = subprocess.run(
            [sys.executable, "-I", "-c", TESTS_CODE, str(script)],
            capture_output=True,
            text=True,
            check=True,
            cwd=empty,
            env=env,
            timeout=DISCOVER_TIMEOUT_SECONDS,
        ).stdout
    tests = json.loads(out)
    if not isinstance(tests, list) or not all(isinstance(t, str) for t in tests):
        raise RuntimeError(f"{script} gave no list of test names")
    return sorted(set(tests))


def commit(repo: Path, rev: str) -> str:
    if rev.startswith("-"):
        raise ValueError(f"not a revision: {rev!r}")
    return diff.git(
        repo, "rev-parse", "--verify", "--end-of-options", f"{rev}^{{commit}}"
    ).stdout.strip()


def pr_text(args: argparse.Namespace, head: str) -> tuple[str, str]:
    """The change's title and description: `--title` and `--body`, else the pull
    request of the GitHub event, else `head`'s commit message."""
    if args.title is not None:
        return args.title, args.body or ""
    event_path = os.environ.get("GITHUB_EVENT_PATH")
    if event_path and os.path.exists(event_path):
        with open(event_path) as f:
            pr = json.load(f).get("pull_request") or {}
        if pr:
            return pr.get("title") or "", pr.get("body") or ""
    message = diff.git(args.pytorch, "log", "-1", "--format=%s%n%b", head).stdout
    title, _, body = message.partition("\n")
    return title, body


def select(args: argparse.Namespace) -> Optional[dict[str, Any]]:
    """The selection file's content, or None when the change is too large to read (or
    after --print-prompt); SelectionError if the model call or its answer fails."""
    repo = args.pytorch
    head = commit(repo, args.head)
    base = diff.git(
        repo, "merge-base", "--end-of-options", commit(repo, args.base), head
    ).stdout.strip()
    revs = ["--end-of-options", base, head]
    names = diff.git(repo, "diff", "--name-only", "--no-renames", "-z", *revs).stdout
    changed = names.split("\0")[:-1]
    record: dict[str, Any] = {
        "version": VERSION,
        "base_sha": base,
        "head_sha": head,
        "model": args.model,
        "effort": args.effort,
        "scores": {},
        "run_all": False,
        "reason": "no changed files",
        "unknown": [],
        "changed_files": len(changed),
        "cost_usd": None,
    }
    if not changed and not args.print_prompt:
        return record
    if len(changed) > MAX_CHANGED_FILES and not args.print_prompt:
        print(f"LLM selection: none, {len(changed)} changed files")
        return None
    candidates = candidate_tests(repo)
    stat = diff.git(repo, "diff", "--stat=200", "--no-renames", "--no-color", *revs)
    title, body = pr_text(args, head)
    prompt = build_prompt(
        title, body, stat.stdout, diff.git_diff(repo, base, head), candidates
    )
    if args.print_prompt:
        print(prompt)
        return None
    result = query_model(prompt, args.model, args.effort)
    answer: Any = result.get("structured_output")
    scores, unknown = scores_from_answer(answer, candidates)
    record.update(
        scores=dict(sorted(scores.items())),
        run_all=answer["run_all"],
        reason=answer["reason"][:MAX_REASON_CHARS],
        unknown=[u[:MAX_NAME_CHARS] for u in unknown[:MAX_UNKNOWN]],
        cost_usd=result.get("total_cost_usd"),
    )
    return record


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -P -m torchci.td.llm_select.selector",
        description="Score pytorch's test files for a change with Claude.",
    )
    parser.add_argument(
        "--pytorch",
        type=Path,
        required=True,
        help="a pytorch checkout of trusted code that holds the --base and --head"
        " commits",
    )
    parser.add_argument(
        "--base", default="origin/main", help="diff against merge-base(base, head)"
    )
    parser.add_argument("--head", default="HEAD", help="the change to score tests for")
    parser.add_argument(
        "--title",
        help="the change's title; by default the GitHub event's pull request's, else"
        " head's commit subject",
    )
    parser.add_argument("--body", help="the change's description; needs --title")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--effort", default=DEFAULT_EFFORT, choices=EFFORTS)
    parser.add_argument("--out", type=Path, required=True, help="the selection file")
    parser.add_argument(
        "--print-prompt",
        action="store_true",
        help="print the prompt instead of calling the model; writes no file",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.body is not None and args.title is None:
        parser.error("--body needs --title")
    logging.basicConfig(level=logging.INFO)
    if not args.print_prompt:
        args.out.unlink(missing_ok=True)
    try:
        record = select(args)
    except SelectionError as e:
        print(f"LLM selection failed: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        logger.error("LLM selection failed: %s", e, exc_info=True)
        return 1
    if record is None:
        return 0
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=1) + "\n")
    by_score = sorted(Counter(record["scores"].values()).items(), reverse=True)
    print(
        f"LLM selection: {len(record['scores'])} test files, run_all="
        f"{record['run_all']}, by score {dict(by_score)}, {len(record['unknown'])}"
        " unknown names"
    )
    # json.dumps keeps a model-written newline from starting a workflow command, and
    # escaping "#" keeps the runner from parsing a legacy ##[command].
    print("LLM selection: " + json.dumps(record["reason"]).replace("#", "\\u0023"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
