"""Tests for rebuilding a GitHub stack's context as of the replayed verdict.

``build_inputs`` runs through ``test_stack``'s ``StackGh``, extended here to answer the
native stack query, so nothing reaches GitHub. One case runs the step's own jq selection
out of the repository's workflow against the same fixture as the rebuild.
"""

import dataclasses
import json
import unittest
from unittest import mock

from test_inputs import (
    completed,
    CUTOFF,
    HEAD_SHA,
    make_policy,
    PR_NUMBER,
    REPO,
    RUN_SEAM,
)
from test_stack import (
    AFTER,
    AT_CUTOFF,
    BEFORE,
    compare,
    ghstack_policy,
    graphql_variables,
    head_oid,
    listed_page,
    run_selection,
    stack_entry,
    stack_response,
    StackGh,
    StackTestCase,
    USER,
)
from torchci.greenlight_replay import (
    inputs as inputs_mod,
    stack,
    stack_native,
    stack_step,
)


NATIVE_HEAD_REF = "alice/feature-two"
A, B, C, D, E, F = range(PR_NUMBER + 1, PR_NUMBER + 7)


def native_stack(numbers, *, total=None, more=False):
    """Today's ``stack`` object for ``numbers``, bottom of the stack first."""
    nodes = [
        {"position": position, "pullRequest": {"number": number}}
        for position, number in enumerate(numbers, 1)
    ]
    entries = {
        "totalCount": len(nodes) if total is None else total,
        "pageInfo": {"hasNextPage": more},
        "nodes": nodes,
    }
    return {"entries": entries}


def entry(
    number,
    *,
    created=BEFORE,
    closed=None,
    login=USER,
    commits=None,
    events=0,
    total=None,
):
    commits = [(head_oid(number), BEFORE)] if commits is None else commits
    return {
        "title": f"Entry {number}",
        "createdAt": created,
        "closedAt": closed,
        "author": None if login is None else {"login": login},
        "commits": {
            "totalCount": len(commits) if total is None else total,
            "nodes": [
                {"commit": {"oid": oid, "committedDate": when}} for oid, when in commits
            ],
        },
        "timelineItems": {"filteredCount": events},
    }


class NativeGh(StackGh):
    """``StackGh`` also answering the native stack query, by default for a PR whose
    head is not ghstack. ``stack`` is what the query reports for this PR.
    """

    def __init__(self, stack, entries=(), *, author=USER, stack_fails=False, **kwargs):
        kwargs.setdefault("head_ref", NATIVE_HEAD_REF)
        super().__init__(kwargs.pop("pages", {}), entries, **kwargs)
        self.stack = stack
        self.author = author
        self.stack_fails = stack_fails

    def graphql(self, argv):
        query = graphql_variables(argv)["query"][1]
        if "entries(first: 100)" not in query:
            return super().graphql(argv)
        if self.stack_fails:
            return completed(b"", 1, b"GraphQL: Something went wrong")
        author = None if self.author is None else {"login": self.author}
        pull = {"title": "Fix the thing", "author": author, "stack": self.stack}
        data = {"repository": {"pullRequest": pull}}
        return completed(json.dumps({"data": data}).encode("utf-8"))

    def entry_queries(self):
        return [q for q in self.queries() if "timelineItems" in q[4]]


def native_policy():
    return dataclasses.replace(
        make_policy(), stack_context=stack_step.StackContext.BOTH
    )


class NativeTestCase(StackTestCase):
    def build_native(self, gh, policy=None):
        return self.build(gh, policy=policy or native_policy(), base_ref="main")

    def picked(self, gh, result):
        """``(number, base, head)`` per PR above, top first, as diffed."""
        numbers = self.stacked_numbers(result)[:-1]
        prefix = f"repos/{REPO}/compare/"
        pairs = [call[len(prefix) :].split("...") for call in gh.compares()[1:]]
        return [(n, base, head) for n, (base, head) in zip(numbers, pairs, strict=True)]


class SelectionTest(NativeTestCase):
    """Today's five entries above, kept as they stood at the cutoff, top first."""

    def test_the_entries_above_are_rebuilt_top_first_each_from_the_head_below(self):
        gh = NativeGh(
            native_stack([PR_NUMBER, A, B, C]), {n: entry(n) for n in (A, B, C)}
        )
        result = self.build_native(gh)
        self.assertEqual(self.stacked_numbers(result), [C, B, A, PR_NUMBER])
        self.assertEqual(
            self.picked(gh, result),
            [
                (C, head_oid(B), head_oid(C)),
                (B, head_oid(A), head_oid(B)),
                (A, HEAD_SHA, head_oid(A)),
            ],
        )
        document = self.stack_document(result)
        self.assertEqual(
            document["stack"][-1],
            {"number": PR_NUMBER, "title": "Fix the thing", "this": True},
        )
        self.assertEqual(
            document["stack"][0],
            {
                "number": C,
                "title": f"Entry {C}",
                "this": False,
                "diff": f"/tmp/greenlight-stack/{C}.diff",
            },
        )

    def test_only_the_five_nearest_above_are_read(self):
        above = (A, B, C, D, E, F)
        gh = NativeGh(native_stack([PR_NUMBER, *above]), {n: entry(n) for n in above})
        result = self.build_native(gh)
        self.assertEqual(self.stacked_numbers(result), [E, D, C, B, A, PR_NUMBER])
        (query,) = gh.entry_queries()
        self.assertNotIn(f"pullRequest(number: {F})", query[4])

    def test_entries_not_open_then_or_by_others_are_skipped_but_stay_bases(self):
        entries = {
            A: entry(A, closed=BEFORE),
            B: entry(B, login="bob"),
            C: entry(C),
            D: entry(D, closed=AFTER),
            E: entry(E, closed=AT_CUTOFF),
        }
        gh = NativeGh(native_stack([PR_NUMBER, A, B, C, D, E]), entries)
        result = self.build_native(gh)
        self.assertEqual(
            self.picked(gh, result),
            [(D, head_oid(C), head_oid(D)), (C, head_oid(B), head_oid(C))],
        )

    def test_entries_are_ordered_by_position_not_by_node_order(self):
        today = native_stack([PR_NUMBER, A, B])
        today["entries"]["nodes"].reverse()
        gh = NativeGh(today, {A: entry(A), B: entry(B)})
        self.assertEqual(self.stacked_numbers(self.build_native(gh)), [B, A, PR_NUMBER])

    def test_the_entries_below_this_pr_are_not_read(self):
        gh = NativeGh(native_stack([A, B, PR_NUMBER, C]), {C: entry(C)})
        result = self.build_native(gh)
        self.assertEqual(self.picked(gh, result), [(C, HEAD_SHA, head_oid(C))])

    def test_the_top_of_the_stack_gets_itself_and_an_empty_directory(self):
        gh = NativeGh(native_stack([A, PR_NUMBER]))
        result = self.build_native(gh)
        self.assertEqual(self.stacked_numbers(result), [PR_NUMBER])
        self.assertEqual(list((self.run_dir / stack.STACK_DIRNAME).iterdir()), [])
        self.assertEqual(gh.entry_queries(), [])

    def test_a_pr_with_no_author_login_keeps_nothing(self):
        entries = {A: entry(A, login=None)}
        gh = NativeGh(native_stack([PR_NUMBER, A]), entries, author=None)
        self.assertEqual(self.stacked_numbers(self.build_native(gh)), [PR_NUMBER])

    def test_a_long_diff_is_capped(self):
        diffs = {compare(HEAD_SHA, head_oid(A)): b"+line\n" * 2500}
        gh = NativeGh(native_stack([PR_NUMBER, A]), {A: entry(A)}, diffs=diffs)
        self.build_native(gh)
        written = (self.run_dir / stack.STACK_DIRNAME / f"{A}.diff").read_bytes()
        self.assertEqual(written, b"+line\n" * 2000 + b"[truncated]\n")

    def test_each_head_is_the_newest_commit_at_or_before_the_cutoff(self):
        commits = [
            ("1" * 40, "2026-08-21T00:00:00Z"),
            ("2" * 40, BEFORE),
            ("3" * 40, AFTER),
        ]
        entries = {A: entry(A, commits=commits), B: entry(B)}
        gh = NativeGh(native_stack([PR_NUMBER, A, B]), entries)
        result = self.build_native(gh)
        self.assertEqual(
            self.picked(gh, result),
            [(B, "2" * 40, head_oid(B)), (A, HEAD_SHA, "2" * 40)],
        )


class UnknownHeadTest(NativeTestCase):
    """An entry whose head at the cutoff is unknown is skipped, as is the one above."""

    def test_an_entry_rewritten_after_the_cutoff_is_skipped_with_the_one_above_it(self):
        entries = {A: entry(A, events=1), B: entry(B), C: entry(C)}
        gh = NativeGh(native_stack([PR_NUMBER, A, B, C]), entries)
        with self.assertLogs(stack_native.logger, "INFO") as logs:
            result = self.build_native(gh)
        self.assertEqual(self.picked(gh, result), [(C, head_oid(B), head_oid(C))])
        self.assertIn("rewritten after the cutoff", "\n".join(logs.output))

    def test_a_head_that_cannot_be_pinned_skips_the_entry(self):
        cases = {
            "no commit by the cutoff": entry(A, commits=[("c" * 40, AFTER)]),
            "two commits in the newest second": entry(
                A, commits=[("1" * 40, BEFORE), ("2" * 40, BEFORE)]
            ),
            "too many commits": entry(A, total=101),
        }
        for name, unknown in cases.items():
            with self.subTest(name):
                gh = NativeGh(
                    native_stack([PR_NUMBER, A, B]), {A: unknown, B: entry(B)}
                )
                result = self.build_native(gh)
                self.assertEqual(self.stacked_numbers(result), [PR_NUMBER])

    def test_an_entry_opened_after_the_cutoff_leaves_the_one_above_without_a_base(self):
        entries = {A: entry(A, created=AFTER), B: entry(B)}
        gh = NativeGh(native_stack([PR_NUMBER, A, B]), entries)
        self.assertEqual(self.stacked_numbers(self.build_native(gh)), [PR_NUMBER])


class FaultTest(NativeTestCase):
    """Outside a stack nothing is written; a GitHub fault raises and leaves nothing."""

    def test_a_pull_request_in_no_stack_gets_no_stack(self):
        gh = NativeGh(None)
        with self.assertLogs(stack_native.logger, "INFO") as logs:
            result = self.build_native(gh)
        self.assertIn("is in no stack", "\n".join(logs.output))
        self.assertIsNone(result.stack_path)
        self.assert_no_stack_files()
        self.assertEqual(len(gh.queries()), 1)

    def test_a_graphql_error_raises_and_leaves_no_stack(self):
        self.leave_stale_stack()
        with self.assertRaises(RuntimeError):
            self.build_native(NativeGh(native_stack([PR_NUMBER, A]), stack_fails=True))
        self.assert_no_stack_files()

    def test_a_failing_compare_after_a_diff_was_written_leaves_no_stack(self):
        failing = {compare(HEAD_SHA, head_oid(A))}
        entries = {A: entry(A), B: entry(B)}
        gh = NativeGh(native_stack([PR_NUMBER, A, B]), entries, failing=failing)
        with self.assertRaises(RuntimeError):
            self.build_native(gh)
        self.assertEqual(len(gh.compares()), 3)
        self.assert_no_stack_files()

    def test_incomplete_entries_or_a_stack_without_this_pr_once_raise(self):
        null_node = native_stack([PR_NUMBER, None, A])
        null_node["entries"]["nodes"][1] = None
        null_pull = native_stack([PR_NUMBER, None, A])
        null_pull["entries"]["nodes"][1]["pullRequest"] = None
        cases = {
            "another page": (native_stack([PR_NUMBER, A], more=True), "incomplete"),
            "fewer nodes than the count": (
                native_stack([PR_NUMBER, A], total=3),
                "incomplete",
            ),
            "a null node": (null_node, "incomplete"),
            "a null pull request": (null_pull, "incomplete"),
            "this PR missing": (native_stack([A, B]), "0 times"),
            "this PR twice": (native_stack([PR_NUMBER, A, PR_NUMBER]), "2 times"),
        }
        for name, (today, message) in cases.items():
            with self.subTest(name):
                with self.assertRaisesRegex(ValueError, message):
                    self.build_native(NativeGh(today, {A: entry(A)}))
                self.assert_no_stack_files()

    def test_entries_that_are_not_pr_numbers_raise(self):
        for name, number in (("a string", str(A)), ("zero", 0), ("a boolean", True)):
            with self.subTest(name):
                with self.assertRaisesRegex(ValueError, "not PR numbers"):
                    self.build_native(NativeGh(native_stack([PR_NUMBER, number])))
                self.assert_no_stack_files()


class PolicyTest(NativeTestCase):
    """Only a step that covers GitHub stacks rebuilds one, and only for a PR that is not
    ghstack.
    """

    def test_the_ghstack_only_step_writes_nothing_for_a_native_pr(self):
        gh = NativeGh(native_stack([PR_NUMBER, A]), {A: entry(A)})
        result = self.build_native(gh, policy=ghstack_policy())
        self.assertIsNone(result.stack_path)
        self.assertEqual(gh.queries(), [])
        self.assert_no_stack_files()

    def test_a_ghstack_pr_is_rebuilt_alike_under_both_pinned_steps(self):
        runs = []
        for policy in (ghstack_policy(), native_policy()):
            gh = StackGh({None: listed_page()}, self.three_siblings())
            result = self.build(gh, policy=policy)
            runs.append((gh.calls, result.stack_path.read_text(encoding="utf-8")))
        self.assertEqual(runs[0], runs[1])
        self.assertEqual(len(json.loads(runs[1][1])["stack"]), 4)

    def test_a_declined_diff_reads_no_github_stack(self):
        gh = NativeGh(native_stack([PR_NUMBER, A]), {A: entry(A)})
        policy = dataclasses.replace(native_policy(), max_diff_lines=2)
        result = self.build_native(gh, policy=policy)
        self.assertTrue(result.too_large)
        self.assertEqual(gh.queries(), [])
        self.assert_no_stack_files()

    def test_without_write_stack_a_native_head_writes_nothing(self):
        gh = NativeGh(native_stack([PR_NUMBER, A]), {A: entry(A)})
        self.run_dir.mkdir()
        with mock.patch.object(inputs_mod, RUN_SEAM, side_effect=gh):
            result = stack.read_back(
                REPO,
                PR_NUMBER,
                CUTOFF,
                self.run_dir,
                head_ref=NATIVE_HEAD_REF,
                write_stack=False,
                native_head=HEAD_SHA,
            )
        self.assertEqual(result, (None, None))
        self.assertEqual(gh.queries(), [])
        self.assert_no_stack_files()

    def test_without_metadata_the_pull_query_decides_and_a_native_pr_is_rebuilt(self):
        pages = {None: listed_page(head_ref=NATIVE_HEAD_REF)}
        gh = NativeGh(
            native_stack([PR_NUMBER, A]), {A: entry(A)}, pages=pages, pr_returncode=1
        )
        result = self.build_logging(
            "ERROR", gh, policy=native_policy(), base_ref="main"
        )
        self.assertEqual(self.stacked_numbers(result), [A, PR_NUMBER])
        self.assertIn("userContentEdits", gh.queries()[0][4])


class StepParityTest(NativeTestCase):
    """Where nothing changed since the cutoff, the rebuild picks what the step picks."""

    # (number, state today, author); CLOSED and MERGED ones closed before the cutoff.
    FIXTURE = [
        (A, "CLOSED", USER),
        (PR_NUMBER, "OPEN", USER),
        (B, "OPEN", USER),
        (C, "MERGED", USER),
        (D, "OPEN", "bob"),
        (E, "OPEN", USER),
        (F, "OPEN", USER),
    ]

    def test_the_rebuild_and_the_step_select_the_same_prs_bases_and_heads(self):
        nodes = [
            stack_entry(position, number, state, login)
            for position, (number, state, login) in enumerate(self.FIXTURE, 1)
        ]
        nodes[1]["pullRequest"]["headRefOid"] = HEAD_SHA
        step = run_selection(stack_response(nodes))
        self.assertEqual(step.returncode, 0, step.stderr)
        expected = [
            (e["number"], e["base"], e["head"]) for e in json.loads(step.stdout)
        ]

        entries = {
            number: entry(
                number, login=login, closed=None if state == "OPEN" else BEFORE
            )
            for number, state, login in self.FIXTURE
            if number != PR_NUMBER
        }
        numbers = [number for number, _, _ in self.FIXTURE]
        gh = NativeGh(native_stack(numbers), entries)
        result = self.build_native(gh)
        self.assertEqual(self.picked(gh, result), expected)
        self.assertEqual([n for n, _, _ in expected], [F, E, B])


if __name__ == "__main__":
    unittest.main()
