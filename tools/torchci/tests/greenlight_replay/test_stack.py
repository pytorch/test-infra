"""Tests for the stack step, its pins and their gate, and the ghstack context rebuild.

The rebuild reads the ghstack context back as of the replayed verdict. ``inputs._run``
is its one process seam, shared with the rest of the reviewer's inputs, so the rebuild
cases drive ``build_inputs`` through ``test_inputs``'s ``FakeGh`` with the GraphQL
answered from canned pages. Nothing here reaches GitHub.

The parity cases do shell out, on purpose: they run the awk programs out of the
repository's own workflow, through the same ``tr``, ``grep`` and ``sed`` the step pipes
them through, and its jq selection of a GitHub stack's entries on canned responses. The
step cases run the step's whole script under bash, with a fake ``gh``. A hand-copied
program could never tell you that the port still matches the shell it reproduces. A
missing awk, bash or jq fails them rather than skipping them.
"""

import dataclasses
import functools
import json
import os
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import yaml
from test_inputs import (
    completed,
    CUTOFF,
    FakeGh,
    GHSTACK_BASE_REF,
    HEAD_SHA,
    InputsTestCase,
    make_policy,
    PR_NUMBER,
    pr_payload,
    REPO,
)
from torchci.greenlight_replay import (
    policy as policy_mod,
    stack,
    stack_step,
    workflow as workflow_mod,
)


REPO_ROOT = Path(__file__).resolve().parents[4]
WORKFLOW = REPO_ROOT / workflow_mod.WORKFLOW_RELPATH

USER = "alice"
OWN_HEAD = f"gh/{USER}/7/head"
HEADER = (
    "Stack from [ghstack](https://github.com/ezyang/ghstack/tree/0.17.0) "
    "(oldest at bottom):"
)
TOP, MIDDLE, NEAREST, BELOW = 193121, 193120, 193119, 193117

BEFORE = "2026-08-30T10:00:00Z"
AT_CUTOFF = "2026-09-01T12:00:00Z"
AFTER = "2026-09-02T10:00:00Z"
TODAYS_BODY = "the body as it reads today"

LISTING_PIPELINE = r"""
set -euo pipefail
listed=$(tr -d '\r' | awk "$1")
if ! grep -qxF "$2" <<<"$listed"; then
  echo NOT_LISTED
  exit 0
fi
above=$(grep -xF -B "$3" "$2" <<<"$listed" | sed '$d')
for n in $above; do printf '%s\n' "$n"; done
"""

FAKE_GH = r"""#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_GH_DIR/calls"
case "$1 $2" in
  "pr view") cat "$FAKE_GH_DIR/pr-$3.json" ;;
  "api graphql") cat "$FAKE_GH_DIR/graphql.json" ;;
  "api --allow-escape-sequences") printf 'diff of %s\n' "${!#}" ;;
  *) echo "fake gh: unexpected call: $*" >&2; exit 2 ;;
esac
"""


def shipped_steps():
    document = workflow_mod.load(WORKFLOW)
    return stack_step.stack_steps(workflow_mod._steps(document))


def shipped_awk_programs(marker):
    (step,) = shipped_steps()
    programs = re.findall(r"awk '([^']*)'", step["run"])
    return [program for program in programs if marker in program]


def shipped_jq_programs(marker):
    (step,) = shipped_steps()
    programs = re.findall(r"jq [^'\n]*'([^']*)'", step["run"])
    return [program for program in programs if marker in program]


@functools.cache
def shipped_selection():
    (selection,) = shipped_jq_programs("sort_by(.position)")
    return selection


def run_selection(response):
    """The step's jq selection of a GitHub stack's PRs, run on ``response``.

    With the step's own flags: compact output, and this PR's number and the window as
    JSON numbers.
    """
    window = str(stack_step.SIBLINGS_ABOVE)
    return subprocess.run(
        ["jq", "-c", "--argjson", "number", str(PR_NUMBER)]
        + ["--argjson", "window", window, shipped_selection()],
        input=json.dumps(response).encode("utf-8"),
        capture_output=True,
        check=False,
    )


def head_oid(number):
    return format(number, "040x")


def stack_entry(position, number, state="OPEN", login=USER):
    author = None if login is None else {"login": login}
    pull = dict(number=number, title=f"PR {number}", state=state, author=author)
    return {
        "position": position,
        "pullRequest": dict(pull, headRefOid=head_oid(number)),
    }


def stack_response(nodes, *, login=USER, total=None, more=False):
    """What the step's GraphQL query answers for this PR, in a stack of ``nodes``."""
    entries = {
        "totalCount": len(nodes) if total is None else total,
        "pageInfo": {"hasNextPage": more},
        "nodes": list(nodes),
    }
    author = None if login is None else {"login": login}
    pull = {"author": author, "stack": {"entries": entries}}
    return {"data": {"repository": {"pullRequest": pull}}}


def raw_body(*lines, header=HEADER):
    return "\n".join([header, *lines, "", "Summary."])


def ghstack_body(*rows, header=HEADER):
    return raw_body(*(f"* {row}" for row in rows), header=header)


def listed_body():
    return ghstack_body(
        f"#{TOP}", f"#{MIDDLE}", f"#{NEAREST}", f"__->__ #{PR_NUMBER}", f"#{BELOW}"
    )


def edit(edited_at, text, deleted_at=None):
    return {"editedAt": edited_at, "deletedAt": deleted_at, "diff": text}


def pull_page(
    edits=(),
    *,
    head_ref=OWN_HEAD,
    created="2026-08-20T00:00:00Z",
    body=TODAYS_BODY,
    title="Fix the thing",
    next_cursor=None,
):
    return {
        "title": title,
        "headRefName": head_ref,
        "createdAt": created,
        "body": body,
        "userContentEdits": {
            "nodes": list(edits),
            "pageInfo": {
                "hasNextPage": next_cursor is not None,
                "endCursor": next_cursor,
            },
        },
    }


def listed_page(**kwargs):
    """A page whose one revision before the cutoff lists this PR below three others."""
    return pull_page([edit(BEFORE, listed_body())], **kwargs)


def sibling(
    number,
    *,
    commits=None,
    created="2026-08-20T00:00:00Z",
    closed=None,
    head_ref=None,
    events=0,
    total=None,
    base="b" * 40,
):
    commits = [("c" * 40, BEFORE)] if commits is None else commits
    return {
        "title": f"Sibling {number}",
        "createdAt": created,
        "closedAt": closed,
        "headRefName": head_ref or f"gh/{USER}/{number}/head",
        "baseRefOid": base,
        "commits": {
            "totalCount": len(commits) if total is None else total,
            "nodes": [
                {"commit": {"oid": oid, "committedDate": when}} for oid, when in commits
            ],
        },
        "timelineItems": {"filteredCount": events},
    }


def compare(base, head):
    return f"repos/{REPO}/compare/{base}...{head}"


def graphql_variables(argv):
    """``{name: (flag, value)}`` for one ``gh api graphql`` argv."""
    pairs = (
        (argv[index], argv[index + 1].split("=", 1)) for index in range(3, len(argv), 2)
    )
    return {key: (flag, value) for flag, (key, value) in pairs}


class StackGh(FakeGh):
    """``FakeGh`` also answering the stack's two queries and each sibling's compare.

    ``pages`` is keyed by the cursor that fetches it, None for the first page.
    ``head_ref`` is what ``gh pr view`` reports as the head branch.
    """

    def __init__(
        self, pages, siblings=(), diffs=None, failing=(), head_ref=OWN_HEAD, **kwargs
    ):
        super().__init__(payload=dict(pr_payload(), headRefName=head_ref), **kwargs)
        self.pages = pages
        self.siblings = dict(siblings)
        self.diffs = dict(diffs or {})
        self.failing = set(failing)

    def __call__(self, argv):
        endpoint = argv[-1]
        if argv[:2] == ["gh", "api"] and endpoint in self.failing:
            self.calls.append(list(argv))
            return completed(b"", 1, b"HTTP 502")
        if argv[:2] == ["gh", "api"] and endpoint in self.diffs:
            self.calls.append(list(argv))
            return completed(self.diffs[endpoint])
        return super().__call__(argv)

    def graphql(self, argv):
        variables = graphql_variables(argv)
        query = variables["query"][1]
        if "userContentEdits" in query:
            cursor = variables.get("cursor", (None, None))[1]
            data = {"repository": {"pullRequest": self.pages[cursor]}}
        else:
            aliases = re.findall(r"(\w+): pullRequest\(number: (\d+)\)", query)
            data = {
                "repository": {
                    alias: self.siblings[int(number)] for alias, number in aliases
                }
            }
        return completed(json.dumps({"data": data}).encode("utf-8"))

    def queries(self):
        return [call for call in self.calls if call[:3] == ["gh", "api", "graphql"]]

    def compares(self):
        return [
            call[-1]
            for call in self.calls
            if call[:2] == ["gh", "api"] and "/compare/" in call[-1]
        ]


def ghstack_policy(**caps):
    """A policy whose workflow collects a ghstack's stack context alone."""
    return dataclasses.replace(
        make_policy(**caps), stack_context=stack_step.StackContext.GHSTACK
    )


class StackTestCase(InputsTestCase):
    """``build_inputs`` under a policy whose workflow collects stack context."""

    def build_stack(self, gh, cutoff=CUTOFF):
        return self.build(gh, policy=ghstack_policy(), cutoff=cutoff)

    def stack_document(self, result):
        return json.loads(result.stack_path.read_text(encoding="utf-8"))

    def stacked_numbers(self, result):
        return [entry["number"] for entry in self.stack_document(result)["stack"]]

    def metadata_body(self, result):
        return json.loads(result.metadata_path.read_text(encoding="utf-8"))["body"]

    def assert_no_stack_files(self):
        self.assertFalse((self.run_dir / stack.STACK_FILENAME).exists())
        self.assertFalse((self.run_dir / stack.STACK_DIRNAME).exists())

    def leave_stale_stack(self):
        directory = self.run_dir / stack.STACK_DIRNAME
        directory.mkdir(parents=True)
        (directory / "1.diff").write_text("stale")
        (self.run_dir / stack.STACK_FILENAME).write_text("{}")

    def three_siblings(self):
        return {number: sibling(number) for number in (TOP, MIDDLE, NEAREST)}


class ListingParityTest(unittest.TestCase):
    """The listing parser reads a body exactly as the step's shell pipeline does."""

    BODIES = {
        "plain": ghstack_body("#5", "__->__ #4", "#3"),
        "crlf": ghstack_body("#5", "__->__ #4", "#3").replace("\n", "\r\n"),
        "cr_inside_a_row": ghstack_body("#1\r2", "__->__ #4"),
        "nbsp_for_the_space": raw_body("*\u00a0#5", "* __->__ #4"),
        "nbsp_trailing": ghstack_body("#5\u00a0", "__->__ #4"),
        "nel": ghstack_body("#5\x85* #6", "__->__ #4"),
        "vertical_tab": ghstack_body("#5\x0b* #6", "__->__ #4"),
        "form_feed": ghstack_body("#5\x0c", "__->__ #4"),
        "line_separator": ghstack_body("#5\u2028* #6", "__->__ #4"),
        "full_width_digit": ghstack_body("#\uff15", "__->__ #4"),
        "arabic_indic_digit": ghstack_body("#\u0665", "__->__ #4"),
        "full_width_digit_after_ascii": ghstack_body("#1\uff15", "__->__ #4"),
        "arabic_indic_digit_after_ascii": ghstack_body("#5\u0665", "__->__ #4"),
        "trailing_space": ghstack_body("#5 ", "__->__ #4"),
        "leading_zero": ghstack_body("#05", "__->__ #4"),
        "duplicate_rows": ghstack_body("#5", "#3", "#5", "__->__ #4"),
        "own_row_twice": ghstack_body("#5", "__->__ #4", "#4", "#3"),
        "second_header": "\n".join(
            [HEADER, "* #6", HEADER, "* #5", "* __->__ #4", "* #3"]
        ),
        "header_after_the_block": "\n".join(
            [HEADER, "* #6", "", HEADER, "* #5", "* __->__ #4"]
        ),
        "top_of_stack": ghstack_body("__->__ #4", "#3"),
        "not_listed": ghstack_body("#5", "#3"),
        "more_than_five_above": ghstack_body(
            "#11", "#10", "#9", "#8", "#7", "#6", "#5", "__->__ #4"
        ),
        "a_prefix_of_the_number": ghstack_body("#44", "__->__ #4", "#40"),
        "row_before_the_header": "* #9\n" + ghstack_body("#5", "__->__ #4"),
        "header_not_at_line_start": " " + ghstack_body("#5", "__->__ #4"),
        "byte_order_mark": "\ufeff" + ghstack_body("#5", "__->__ #4"),
        "header_only": HEADER,
        "empty": "",
    }

    @classmethod
    def setUpClass(cls):
        (cls.listing_awk,) = shipped_awk_programs("Stack from")

    def setUp(self):
        self.assertIsNotNone(
            shutil.which("awk"), "awk is required to check parity with the workflow"
        )

    def shell(self, script, body, *args):
        # jq -r ends the body it prints with a newline.
        completed_run = subprocess.run(
            ["bash", "-c", script, "parity", self.listing_awk, *args],
            input=body.encode("utf-8") + b"\n",
            capture_output=True,
            check=True,
        )
        return completed_run.stdout.decode("utf-8").splitlines()

    def test_the_listing_matches_the_awk_on_every_hostile_body(self):
        for name, body in self.BODIES.items():
            with self.subTest(name):
                awk = self.shell('tr -d "\\r" | awk "$1"', body)
                self.assertEqual(stack_step.listing(body), awk)

    def test_the_numbers_above_match_the_grep_and_sed_on_every_hostile_body(self):
        for name, body in self.BODIES.items():
            with self.subTest(name):
                window = str(stack_step.SIBLINGS_ABOVE)
                shell = self.shell(LISTING_PIPELINE, body, "4", window)
                expected = None if shell == ["NOT_LISTED"] else shell
                self.assertEqual(stack_step.listed_above(body, 4), expected)

    def test_the_hostile_bodies_exercise_both_exits_and_a_full_window(self):
        results = [stack_step.listed_above(body, 4) for body in self.BODIES.values()]
        self.assertIn(None, results)
        self.assertIn([], results)
        self.assertIn(["9", "8", "7", "6", "5"], results)


class CapParityTest(unittest.TestCase):
    """A sibling diff is capped byte for byte as the step's awk caps it."""

    DIFFS = {
        "empty": b"",
        "one_line": b"a\n",
        "unterminated": b"a\nb",
        "only_a_newline": b"\n",
        "blank_last_line": b"a\n\n",
        "crlf": b"a\r\nb\r\n",
        "latin_1": b"caf\xe9\n",
        "control_bytes": b"a\x0cb\x0bc\x85d\n",
        "long_line": b"x" * 200_000 + b"\n",
        "exactly_the_cap": b"x\n" * 2000,
        "one_over_the_cap": b"x\n" * 2001,
        "cap_plus_an_unterminated_line": b"x\n" * 2000 + b"y",
        "far_over_the_cap": b"line\n" * 5000,
    }

    @classmethod
    def setUpClass(cls):
        (cls.cap_awk,) = shipped_awk_programs("NR > 2000")

    def setUp(self):
        self.assertIsNotNone(
            shutil.which("awk"), "awk is required to check parity with the workflow"
        )

    def test_the_cap_matches_the_awk_on_every_diff(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "raw"
            for name, diff in self.DIFFS.items():
                with self.subTest(name):
                    raw.write_bytes(diff)
                    awk = subprocess.run(
                        ["awk", self.cap_awk, str(raw)],
                        capture_output=True,
                        check=True,
                    ).stdout
                    self.assertEqual(stack_step.cap_diff(diff), awk)

    def test_the_marker_replaces_everything_from_line_2001(self):
        capped = stack_step.cap_diff(b"x\n" * 2001)
        self.assertEqual(capped, b"x\n" * 2000 + b"[truncated]\n")


class NativeSelectionTest(unittest.TestCase):
    """The step's jq picks a GitHub stack's PRs above this one, as its listing does a
    ghstack's: the 5 entries directly above, kept if open and by this PR's author, top
    first, each compared against the head of the entry below it, kept or not.
    """

    def setUp(self):
        self.assertIsNotNone(
            shutil.which("jq"), "jq is required to check the workflow's selection"
        )

    def select(self, response):
        completed_run = run_selection(response)
        self.assertEqual(completed_run.returncode, 0, completed_run.stderr)
        return json.loads(completed_run.stdout)

    def assert_refused(self, response, message):
        completed_run = run_selection(response)
        self.assertNotEqual(completed_run.returncode, 0)
        self.assertEqual(completed_run.stdout, b"")
        self.assertIn(message, completed_run.stderr.decode("utf-8"))

    def picked(self, response):
        """``(number, base, head)`` per PR picked, each SHA as the number it encodes."""
        return [
            (entry["number"], int(entry["base"], 16), int(entry["head"], 16))
            for entry in self.select(response)
        ]

    def test_the_five_nearest_above_are_kept_top_first(self):
        above = range(PR_NUMBER + 1, PR_NUMBER + 8)
        nodes = [stack_entry(1, PR_NUMBER)]
        nodes += [stack_entry(position, n) for position, n in enumerate(above, 2)]
        expected = [
            (n, n - 1, n) for n in reversed(range(PR_NUMBER + 1, PR_NUMBER + 6))
        ]
        self.assertEqual(self.picked(stack_response(nodes)), expected)

    def test_a_skipped_entry_is_still_the_base_of_the_one_above_it(self):
        nodes = [
            stack_entry(1, 501),
            stack_entry(2, PR_NUMBER),
            stack_entry(3, 503, state="CLOSED"),
            stack_entry(4, 504, login="bob"),
            stack_entry(5, 505),
            stack_entry(6, 506, state="MERGED"),
            stack_entry(7, 507),
        ]
        expected = [(507, 506, 507), (505, 504, 505)]
        self.assertEqual(self.picked(stack_response(nodes)), expected)

    def test_this_pr_in_the_middle_ignores_the_entries_below(self):
        nodes = [
            stack_entry(1, 501),
            stack_entry(2, 502),
            stack_entry(3, PR_NUMBER),
            stack_entry(4, 504),
        ]
        self.assertEqual(self.picked(stack_response(nodes)), [(504, PR_NUMBER, 504)])

    def test_the_top_of_the_stack_keeps_nothing(self):
        nodes = [stack_entry(1, 501), stack_entry(2, PR_NUMBER)]
        self.assertEqual(self.select(stack_response(nodes)), [])

    def test_entries_are_ordered_by_position_not_by_node_order(self):
        nodes = [
            stack_entry(4, 504),
            stack_entry(2, 502),
            stack_entry(1, PR_NUMBER),
            stack_entry(3, 503),
        ]
        expected = [(504, 503, 504), (503, 502, 503), (502, PR_NUMBER, 502)]
        self.assertEqual(self.picked(stack_response(nodes)), expected)

    def test_a_pr_with_no_author_login_keeps_no_sibling(self):
        nodes = [
            stack_entry(1, PR_NUMBER, login=None),
            stack_entry(2, 502, login=None),
        ]
        self.assertEqual(self.select(stack_response(nodes, login=None)), [])

    def test_each_selected_pr_carries_what_the_step_reads_and_its_title_as_given(self):
        title = "$(touch /tmp/x) `id` \"quoted\" 'single'\nsecond line"
        nodes = [stack_entry(1, PR_NUMBER), stack_entry(2, 502)]
        nodes[1]["pullRequest"]["title"] = title
        self.assertEqual(
            self.select(stack_response(nodes)),
            [
                {
                    "number": 502,
                    "title": title,
                    "base": head_oid(PR_NUMBER),
                    "head": head_oid(502),
                }
            ],
        )

    def test_outside_a_stack_the_selection_is_null(self):
        response = stack_response([])
        response["data"]["repository"]["pullRequest"]["stack"] = None
        self.assertIsNone(self.select(response))

    def test_an_incomplete_list_of_entries_is_refused(self):
        nodes = [stack_entry(1, PR_NUMBER), stack_entry(2, 502)]
        # jq sorts a null node before any position: one above this PR would otherwise
        # have #503 compared against this PR's head, past the entry left out.
        null_above = [stack_entry(1, PR_NUMBER), None, stack_entry(3, 503)]
        null_below = [None, stack_entry(2, PR_NUMBER), stack_entry(3, 503)]
        null_pull = [
            stack_entry(1, PR_NUMBER),
            dict(position=2, pullRequest=None),
            stack_entry(3, 503),
        ]
        for name, response in (
            ("another page", stack_response(nodes, more=True)),
            ("fewer nodes than the count", stack_response(nodes, total=3)),
            ("a null node above this PR", stack_response(null_above)),
            ("a null node below this PR", stack_response(null_below)),
            ("a null pull request", stack_response(null_pull)),
        ):
            with self.subTest(name):
                self.assert_refused(response, "incomplete")

    def test_a_stack_that_does_not_list_this_pr_once_is_refused(self):
        twice = [stack_entry(1, PR_NUMBER), stack_entry(2, PR_NUMBER)]
        for name, nodes in (("missing", [stack_entry(1, 501)]), ("twice", twice)):
            with self.subTest(name):
                self.assert_refused(stack_response(nodes), "this PR once")


class PinTest(unittest.TestCase):
    """The pin matches the step the repository's workflow actually runs."""

    def test_the_shipped_workflow_has_exactly_one_stack_step(self):
        self.assertEqual(len(shipped_steps()), 1)

    def test_the_shipped_step_digests_to_the_pin(self):
        (step,) = shipped_steps()
        self.assertEqual(stack_step.step_digest(step), stack_step.STEP_SHA256)

    def test_the_step_sets_the_window_the_port_reads_above(self):
        (step,) = shipped_steps()
        self.assertIn(f"\nwindow={stack_step.SIBLINGS_ABOVE}\n", step["run"])


class StepScriptTest(unittest.TestCase):
    """The step's whole script, run with ``bash -e`` as the runner runs a ``run:``.

    ``gh`` is a fake on PATH: ``gh pr view <n>`` prints ``pr-<n>.json``, ``gh api
    graphql`` prints ``graphql.json``, and a compare prints a one-line diff naming its
    endpoint. The script's one change is a path substitution: ``/tmp/greenlight-stack``
    becomes a directory under the test's own root, which is also mktemp's ``TMPDIR``.
    """

    ABOVE, TOP = PR_NUMBER + 1, PR_NUMBER + 2
    COMPARE = "repos/pytorch/pytorch/compare"

    def setUp(self):
        self.assertIsNotNone(shutil.which("jq"), "jq is required to run the step")
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.stack_dir = self.root / stack_step.STACK_DIRNAME
        self.stack_json = self.root / stack_step.STACK_FILENAME
        gh = self.root / "bin" / "gh"
        gh.parent.mkdir()
        gh.write_text(FAKE_GH, encoding="utf-8")
        gh.chmod(0o755)

    def serve(self, name, answer):
        (self.root / name).write_text(json.dumps(answer), encoding="utf-8")

    def run_step(self, pr=None, graphql=None):
        """Run the step for ``PR_NUMBER``, ``pr`` being what ``gh pr view`` reports."""
        shutil.rmtree(self.stack_dir, ignore_errors=True)
        self.stack_json.unlink(missing_ok=True)
        (self.root / "calls").unlink(missing_ok=True)
        own = dict(
            number=PR_NUMBER, title="Fix the thing", headRefName="a/fix", body=""
        )
        self.serve(f"pr-{PR_NUMBER}.json", {**own, **(pr or {})})
        if graphql is not None:
            self.serve("graphql.json", graphql)
        (step,) = shipped_steps()
        script = step["run"].replace(stack_step.CI_STACK_DIR, str(self.stack_dir))
        (self.root / "step.sh").write_text(script, encoding="utf-8")
        env = dict(
            os.environ,
            PATH=f"{self.root / 'bin'}:{os.environ['PATH']}",
            PR_NUMBER=str(PR_NUMBER),
            GH_TOKEN="unused",
            FAKE_GH_DIR=str(self.root),
            TMPDIR=str(self.root),
        )
        return subprocess.run(
            ["bash", "-e", "step.sh"],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def calls(self):
        return (self.root / "calls").read_text(encoding="utf-8")

    def assert_dropped(self, completed_run):
        """Exit 0, the step's warning, and no stack file left behind."""
        self.assertEqual(completed_run.returncode, 0, completed_run.stderr)
        warning = "::warning::could not collect the stack context"
        self.assertIn(warning, completed_run.stdout)
        self.assertFalse(self.stack_dir.exists())
        self.assertFalse(self.stack_json.exists())

    def stack_of_three(self):
        return [
            stack_entry(1, PR_NUMBER),
            stack_entry(2, self.ABOVE),
            stack_entry(3, self.TOP),
        ]

    def test_a_github_stack_writes_the_json_and_each_diff(self):
        completed_run = self.run_step(graphql=stack_response(self.stack_of_three()))
        self.assertEqual(completed_run.returncode, 0, completed_run.stderr)
        self.assertIn("(PRs: 3)", completed_run.stdout)
        document = json.loads(self.stack_json.read_text(encoding="utf-8"))
        self.assertEqual(
            [entry["number"] for entry in document["stack"]],
            [self.TOP, self.ABOVE, PR_NUMBER],
        )
        self.assertEqual(
            document["stack"][0]["diff"], f"{self.stack_dir}/{self.TOP}.diff"
        )
        for number, below in ((self.TOP, self.ABOVE), (self.ABOVE, PR_NUMBER)):
            written = (self.stack_dir / f"{number}.diff").read_text(encoding="utf-8")
            endpoint = f"{self.COMPARE}/{head_oid(below)}...{head_oid(number)}"
            self.assertEqual(written, f"diff of {endpoint}\n")

    def test_outside_a_stack_nothing_is_written(self):
        response = stack_response([])
        response["data"]["repository"]["pullRequest"]["stack"] = None
        completed_run = self.run_step(graphql=response)
        self.assertEqual(completed_run.returncode, 0, completed_run.stderr)
        self.assertIn("Not in a stack; no stack context.", completed_run.stdout)
        self.assertNotIn("::warning::", completed_run.stdout)
        self.assertFalse(self.stack_dir.exists())
        self.assertFalse(self.stack_json.exists())

    def test_a_pr_number_that_is_not_a_number_drops_the_context(self):
        self.assert_dropped(self.run_step(pr=dict(number=f"{PR_NUMBER}a")))
        self.assertNotIn("graphql", self.calls())

    def test_a_number_or_sha_of_another_shape_in_the_plan_drops_the_context(self):
        # The top goes first, so a bad base further down meets the step only after the
        # top's diff is on disk, and the trap has that to remove too.
        cases = {
            "this PR's head, a base above it": (0, "headRefOid", "g" * 40, True),
            "the top's head": (2, "headRefOid", head_oid(self.TOP)[:-1], False),
            "the top's number": (2, "number", f"{self.TOP}/x", False),
        }
        for name, (index, key, value, top_written) in cases.items():
            with self.subTest(name):
                nodes = self.stack_of_three()
                nodes[index]["pullRequest"][key] = value
                self.assert_dropped(self.run_step(graphql=stack_response(nodes)))
                self.assertEqual(self.COMPARE in self.calls(), top_written)

    def test_a_null_entry_drops_the_context(self):
        nodes = [stack_entry(1, PR_NUMBER), None, stack_entry(3, self.TOP)]
        self.assert_dropped(self.run_step(graphql=stack_response(nodes)))
        self.assertNotIn(self.COMPARE, self.calls())

    def test_a_ghstack_sibling_base_outside_the_ref_rule_drops_the_context(self):
        body = ghstack_body(f"#{self.ABOVE}", f"__->__ #{PR_NUMBER}")
        pr = dict(headRefName=OWN_HEAD, body=body)
        sibling = dict(
            number=self.ABOVE,
            title="Above",
            state="OPEN",
            headRefName=f"gh/{USER}/8/head",
            headRefOid=head_oid(self.ABOVE),
        )
        good = f"gh/{USER}/8/base"
        self.serve(f"pr-{self.ABOVE}.json", dict(sibling, baseRefName=good))
        completed_run = self.run_step(pr=pr)
        self.assertEqual(completed_run.returncode, 0, completed_run.stderr)
        written = (self.stack_dir / f"{self.ABOVE}.diff").read_text(encoding="utf-8")
        self.assertEqual(
            written, f"diff of {self.COMPARE}/{good}...{head_oid(self.ABOVE)}\n"
        )
        for base in (f"{good}#x", f"{good}%2E%2E%2Emain", f"gh/{USER}/../base", "-x"):
            with self.subTest(base):
                self.serve(f"pr-{self.ABOVE}.json", dict(sibling, baseRefName=base))
                self.assert_dropped(self.run_step(pr=pr))
                self.assertNotIn(self.COMPARE, self.calls())


class GateTest(unittest.TestCase):
    """Policy load finds the step by shape and refuses one stack.py cannot reproduce."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "policy"

    def materialize(self, mutate):
        """The shipped policy tree, materialized after ``mutate`` edits its workflow."""
        document = workflow_mod.load(WORKFLOW)
        (steps,) = [
            job["steps"]
            for job in document["jobs"].values()
            if stack_step.stack_steps(job.get("steps", []))
        ]
        (step,) = stack_step.stack_steps(steps)
        mutate(steps, step)
        workflow_path = self.root / workflow_mod.WORKFLOW_RELPATH
        workflow_path.parent.mkdir(parents=True, exist_ok=True)
        workflow_path.write_text(
            yaml.safe_dump(document, sort_keys=False), encoding="utf-8"
        )
        hooks = self.root / policy_mod.HOOKS_RELPATH
        hooks.mkdir(parents=True, exist_ok=True)
        for name in (
            policy_mod.SCHEMA_FILENAME,
            policy_mod.TOO_LARGE_FILENAME,
            policy_mod.SANITIZE_FILENAME,
        ):
            shutil.copy(REPO_ROOT / policy_mod.HOOKS_RELPATH / name, hooks / name)
        with mock.patch.object(policy_mod, "_checkout"):
            return policy_mod.materialize("8830", self.root)

    def test_the_repositorys_own_policy_collects_both_kinds_of_stack_context(self):
        with mock.patch.object(policy_mod, "_checkout"):
            policy = policy_mod.materialize("main", REPO_ROOT)
        self.assertIs(policy.stack_context, stack_step.StackContext.BOTH)

    def test_the_unchanged_step_survives_a_yaml_round_trip(self):
        policy = self.materialize(lambda steps, step: None)
        self.assertIs(policy.stack_context, stack_step.StackContext.BOTH)

    def test_a_policy_without_the_step_collects_none(self):
        policy = self.materialize(lambda steps, step: steps.remove(step))
        self.assertIs(policy.stack_context, stack_step.StackContext.NONE)

    def test_the_ghstack_only_step_replays_with_ghstack_context_alone(self):
        ghstack_only = stack_step.GHSTACK_ONLY_STEP_SHA256
        with mock.patch.object(workflow_mod, "step_digest", return_value=ghstack_only):
            with self.assertLogs(policy_mod.logger, "INFO") as logs:
                policy = self.materialize(lambda steps, step: None)
        self.assertIs(policy.stack_context, stack_step.StackContext.GHSTACK)
        self.assertIn("stack context is on, ghstack only", "\n".join(logs.output))

    def test_any_other_digest_is_refused_naming_the_pin(self):
        with mock.patch.object(workflow_mod, "step_digest", return_value="0" * 64):
            with self.assertRaises(ValueError) as caught:
                self.materialize(lambda steps, step: None)
        message = str(caught.exception)
        self.assertIn("0" * 64, message)
        self.assertIn(stack_step.STEP_SHA256, message)
        self.assertIn("re-pin STEP_SHA256", message)

    def test_an_edited_step_is_refused_at_load(self):
        edits = {
            "run": lambda step: step.update(run=step["run"] + "echo edited\n"),
            "if": lambda step: step.update({"if": "${{ false }}"}),
            "env": lambda step: step["env"].update(PR_NUMBER="1"),
            "shell": lambda step: step.update(shell="sh"),
        }
        for key, change in edits.items():
            with self.subTest(key):
                with self.assertRaises(ValueError) as caught:
                    self.materialize(lambda steps, step: change(step))
                self.assertIn(stack_step.STEP_SHA256, str(caught.exception))

    def test_a_retitled_step_is_still_the_step(self):
        policy = self.materialize(lambda steps, step: step.update(name="Renamed"))
        self.assertIs(policy.stack_context, stack_step.StackContext.BOTH)

    def test_policy_load_logs_whether_stack_context_is_on(self):
        for mutate, state in (
            (lambda steps, step: None, "on for"),
            (lambda steps, step: steps.remove(step), "off for"),
        ):
            with self.subTest(state):
                with self.assertLogs(policy_mod.logger, "INFO") as logs:
                    self.materialize(mutate)
                self.assertIn(f"stack context is {state}", "\n".join(logs.output))

    def test_a_second_step_naming_the_file_is_refused_at_load(self):
        with self.assertRaises(ValueError) as caught:
            self.materialize(lambda steps, step: steps.append(dict(step)))
        self.assertIn("found 2", str(caught.exception))

    def test_a_second_step_that_deletes_the_stack_files_is_refused_at_load(self):
        cleanup = {"name": "Tidy up", "run": "rm -rf /tmp/greenlight-stack\n"}
        with self.assertRaises(ValueError) as caught:
            self.materialize(lambda steps, step: steps.append(cleanup))
        self.assertIn("found 2", str(caught.exception))


class ControlArmTest(StackTestCase):
    """A policy without the step writes no stack but reads the body back all the same.

    So the control arm and the stack arm show one body.
    """

    def test_a_ghstack_pull_request_gets_its_body_at_the_cutoff_and_no_stack(self):
        gh = StackGh({None: listed_page()}, self.three_siblings())
        result = self.build(gh)
        self.assertIsNone(result.stack_path)
        self.assert_no_stack_files()
        self.assertEqual(self.metadata_body(result), listed_body())
        (query,) = gh.queries()
        self.assertIn("userContentEdits", query[4])

    def test_a_pull_request_gh_reports_as_not_ghstack_costs_no_query(self):
        gh = StackGh({None: listed_page()}, head_ref="feature/branch")
        result = self.build(gh)
        self.assertEqual(gh.queries(), [])
        self.assertEqual(self.metadata_body(result), "Fixes it.")

    def test_the_body_rules_raise_here_as_they_do_in_the_stack_arm(self):
        racing = [edit(BEFORE, listed_body()), edit(BEFORE, "cc @someone")]
        deleted = [edit(BEFORE, None, deleted_at="2026-09-10T00:00:00Z")]
        for name, edits in (("tie", racing), ("deleted", deleted)):
            with self.subTest(name), self.assertRaises(ValueError):
                self.build(StackGh({None: pull_page(edits)}))

    def test_without_metadata_nothing_needs_the_body_so_github_is_not_asked(self):
        gh = StackGh({None: listed_page()}, pr_returncode=1)
        result = self.build_logging("ERROR", gh)
        self.assertIsNone(result.metadata_path)
        self.assertEqual(gh.queries(), [])

    def test_a_declined_diff_is_not_read_back(self):
        gh = StackGh({None: listed_page()})
        result = self.build(gh, policy=make_policy(max_diff_lines=2))
        self.assertTrue(result.too_large)
        self.assertEqual(gh.queries(), [])
        self.assertEqual(self.metadata_body(result), "Fixes it.")


class DeclinedDiffTest(StackTestCase):
    """A diff the size gate declines gets its canned verdict and no stack context."""

    def test_a_declined_diff_gets_no_stack_and_github_is_not_asked(self):
        self.leave_stale_stack()
        gh = StackGh({None: listed_page()}, self.three_siblings())
        result = self.build(gh, policy=ghstack_policy(max_diff_lines=2))
        self.assertTrue(result.too_large)
        self.assertIsNone(result.stack_path)
        self.assertEqual(gh.queries(), [])
        self.assert_no_stack_files()

    def test_a_diff_at_the_cap_still_gets_its_stack(self):
        gh = StackGh({None: listed_page()}, self.three_siblings())
        result = self.build(gh, policy=ghstack_policy(max_diff_lines=3))
        self.assertFalse(result.too_large)
        self.assertEqual(
            self.stacked_numbers(result), [TOP, MIDDLE, NEAREST, PR_NUMBER]
        )


class BodyAtCutoffTest(StackTestCase):
    """The listing is read from the body as it stood at the cutoff."""

    def test_the_newest_revision_at_or_before_the_cutoff_wins_in_any_node_order(self):
        rows_now = ghstack_body(f"#{MIDDLE}", f"__->__ #{PR_NUMBER}")
        edits = [
            edit(AFTER, rows_now),
            edit("2026-08-20T00:00:00Z", ghstack_body("(to be filled)")),
            edit(BEFORE, listed_body()),
            edit("2026-08-25T00:00:00Z", rows_now),
            edit(BEFORE, listed_body()),
        ]
        gh = StackGh({None: pull_page(edits)}, self.three_siblings())
        result = self.build_stack(gh)
        self.assertEqual(
            self.stacked_numbers(result), [TOP, MIDDLE, NEAREST, PR_NUMBER]
        )
        self.assertEqual(self.metadata_body(result), listed_body())

    def test_a_revision_edited_at_the_cutoff_instant_counts(self):
        gh = StackGh(
            {None: pull_page([edit(AT_CUTOFF, listed_body())])}, self.three_siblings()
        )
        self.assertEqual(self.metadata_body(self.build_stack(gh)), listed_body())

    def test_a_two_page_history_is_followed_by_cursor(self):
        pages = {
            None: pull_page([edit(AFTER, "later")], next_cursor="page-2"),
            "page-2": listed_page(),
        }
        gh = StackGh(pages, self.three_siblings())
        result = self.build_stack(gh)
        self.assertEqual(self.metadata_body(result), listed_body())
        edit_queries = [q for q in gh.queries() if "userContentEdits" in q[4]]
        self.assertEqual(len(edit_queries), 2)
        self.assertEqual(graphql_variables(edit_queries[1])["cursor"], ("-f", "page-2"))

    def test_a_never_edited_body_is_read_as_it_stands(self):
        gh = StackGh({None: pull_page([], body=listed_body())}, self.three_siblings())
        result = self.build_stack(gh)
        self.assertEqual(self.metadata_body(result), listed_body())
        self.assertEqual(self.stacked_numbers(result)[-1], PR_NUMBER)

    def test_a_never_edited_pull_request_opened_after_the_cutoff_raises(self):
        gh = StackGh({None: pull_page([], body=listed_body(), created=AFTER)})
        with self.assertRaises(ValueError):
            self.build_stack(gh)

    def test_no_revision_at_or_before_the_cutoff_raises(self):
        gh = StackGh({None: pull_page([edit(AFTER, listed_body())])})
        with self.assertRaises(ValueError):
            self.build_stack(gh)

    def test_a_revision_marked_deleted_raises(self):
        deleted = edit(BEFORE, None, deleted_at="2026-09-10T00:00:00Z")
        gh = StackGh({None: pull_page([deleted])})
        with self.assertRaises(ValueError) as caught:
            self.build_stack(gh)
        self.assertIn("deleted", str(caught.exception))

    def test_a_revision_marked_deleted_raises_even_with_its_text_still_served(self):
        deleted = edit(BEFORE, listed_body(), deleted_at="2026-09-10T00:00:00Z")
        with self.assertRaises(ValueError):
            self.build_stack(StackGh({None: pull_page([deleted])}))

    def test_a_live_revision_with_no_text_is_an_emptied_body_that_lists_nothing(self):
        emptied = [edit("2026-08-20T00:00:00Z", listed_body()), edit(BEFORE, None)]
        gh = StackGh({None: pull_page(emptied)})
        result = self.build_stack(gh)
        self.assertIsNone(result.stack_path)
        self.assert_no_stack_files()
        self.assertEqual(self.metadata_body(result), "")
        self.assertEqual(len(gh.queries()), 1)

    def test_two_different_revisions_in_the_same_second_raise(self):
        racing = [edit(BEFORE, listed_body()), edit(BEFORE, "cc @someone")]
        gh = StackGh({None: pull_page(racing)})
        with self.assertRaises(ValueError) as caught:
            self.build_stack(gh)
        self.assertIn("ambiguous", str(caught.exception))
        self.assert_no_stack_files()

    def test_a_cursor_that_stops_moving_raises_instead_of_looping(self):
        pages = {
            None: pull_page([], next_cursor="same"),
            "same": pull_page([], next_cursor="same"),
        }
        with self.assertRaises(RuntimeError):
            self.build_stack(StackGh(pages))


class CutoffTest(StackTestCase):
    """The cutoff is compared, and sent to GitHub, as naive UTC."""

    def since(self, gh):
        (query,) = [q for q in gh.queries() if "timelineItems" in q[4]]
        return graphql_variables(query)["since"]

    def test_a_naive_cutoff_is_read_as_utc(self):
        gh = StackGh({None: listed_page()}, self.three_siblings())
        self.build_stack(gh, cutoff=datetime(2026, 9, 1, 12, 0, 0))
        self.assertEqual(self.since(gh), ("-f", "2026-09-01T12:00:00Z"))

    def test_an_aware_cutoff_is_converted_to_utc(self):
        cutoff = datetime(
            2026, 9, 1, 5, 0, 0, 250000, tzinfo=timezone(timedelta(hours=-7))
        )
        gh = StackGh({None: listed_page()}, self.three_siblings())
        self.build_stack(gh, cutoff=cutoff)
        self.assertEqual(self.since(gh), ("-f", "2026-09-01T12:00:00.250000Z"))

    def test_the_pull_request_is_named_through_typed_variables(self):
        gh = StackGh({None: listed_page()}, self.three_siblings())
        self.build_stack(gh)
        variables = graphql_variables(gh.queries()[0])
        self.assertEqual(variables["owner"], ("-f", "pytorch"))
        self.assertEqual(variables["name"], ("-f", "pytorch"))
        self.assertEqual(variables["number"], ("-F", str(PR_NUMBER)))


class CiExitTest(StackTestCase):
    """Where the step stops without writing, the replay writes nothing and succeeds."""

    def test_a_pull_request_that_is_not_ghstack_gets_no_stack(self):
        page = listed_page(head_ref="feature/branch")
        gh = StackGh({None: page}, head_ref="feature/branch")
        result = self.build_stack(gh)
        self.assertIsNone(result.stack_path)
        self.assert_no_stack_files()
        self.assertEqual(gh.queries(), [])
        self.assertEqual(self.metadata_body(result), "Fixes it.")

    def test_without_metadata_the_query_itself_says_whether_it_is_ghstack(self):
        for head_ref, stacked in (("feature/branch", False), (OWN_HEAD, True)):
            gh = StackGh(
                {None: listed_page(head_ref=head_ref)},
                self.three_siblings(),
                pr_returncode=1,
            )
            with self.subTest(head_ref):
                result = self.build_logging("ERROR", gh, policy=ghstack_policy())
                self.assertIsNone(result.metadata_path)
                self.assertEqual(result.stack_path is not None, stacked)
                self.assertIn("userContentEdits", gh.queries()[0][4])

    def test_a_pull_request_its_own_listing_omits_gets_no_stack(self):
        unlisted = ghstack_body(f"#{TOP}", f"#{BELOW}")
        gh = StackGh({None: pull_page([edit(BEFORE, unlisted)])})
        result = self.build_stack(gh)
        self.assertIsNone(result.stack_path)
        self.assert_no_stack_files()
        self.assertEqual(len(gh.queries()), 1)
        self.assertEqual(self.metadata_body(result), unlisted)

    def test_the_top_of_the_stack_gets_itself_and_an_empty_directory(self):
        top = ghstack_body(f"__->__ #{PR_NUMBER}", f"#{BELOW}")
        gh = StackGh({None: pull_page([edit(BEFORE, top)])})
        result = self.build_stack(gh)
        self.assertEqual(
            self.stack_document(result),
            {"stack": [{"number": PR_NUMBER, "title": "Fix the thing", "this": True}]},
        )
        self.assertEqual(list((self.run_dir / stack.STACK_DIRNAME).iterdir()), [])
        self.assertEqual(len(gh.queries()), 1)


class SiblingTest(StackTestCase):
    """Only what was open above the PR at the cutoff is shown, as it stood then.

    Titles aside: those are read as they are today.
    """

    def test_the_json_is_the_steps_shape_in_jqs_rendering(self):
        body = ghstack_body(f"#{TOP}", f"__->__ #{PR_NUMBER}")
        page = pull_page([edit(BEFORE, body)], title='Fix the "em\u2014dash"')
        gh = StackGh({None: page}, {TOP: sibling(TOP)})
        result = self.build_stack(gh)
        self.assertEqual(result.stack_path, self.run_dir / stack.STACK_FILENAME)
        # jq's default rendering: two-space indent, UTF-8 left unescaped, and a final
        # newline. The sibling keeps the step's key order, then this PR comes last.
        expected = textwrap.dedent(
            """\
            {
              "stack": [
                {
                  "number": 193121,
                  "title": "Sibling 193121",
                  "this": false,
                  "diff": "/tmp/greenlight-stack/193121.diff"
                },
                {
                  "number": 193118,
                  "title": "Fix the \\"em\u2014dash\\"",
                  "this": true
                }
              ]
            }
            """
        )
        self.assertEqual(result.stack_path.read_text(encoding="utf-8"), expected)

    def test_every_diff_the_json_names_is_written_under_the_run_directory(self):
        diffs = {compare("b" * 40, "c" * 40): b"diff --git a/x b/x\n+x\n"}
        gh = StackGh({None: listed_page()}, self.three_siblings(), diffs)
        siblings = self.stack_document(self.build_stack(gh))["stack"][:-1]
        self.assertEqual(
            [entry["number"] for entry in siblings], [TOP, MIDDLE, NEAREST]
        )
        for entry in siblings:
            named = Path(entry["diff"])
            self.assertEqual(str(named.parent), "/tmp/greenlight-stack")
            written = self.run_dir / stack.STACK_DIRNAME / named.name
            self.assertEqual(written.read_bytes(), b"diff --git a/x b/x\n+x\n")

    def test_siblings_not_open_at_the_cutoff_or_not_the_users_are_dropped(self):
        siblings = {
            TOP: sibling(TOP, created=AFTER),
            MIDDLE: sibling(MIDDLE, closed=BEFORE),
            NEAREST: sibling(NEAREST, head_ref=f"gh/bob/{NEAREST}/head"),
        }
        gh = StackGh({None: listed_page()}, siblings)
        result = self.build_stack(gh)
        self.assertEqual(self.stacked_numbers(result), [PR_NUMBER])
        self.assertEqual(gh.compares(), [compare(GHSTACK_BASE_REF, HEAD_SHA)])

    def test_a_sibling_closed_at_the_cutoff_instant_is_dropped(self):
        siblings = {**self.three_siblings(), MIDDLE: sibling(MIDDLE, closed=AT_CUTOFF)}
        result = self.build_stack(StackGh({None: listed_page()}, siblings))
        self.assertEqual(self.stacked_numbers(result), [TOP, NEAREST, PR_NUMBER])

    def test_a_sibling_closed_after_the_cutoff_is_kept(self):
        siblings = {**self.three_siblings(), MIDDLE: sibling(MIDDLE, closed=AFTER)}
        result = self.build_stack(StackGh({None: listed_page()}, siblings))
        self.assertEqual(
            self.stacked_numbers(result), [TOP, MIDDLE, NEAREST, PR_NUMBER]
        )

    def test_a_sibling_whose_head_is_not_ghstack_is_dropped(self):
        siblings = {**self.three_siblings(), TOP: sibling(TOP, head_ref="feature/x")}
        result = self.build_stack(StackGh({None: listed_page()}, siblings))
        self.assertEqual(self.stacked_numbers(result), [MIDDLE, NEAREST, PR_NUMBER])

    def test_the_head_is_the_newest_commit_at_or_before_the_cutoff(self):
        commits = [
            ("1" * 40, "2026-08-21T00:00:00Z"),
            ("3" * 40, AFTER),
            ("2" * 40, BEFORE),
            ("0" * 40, "2026-08-20T00:00:00Z"),
        ]
        siblings = {**self.three_siblings(), TOP: sibling(TOP, commits=commits)}
        gh = StackGh({None: listed_page()}, siblings)
        self.build_stack(gh)
        self.assertIn(compare("b" * 40, "2" * 40), gh.compares())
        self.assertNotIn(compare("b" * 40, "3" * 40), gh.compares())

    def test_a_dropped_sibling_is_never_checked_for_later_pushes(self):
        siblings = {**self.three_siblings(), TOP: sibling(TOP, created=AFTER, events=1)}
        result = self.build_stack(StackGh({None: listed_page()}, siblings))
        self.assertEqual(self.stacked_numbers(result), [MIDDLE, NEAREST, PR_NUMBER])

    def test_a_force_push_or_retarget_after_the_cutoff_raises(self):
        siblings = {**self.three_siblings(), MIDDLE: sibling(MIDDLE, events=1)}
        with self.assertRaises(ValueError) as caught:
            self.build_stack(StackGh({None: listed_page()}, siblings))
        self.assertIn(f"#{MIDDLE}", str(caught.exception))
        self.assert_no_stack_files()

    def test_the_count_covers_head_and_base_force_pushes_and_retargets(self):
        gh = StackGh({None: listed_page()}, self.three_siblings())
        self.build_stack(gh)
        (query,) = [q for q in gh.queries() if "timelineItems" in q[4]]
        for event in (
            "HEAD_REF_FORCE_PUSHED_EVENT",
            "BASE_REF_FORCE_PUSHED_EVENT",
            "BASE_REF_CHANGED_EVENT",
        ):
            self.assertIn(event, query[4])

    def test_more_than_a_hundred_commits_raises(self):
        siblings = {**self.three_siblings(), TOP: sibling(TOP, total=101)}
        with self.assertRaises(ValueError):
            self.build_stack(StackGh({None: listed_page()}, siblings))

    def test_a_sibling_with_no_commit_by_the_cutoff_raises(self):
        siblings = {
            **self.three_siblings(),
            TOP: sibling(TOP, commits=[("c" * 40, AFTER)]),
        }
        with self.assertRaises(ValueError):
            self.build_stack(StackGh({None: listed_page()}, siblings))

    def test_two_commits_in_the_newest_second_raise(self):
        tied = [("1" * 40, BEFORE), ("2" * 40, BEFORE)]
        siblings = {**self.three_siblings(), TOP: sibling(TOP, commits=tied)}
        with self.assertRaises(ValueError) as caught:
            self.build_stack(StackGh({None: listed_page()}, siblings))
        self.assertIn("ambiguous", str(caught.exception))

    def test_a_long_sibling_diff_is_capped(self):
        diffs = {compare("b" * 40, "c" * 40): b"+line\n" * 2500}
        gh = StackGh({None: listed_page()}, self.three_siblings(), diffs)
        self.build_stack(gh)
        written = (self.run_dir / stack.STACK_DIRNAME / f"{TOP}.diff").read_bytes()
        self.assertEqual(written, b"+line\n" * 2000 + b"[truncated]\n")

    def test_a_failure_after_a_diff_was_written_leaves_no_stack_behind(self):
        siblings = {
            **self.three_siblings(),
            NEAREST: sibling(NEAREST, commits=[("d" * 40, BEFORE)]),
        }
        gh = StackGh(
            {None: listed_page()}, siblings, failing={compare("b" * 40, "d" * 40)}
        )
        with self.assertRaises(RuntimeError):
            self.build_stack(gh)
        self.assertEqual(len(gh.compares()), 4)
        self.assert_no_stack_files()


class StaleStackTest(StackTestCase):
    """A reused run directory never carries an earlier sweep's stack forward."""

    def test_a_symlink_at_either_stack_path_is_refused_and_its_target_kept(self):
        outside = Path(self._tmp.name) / "outside"
        outside.mkdir()
        kept = outside / "keep.diff"
        kept.write_text("keep")
        self.run_dir.mkdir(parents=True)
        for name, target in (
            (stack.STACK_DIRNAME, outside),
            (stack.STACK_FILENAME, kept),
        ):
            with self.subTest(name):
                link = self.run_dir / name
                link.symlink_to(target)
                with self.assertRaises(ValueError) as caught:
                    stack.clear_stack(self.run_dir)
                self.assertIn("symlink", str(caught.exception))
                gh = FakeGh()
                with self.assertRaises(ValueError):
                    self.build(gh)
                self.assertEqual(gh.calls, [])
                self.assertEqual(kept.read_text(), "keep")
                link.unlink()

    def test_a_stale_stack_is_removed_under_a_policy_that_collects_none(self):
        self.leave_stale_stack()
        result = self.build(FakeGh())
        self.assertIsNone(result.stack_path)
        self.assert_no_stack_files()

    def test_a_stale_stack_is_removed_even_when_the_first_fetch_fails(self):
        self.leave_stale_stack()

        def failing(argv):
            return completed(b"", 1, b"HTTP 404")

        with self.assertRaises(RuntimeError):
            self.build_stack(failing)
        self.assert_no_stack_files()

    def test_a_stale_stack_is_replaced_rather_than_merged_into(self):
        self.leave_stale_stack()
        result = self.build_stack(StackGh({None: listed_page()}, self.three_siblings()))
        written = sorted(p.name for p in (self.run_dir / stack.STACK_DIRNAME).iterdir())
        self.assertEqual(written, [f"{n}.diff" for n in sorted((TOP, MIDDLE, NEAREST))])
        self.assertEqual(len(self.stack_document(result)["stack"]), 4)


if __name__ == "__main__":
    unittest.main()
