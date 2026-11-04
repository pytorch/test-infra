import io
import json
import os
import subprocess
import tempfile
import urllib.error
from pathlib import Path
from unittest import main, mock, TestCase

from torchci.td.llm import diff


GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.com",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}


def stanza(path: str, hunks: list[str], old: str = "") -> str:
    lines = [f"diff --git a/{old or path} b/{path}", "index 1111111..2222222 100644"]
    lines += [f"--- a/{old or path}", f"+++ b/{path}"]
    for i, body in enumerate(hunks):
        lines += [f"@@ -{i * 10 + 1},1 +{i * 10 + 1},1 @@ def f{i}():", body]
    return "\n".join(lines) + "\n"


class TestQueryChunks(TestCase):
    def test_source_first_round_robin(self) -> None:
        text = (
            stanza("README.md", ["+doc"])
            + stanza("torch/a.py", ["+a1", "+a2", "+a3"])
            + stanza("aten/b.cpp", ["+b1"])
            + stanza("third_party/x/c.py", ["+c1"])
            + stanza("setup.cfg", ["+s1", "+s2"])
        )
        chunks = diff.query_chunks(text)
        firsts = [(c.split("\n")[0], c.split("\n")[-2]) for c in chunks]
        self.assertEqual(
            firsts,
            [
                ("diff --git a/torch/a.py b/torch/a.py", "+a1"),
                ("diff --git a/aten/b.cpp b/aten/b.cpp", "+b1"),
                ("diff --git a/README.md b/README.md", "+doc"),
                ("diff --git a/setup.cfg b/setup.cfg", "+s1"),
                ("diff --git a/torch/a.py b/torch/a.py", "+a2"),
                ("diff --git a/setup.cfg b/setup.cfg", "+s2"),
                ("diff --git a/torch/a.py b/torch/a.py", "+a3"),
            ],
        )
        self.assertEqual(
            chunks[0],
            "diff --git a/torch/a.py b/torch/a.py\n@@ -1,1 +1,1 @@ def f0():\n+a1\n",
        )

    def test_max_chunks(self) -> None:
        text = "".join(stanza(f"f{i}.py", ["+x", "+y"]) for i in range(40))
        chunks = diff.query_chunks(text, max_chunks=50)
        self.assertEqual(len(chunks), 50)
        self.assertTrue(all(c.endswith("+x\n") for c in chunks[:40]))
        self.assertEqual(len(diff.query_chunks(text)), 64)

    def test_chunk_cut(self) -> None:
        chunks = diff.query_chunks(stanza("a.py", ["+" + "x" * 5000]))
        self.assertEqual(len(chunks), 1)
        self.assertEqual(len(chunks[0]), diff.CHUNK_CHARS)

    def test_binary_rename_and_mode_only_are_dropped(self) -> None:
        text = (
            "diff --git a/img.png b/img.png\n"
            "index 1111111..2222222 100644\n"
            "Binary files a/img.png and b/img.png differ\n"
            "diff --git a/old.py b/new.py\n"
            "similarity index 100%\n"
            "rename from old.py\n"
            "rename to new.py\n"
            "diff --git a/run.sh b/run.sh\n"
            "old mode 100644\n"
            "new mode 100755\n"
        )
        self.assertEqual(diff.query_chunks(text), [])
        self.assertEqual(diff.query_chunks(""), [])

    def test_deleted_file_uses_old_path(self) -> None:
        text = (
            "diff --git a/third_party/gone.py b/third_party/gone.py\n"
            "deleted file mode 100644\n"
            "--- a/third_party/gone.py\n"
            "+++ /dev/null\n"
            "@@ -1 +0,0 @@\n"
            "-x\n"
        )
        self.assertEqual(diff.query_chunks(text), [])

    def test_paths_with_spaces_and_quotes(self) -> None:
        text = (
            "diff --git a/docs/a b.txt b/docs/a b.txt\n"
            "--- a/docs/a b.txt\t\n"
            "+++ b/docs/a b.txt\t\n"
            "@@ -1 +1 @@\n"
            "+t\n"
            'diff --git "a/t\\303\\244.py" "b/t\\303\\244.py"\n'
            '--- "a/t\\303\\244.py"\n'
            '+++ "b/t\\303\\244.py"\n'
            "@@ -1 +1 @@\n"
            "+p\n"
        )
        chunks = diff.query_chunks(text)
        self.assertEqual([c.split("\n")[-2] for c in chunks], ["+p", "+t"])

    def test_text_before_the_first_stanza_is_ignored(self) -> None:
        text = "warning: something\n" + stanza("a.py", ["+x"])
        self.assertEqual(len(diff.query_chunks(text)), 1)


class TestChangedPaths(TestCase):
    def test_every_side_of_every_stanza(self) -> None:
        text = (
            stanza("torch/a.py", ["+x"])
            + stanza("new/name.py", ["+y"], old="old/name.py")
            + "diff --git a/gone.py b/gone.py\n"
            "deleted file mode 100644\n"
            "--- a/gone.py\n"
            "+++ /dev/null\n"
            "@@ -1 +0,0 @@\n"
            "-z\n"
            "diff --git a/added.py b/added.py\n"
            "new file mode 100644\n"
            "--- /dev/null\n"
            "+++ b/added.py\n"
            "@@ -0,0 +1 @@\n"
            "+w\n"
            "diff --git a/img.png b/img.png\n"
            "index 1111111..2222222 100644\n"
            "Binary files a/img.png and b/img.png differ\n"
            "diff --git a/from.py b/to.py\n"
            "similarity index 100%\n"
            "rename from from.py\n"
            "rename to to.py\n"
            "diff --git a/run.sh b/run.sh\n"
            "old mode 100644\n"
            "new mode 100755\n"
        )
        self.assertEqual(
            diff.changed_paths(text),
            [
                "added.py",
                "from.py",
                "gone.py",
                "img.png",
                "new/name.py",
                "old/name.py",
                "run.sh",
                "to.py",
                "torch/a.py",
            ],
        )

    def test_hunk_bodies_are_never_paths(self) -> None:
        text = stanza("a.py", ["--- a/fake.py\n+++ b/fake2.py\n rename to x.py"])
        self.assertEqual(diff.changed_paths(text), ["a.py"])

    def test_quoted_and_spaced_paths(self) -> None:
        text = (
            'diff --git "a/t\\303\\244 \\"q\\".py" "b/t\\303\\244 \\"q\\".py"\n'
            'Binary files "a/t\\303\\244 \\"q\\".py" and "b/t\\303\\244 \\"q\\".py" differ\n'
            "diff --git a/docs/a b.txt b/docs/a b.txt\n"
            "--- a/docs/a b.txt\t\n"
            "+++ b/docs/a b.txt\t\n"
            "@@ -1 +1 @@\n"
            "+t\n"
        )
        self.assertEqual(diff.changed_paths(text), ["docs/a b.txt", 't\u00e4 "q".py'])

    def test_unparseable_header_without_path_lines(self) -> None:
        text = (
            "diff --git a/x.bin b/y.bin\n"
            "index 1111111..2222222 100644\n"
            "Binary files a/x.bin and b/y.bin differ\n"
        )
        self.assertEqual(diff._header_path(text.split("\n")[0]), "")
        self.assertEqual(diff.changed_paths(text), [])
        self.assertEqual(diff.query_chunks(text), [])

    def test_empty(self) -> None:
        self.assertEqual(diff.changed_paths(""), [])
        self.assertEqual(diff.changed_paths("not a diff\n"), [])


class TestShaRe(TestCase):
    def test_whole_string_only(self) -> None:
        sha = "a" * 40
        for method in (diff.SHA_RE.match, diff.SHA_RE.fullmatch, diff.SHA_RE.search):
            self.assertTrue(method(sha))
            for bad in [sha + "\n", sha + "0", "A" * 40, "a" * 39, " " + sha]:
                self.assertFalse(method(bad), (method, bad))


class GitRepoTest(TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        self.git("init", "-q", "-b", "main")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(self.repo), *args],
            env=GIT_ENV,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def commit(self, name: str, content: str) -> str:
        (self.repo / name).write_text(content)
        self.git("add", name)
        self.git("commit", "-q", "-m", name)
        return self.git("rev-parse", "HEAD")


class TestGitHelper(GitRepoTest):
    def test_runs_in_the_repo(self) -> None:
        sha = self.commit("a.py", "x\n")
        self.assertEqual(diff.git(self.repo, "rev-parse", "HEAD").stdout.strip(), sha)
        out = diff.git(self.repo, "cat-file", "--batch-check", stdin=f"{sha}\n")
        self.assertEqual(out.stdout.split()[1], "commit")

    def test_failures(self) -> None:
        self.commit("a.py", "x\n")
        with self.assertRaises(subprocess.CalledProcessError):
            diff.git(self.repo, "rev-parse", "--verify", "nope")
        proc = diff.git(self.repo, "rev-parse", "--verify", "nope", check=False)
        self.assertNotEqual(proc.returncode, 0)
        with mock.patch.object(
            diff.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 1)
        ) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                diff.git(self.repo, "status", timeout=1)
        self.assertEqual(run.call_args.kwargs["timeout"], 1)
        self.assertEqual(run.call_args.args[0], ["git", "-C", str(self.repo), "status"])


class TestGitDiff(GitRepoTest):
    def test_diff_and_chunks(self) -> None:
        base = self.commit("a.py", "x = 1\n")
        self.commit("a.py", "x = 2\n")
        text = diff.git_diff(self.repo, base)
        self.assertIn("-x = 1\n+x = 2", text)
        self.assertEqual(len(diff.query_chunks(text)), 1)
        self.assertEqual(diff.git_diff(self.repo, diff.PARENT_OF_HEAD), text)

    def test_explicit_head(self) -> None:
        first = self.commit("a.py", "x = 1\n")
        second = self.commit("a.py", "x = 2\n")
        self.commit("a.py", "x = 3\n")
        text = diff.git_diff(self.repo, first, second)
        self.assertIn("-x = 1\n+x = 2", text)
        self.assertNotIn("x = 3", text)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.git("rev-parse", "main"))
        self.assertIn("+x = 3", diff.git_diff(self.repo, second, "HEAD"))
        self.assertEqual(
            diff.git_diff(self.repo, first, diff.PARENT_OF_HEAD),
            diff.git_diff(self.repo, first, second),
        )

    def test_rejected_head(self) -> None:
        base = self.commit("a.py", "x = 1\n")
        self.commit("a.py", "x = 2\n")
        for head in ["--output=/tmp/x", "-p", "HEAD~1", "a b", "main@{1}"]:
            with self.assertRaises(ValueError):
                diff.git_diff(self.repo, base, head)
        with self.assertRaises(diff.DiffError):
            diff.git_diff(self.repo, base, "f" * 40)

    def test_user_diff_config_is_overridden(self) -> None:
        base = self.commit("a.py", "x = 1\n")
        self.commit("a.py", "x = 2\n")
        self.git("config", "diff.noprefix", "true")
        self.git("config", "diff.mnemonicPrefix", "true")
        self.assertIn("diff --git a/a.py b/a.py", diff.git_diff(self.repo, base))

    def test_user_src_and_dst_prefixes_are_overridden(self) -> None:
        base = self.commit("a.py", "x = 1\n")
        (self.repo / "third_party").mkdir()
        self.commit("third_party/t.py", "y\n")
        self.commit("a.py", "x = 2\n")
        self.git("config", "diff.srcPrefix", "SRC/")
        self.git("config", "diff.dstPrefix", "DST/")
        text = diff.git_diff(self.repo, base)
        self.assertIn("diff --git a/a.py b/a.py", text)
        self.assertEqual(diff.changed_paths(text), ["a.py", "third_party/t.py"])
        chunks = diff.query_chunks(text)
        self.assertEqual(
            [c.split("\n")[0] for c in chunks], ["diff --git a/a.py b/a.py"]
        )

    def test_cap_keeps_the_start(self) -> None:
        base = self.commit("a.py", "x = 1\n")
        self.commit("a.py", "".join(f"line {i}\n" for i in range(10000)))
        with mock.patch.object(diff, "DIFF_MAX_BYTES", 1000):
            text = diff.git_diff(self.repo, base)
        self.assertEqual(len(text.encode()), 1000)
        self.assertTrue(text.startswith("diff --git a/a.py b/a.py"))

    def test_failures(self) -> None:
        self.commit("a.py", "x = 1\n")
        with self.assertRaises(diff.DiffError):
            diff.git_diff(self.repo, "0" * 40)
        with self.assertRaises(ValueError):
            diff.git_diff(self.repo, "--output=/tmp/x")
        with self.assertRaises(ValueError):
            diff.git_diff(self.repo, "HEAD~1")


class TestResolveBase(GitRepoTest):
    def setUp(self) -> None:
        super().setUp()
        self.root = self.commit("a.py", "1\n")
        self.main_tip = self.commit("b.py", "1\n")
        self.git("update-ref", "refs/remotes/origin/main", self.main_tip)

    def test_no_pr_on_main_diffs_the_last_commit(self) -> None:
        self.assertEqual(diff.resolve_base(self.repo, None, None, None, None), "HEAD^")

    def test_no_pr_on_a_branch_uses_the_merge_base(self) -> None:
        self.git("checkout", "-q", "-b", "feature", self.root)
        self.commit("c.py", "1\n")
        self.assertEqual(
            diff.resolve_base(self.repo, None, None, None, None), self.root
        )

    def test_pr_with_base_ref(self) -> None:
        self.git("checkout", "-q", "-b", "release", self.root)
        release = self.commit("r.py", "1\n")
        self.git("update-ref", "refs/remotes/origin/release", release)
        self.commit("pr.py", "1\n")
        self.assertEqual(
            diff.resolve_base(self.repo, 5, "release", None, None), release
        )

    def test_ghstack_base_sha_when_the_base_ref_is_absent(self) -> None:
        stack_base = self.commit("lower.py", "1\n")
        self.commit("upper.py", "1\n")
        self.assertEqual(
            diff.resolve_base(self.repo, 7, "gh/u/3/base", stack_base, None),
            stack_base,
        )

    def test_pr_falls_back_to_main(self) -> None:
        self.git("checkout", "-q", "-b", "feature", self.root)
        self.commit("c.py", "1\n")
        self.assertEqual(
            diff.resolve_base(self.repo, 7, "gh/u/3/base", "f" * 40, None), self.root
        )

    def test_pr_without_base_asks_the_api(self) -> None:
        stack_base = self.commit("lower.py", "1\n")
        self.commit("upper.py", "1\n")
        with mock.patch.object(
            diff, "pr_base_from_api", return_value=("gh/u/3/base", stack_base)
        ) as api:
            base = diff.resolve_base(self.repo, 7, "", "", "token")
        api.assert_called_once_with(7, "token")
        self.assertEqual(base, stack_base)

    def test_unusable_api_ref_keeps_the_api_sha(self) -> None:
        stack_base = self.commit("lower.py", "1\n")
        self.commit("upper.py", "1\n")
        with mock.patch.object(
            diff, "pr_base_from_api", return_value=("bad ref", stack_base)
        ):
            with self.assertLogs(diff.logger, "WARNING") as logs:
                base = diff.resolve_base(self.repo, 7, None, None, None)
        self.assertEqual(base, stack_base)
        self.assertIn("ignoring the PR base 'bad ref'", logs.output[0])

    def test_api_failure_falls_back_to_main(self) -> None:
        self.commit("upper.py", "1\n")
        error = urllib.error.URLError("down")
        with mock.patch.object(diff, "pr_base_from_api", side_effect=error):
            base = diff.resolve_base(self.repo, 7, None, None, None)
        self.assertEqual(base, self.main_tip)

    def test_unusable_event_base_falls_back_to_main(self) -> None:
        self.git("checkout", "-q", "-b", "feature", self.root)
        self.commit("c.py", "1\n")
        bad_values = ["-x", "--upload-pack=x", "a b", "a;b", "refs/x@{1}", "main\n"]
        for bad in bad_values:
            for ref, sha in [(bad, None), (None, bad), (bad, bad)]:
                with self.assertLogs(diff.logger, "WARNING") as logs:
                    base = diff.resolve_base(self.repo, 7, ref, sha, None)
                self.assertEqual(base, self.root)
                self.assertIn("ignoring the PR base", logs.output[0])

    def test_unusable_ref_with_a_usable_sha(self) -> None:
        stack_base = self.commit("lower.py", "1\n")
        self.commit("upper.py", "1\n")
        with self.assertLogs(diff.logger, "WARNING"):
            base = diff.resolve_base(self.repo, 7, "a b", stack_base, None)
        self.assertEqual(base, stack_base)

    def test_no_main_is_an_error(self) -> None:
        self.git("update-ref", "-d", "refs/remotes/origin/main")
        with self.assertRaises(diff.DiffError):
            diff.resolve_base(self.repo, None, None, None, None)


class TestPrNumber(TestCase):
    def test_sources(self) -> None:
        self.assertEqual(diff.pr_number_from("123", "refs/tags/ciflow/trunk/9"), 123)
        self.assertEqual(diff.pr_number_from("", "refs/tags/ciflow/trunk/456"), 456)
        self.assertEqual(diff.pr_number_from(None, "refs/tags/ciflow/a/b/78"), 78)
        self.assertIsNone(diff.pr_number_from("", "refs/heads/main"))
        self.assertIsNone(diff.pr_number_from(None, None))
        self.assertIsNone(diff.pr_number_from("", "refs/tags/ciflow/trunk/١٢"))
        self.assertIsNone(diff.pr_number_from("", "refs/tags/ciflow/trunk/12\n"))

    def test_rejects_non_digits(self) -> None:
        for bad in ["12a", "-1", "١", " 1", "12\n"]:
            with self.assertRaises(ValueError):
                diff.pr_number_from(bad, None)


class FakeResponse(io.BytesIO):
    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class TestPrBaseFromApi(TestCase):
    def call(self, payload: object, token: str = "") -> tuple:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        with mock.patch.object(
            diff.urllib.request, "urlopen", return_value=FakeResponse(body)
        ) as urlopen:
            result = diff.pr_base_from_api(42, token)
        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.full_url, "https://api.github.com/repos/pytorch/pytorch/pulls/42"
        )
        self.assertEqual(urlopen.call_args.kwargs["timeout"], diff.API_TIMEOUT_SECONDS)
        self.last_headers = dict(request.header_items())
        return result

    def test_reads_base(self) -> None:
        sha = "a" * 40
        self.assertEqual(
            self.call({"base": {"ref": "gh/u/1/base", "sha": sha}}, "tok"),
            ("gh/u/1/base", sha),
        )
        self.assertEqual(self.last_headers["Authorization"], "Bearer tok")

    def test_no_token_no_header(self) -> None:
        self.assertEqual(self.call({"base": {"ref": "main"}}), ("main", None))
        self.assertNotIn("Authorization", self.last_headers)

    def test_returns_an_unusable_ref_as_given(self) -> None:
        sha = "b" * 40
        self.assertEqual(
            self.call({"base": {"ref": "-main", "sha": sha}}), ("-main", sha)
        )

    def test_rejects_bad_responses(self) -> None:
        for payload in [
            {"base": {"ref": "main", "sha": "abc"}},
            {"base": {"ref": 3}},
            {"nobase": 1},
            [],
            b"not json",
        ]:
            with self.assertRaises(ValueError):
                self.call(payload)

    def test_response_size_cap(self) -> None:
        with mock.patch.object(diff, "API_MAX_BYTES", 10):
            with self.assertRaises(ValueError):
                self.call({"base": {"ref": "main"}})


if __name__ == "__main__":
    main()
