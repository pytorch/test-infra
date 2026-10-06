import { readFileSync } from "fs";
import {
  buildPullRequestBody,
  CODE_SKIP_MIN_GREEN,
  CODE_SKIP_UNSKIP_BRANCH,
  CODE_SKIP_UNSKIP_PR_TITLE,
  CODE_SKIP_WINDOW_DAYS,
  handlePassingCodeSkips,
  planCodeSkipEdits,
  reasonIsCapabilitySkip,
  reasonIsKnownBug,
  removeCodeSkipDecorator,
  repoPathForTestFile,
} from "lib/flakyBot/codeSkipUnskip";
import { PassingCodeSkipRow } from "lib/types";
import nock from "nock";
import { Octokit } from "octokit";

nock.disableNetConnect();

function row(
  overrides: Partial<PassingCodeSkipRow> &
    Pick<PassingCodeSkipRow, "name" | "code_skips">
): PassingCodeSkipRow {
  return {
    classname: "TestFoo",
    filename: "test/test_foo.py",
    num_green: 160,
    num_red: 0,
    ...overrides,
  };
}

const SOURCE = `class TestFoo(TestCase):
    @unittest.skip("broken")
    def test_a(self):
        pass

    @skipIfRocm(msg="https://github.com/pytorch/pytorch/issues/180006")
    def test_b(self):
        pass

    @pytest.mark.skip(reason="unconditional")
    def test_c(self):
        pass

    @unittest.skipIf(True, "still conditional")
    def test_d(self):
        pass

    @skipIfRocmVersionLessThan((5, 4), "https://github.com/pytorch/pytorch/issues/1")
    def test_e(self):
        pass

    @onlyCUDA
    def test_f(self):
        pass

    @requires_cuda
    def test_g(self):
        pass
`;

describe("code skip decorator removal", () => {
  test("removes a direct unittest.skip on that function", () => {
    const result = removeCodeSkipDecorator(
      SOURCE,
      "test_a",
      "TestFoo",
      "broken"
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).not.toContain('@unittest.skip("broken")');
    expect(result.source).toContain("def test_a(self):");
    expect(result.source).toContain("def test_b(self):");
    expect(result.source).toContain("@skipIfRocm");
  });

  test("removes a known-bug skipIfRocm whose message is a GitHub issue", () => {
    const reason =
      "skipIfRocm: https://github.com/pytorch/pytorch/issues/180006";
    const result = removeCodeSkipDecorator(SOURCE, "test_b", "TestFoo", reason);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).not.toContain("issues/180006");
    expect(result.source).toContain('@unittest.skip("broken")');
  });

  test("removes a multiline skipIfRocm and leaves the neighbor decorator", () => {
    const source = `class TestFoo(TestCase):
    @serialTest
    @skipIfRocm(
        msg="https://github.com/pytorch/pytorch/issues/180006",
    )
    def test_b(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_b",
      "test_foo.TestFoo",
      "skipIfRocm: https://github.com/pytorch/pytorch/issues/180006"
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).toContain("@serialTest");
    expect(result.source).not.toContain("skipIfRocm");
    expect(result.source).toContain("def test_b(self):");
  });

  test("removes pytest.mark.skip and not pytest.mark.skipif", () => {
    const skipped = removeCodeSkipDecorator(
      SOURCE,
      "test_c",
      "TestFoo",
      "unconditional"
    );
    if (!skipped.ok) {
      throw new Error(skipped.reason);
    }
    expect(skipped.source).not.toContain("unconditional");

    const skipif = removeCodeSkipDecorator(
      `class TestFoo(TestCase):
    @pytest.mark.skipif(True, reason="unconditional")
    def test_c(self):
        pass
`,
      "test_c",
      "TestFoo",
      "unconditional"
    );
    expect(skipif.ok).toBe(false);
  });

  test("does not remove skipIf, requires_*, onlyCUDA, or version-floor helpers", () => {
    for (const name of ["test_d", "test_e", "test_f", "test_g"]) {
      const result = removeCodeSkipDecorator(SOURCE, name, "TestFoo", "unused");
      expect(result.ok).toBe(false);
    }
    const version = removeCodeSkipDecorator(
      SOURCE,
      "test_e",
      "TestFoo",
      "skipIfRocmVersionLessThan: https://github.com/pytorch/pytorch/issues/1"
    );
    expect(version.ok).toBe(false);
    if (!version.ok) {
      expect(version.reason).toContain("version-floor");
    }
  });

  test("leaves a capability reason in place", () => {
    expect(reasonIsCapabilitySkip("skipIfRocm: PTX is not supported")).toBe(
      true
    );
    expect(reasonIsCapabilitySkip("hipBLAS is missing")).toBe(true);
    expect(reasonIsCapabilitySkip("CUDA-specific codegen")).toBe(true);
    expect(reasonIsCapabilitySkip("NVIDIA-only kernel")).toBe(true);
    expect(
      reasonIsKnownBug(
        "skipIfRocm: https://github.com/pytorch/pytorch/issues/1"
      )
    ).toBe(true);
    expect(reasonIsKnownBug("test doesn't currently work")).toBe(true);
    expect(reasonIsKnownBug("numerical mismatch")).toBe(true);
    expect(reasonIsKnownBug("skipIfRocm: PTX is not supported")).toBe(false);

    const result = removeCodeSkipDecorator(
      SOURCE,
      "test_b",
      "TestFoo",
      "skipIfRocm: PTX is not supported"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("capability");
    }
  });

  test("removes a bare known-bug helper only for a doesn't-currently-work reason", () => {
    const source = `class TestFoo(TestCase):
    @skipIfRocm
    def test_b(self):
        pass
`;
    const removed = removeCodeSkipDecorator(
      source,
      "test_b",
      "TestFoo",
      "skipIfRocm: test doesn't currently work on the ROCm stack"
    );
    expect(removed.ok).toBe(true);

    const kept = removeCodeSkipDecorator(
      source,
      "test_b",
      "TestFoo",
      "skipIfRocm: https://github.com/pytorch/pytorch/issues/180006"
    );
    expect(kept.ok).toBe(false);
  });

  test("does not edit when two functions share the name", () => {
    const source = `class TestFoo(TestCase):
    @unittest.skip("broken")
    def test_a(self):
        pass

class TestFoo(TestCase):
    @unittest.skip("broken")
    def test_a(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_a",
      "TestFoo",
      "broken"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("multiple functions");
    }
  });

  test("does not delete a class skip that covers another test", () => {
    const source = `@unittest.skip("broken")
class TestFoo(TestCase):
    def test_a(self):
        pass

    def test_b(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_a",
      "TestFoo",
      "broken"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("class-level");
    }
    expect(source).toContain('@unittest.skip("broken")');
  });

  test("removes a class skip when it covers only that test", () => {
    const source = `@unittest.skip("broken")
class TestFoo(TestCase):
    def test_a(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_a",
      "TestFoo",
      "broken"
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).not.toContain("@unittest.skip");
    expect(result.source).toContain("def test_a(self):");
  });

  test("picks the class named by the JUnit classname", () => {
    const source = `class TestA(TestCase):
    @unittest.skip("aaa")
    def test_same(self):
        pass

class TestB(TestCase):
    @unittest.skip("bbb")
    def test_same(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_same",
      "test_foo.TestB",
      "bbb"
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).toContain('@unittest.skip("aaa")');
    expect(result.source).not.toContain('@unittest.skip("bbb")');
  });
});

describe("code skip batch plan", () => {
  test("edits every safe test in one file and names the ones left in place", () => {
    const rows = [
      row({ name: "test_a", code_skips: ["broken"] }),
      row({
        name: "test_b",
        code_skips: [
          "skipIfRocm: https://github.com/pytorch/pytorch/issues/180006",
        ],
      }),
      row({
        name: "test_ptx",
        code_skips: ["skipIfRocm: PTX is not supported"],
        num_green: 200,
      }),
      row({
        name: "test_mixed",
        code_skips: ["one reason", "another reason"],
      }),
    ];
    const plan = planCodeSkipEdits(
      rows,
      new Map([["test/test_foo.py", SOURCE]])
    );
    expect(plan.removed.map((item) => item.name).sort()).toEqual([
      "test_a",
      "test_b",
    ]);
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0].content).not.toContain('@unittest.skip("broken")');
    expect(plan.files[0].content).not.toContain("issues/180006");
    expect(plan.files[0].content).toContain("def test_c(self):");
    expect(plan.omitted.map((item) => item.row.name).sort()).toEqual([
      "test_mixed",
      "test_ptx",
    ]);

    const body = buildPullRequestBody(plan);
    expect(body).toContain("test_a");
    expect(body).toContain("test_b");
    expect(body).toContain("greens=160");
    expect(body).toContain("PTX");
    expect(body).toContain("more than one code_skip");
    expect(body).toContain(`${CODE_SKIP_WINDOW_DAYS} days`);
    expect(body).toContain(`${CODE_SKIP_MIN_GREEN} greens`);
    expect(body).toContain("does not merge");
    expect(body.toLowerCase()).not.toContain("jira");
    expect(body.toLowerCase()).not.toContain("amd-hub");
  });

  test("maps a bare filename under test/", () => {
    expect(repoPathForTestFile("test_foo.py")).toBe("test/test_foo.py");
    expect(repoPathForTestFile("test/test_foo.py")).toBe("test/test_foo.py");
    expect(repoPathForTestFile("/tmp/workspace/pytorch/test/test_foo.py")).toBe(
      "test/test_foo.py"
    );
  });

  test("the saved query states the 7 day, 150 green, 0 red bar", () => {
    const sql = readFileSync(
      "clickhouse_queries/flaky_tests/passing_code_skips/query.sql",
      "utf8"
    );
    expect(sql).toContain("INTERVAL 7 DAY");
    expect(sql).toContain("min_num_green");
    expect(sql).toContain("total_red = 0");
    expect(sql).toContain("failing_rows = 0");
    expect(sql).toContain("default.rerun_disabled_code_skips");
    expect(sql).not.toContain("rerun_disabled_tests");
    expect(sql).not.toContain("flaky");
  });
});

describe("code skip pull request", () => {
  function fakeOctokit() {
    const calls: { name: string; args: unknown[] }[] = [];
    const record =
      (name: string, value: unknown) =>
      (...args: unknown[]) => {
        calls.push({ name, args });
        return Promise.resolve(value);
      };
    const octokit = {
      rest: {
        repos: {
          getContent: jest.fn(async (args: { path: string; ref: string }) => {
            calls.push({ name: "getContent", args: [args] });
            if (args.ref === "main") {
              return {
                data: {
                  type: "file",
                  encoding: "base64",
                  content: Buffer.from(SOURCE).toString("base64"),
                },
              };
            }
            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from("already edited").toString("base64"),
              },
            };
          }),
        },
        search: {
          issuesAndPullRequests: jest.fn(
            record("search", {
              data: { items: [] as { title: string; number: number }[] },
            })
          ),
        },
        pulls: {
          get: jest.fn(record("pulls.get", { data: {} })),
          create: jest.fn(record("pulls.create", { data: { number: 42 } })),
          update: jest.fn(record("pulls.update", { data: {} })),
          listFiles: jest.fn(record("listFiles", { data: [] })),
        },
        git: {
          getRef: jest.fn(
            record("getRef", { data: { object: { sha: "mainsha" } } })
          ),
          getCommit: jest.fn(
            record("getCommit", { data: { tree: { sha: "treesha" } } })
          ),
          createBlob: jest.fn(
            record("createBlob", { data: { sha: "blobsha" } })
          ),
          createTree: jest.fn(
            record("createTree", { data: { sha: "newtree" } })
          ),
          createCommit: jest.fn(
            record("createCommit", { data: { sha: "newcommit" } })
          ),
          createRef: jest.fn(record("createRef", { data: {} })),
          updateRef: jest.fn(record("updateRef", { data: {} })),
        },
      },
    };
    return { octokit: octokit as unknown as Octokit, calls, raw: octokit };
  }

  test("opens no pull request when nothing cleared the bar", async () => {
    const { octokit, raw } = fakeOctokit();
    await handlePassingCodeSkips(octokit, []);
    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
    expect(raw.rest.search.issuesAndPullRequests).not.toHaveBeenCalled();
  });

  test("opens no pull request when every candidate is a capability skip", async () => {
    const { octokit, raw } = fakeOctokit();
    await handlePassingCodeSkips(octokit, [
      row({ name: "test_ptx", code_skips: ["PTX is not supported"] }),
    ]);
    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
    expect(raw.rest.search.issuesAndPullRequests).not.toHaveBeenCalled();
  });

  test("opens one draft pull request for every safe removal", async () => {
    const { octokit, raw } = fakeOctokit();
    await handlePassingCodeSkips(octokit, [
      row({ name: "test_a", code_skips: ["broken"] }),
      row({
        name: "test_b",
        code_skips: [
          "skipIfRocm: https://github.com/pytorch/pytorch/issues/180006",
        ],
      }),
      row({ name: "test_ptx", code_skips: ["nvidia-only path"] }),
    ]);
    expect(raw.rest.pulls.create).toHaveBeenCalledTimes(1);
    const created = raw.rest.pulls.create.mock.calls[0][0] as {
      title: string;
      draft: boolean;
      head: string;
      base: string;
      body: string;
    };
    expect(created.title).toBe(CODE_SKIP_UNSKIP_PR_TITLE);
    expect(created.draft).toBe(true);
    expect(created.head).toBe(CODE_SKIP_UNSKIP_BRANCH);
    expect(created.base).toBe("main");
    expect(created.body).toContain("test_a");
    expect(created.body).toContain("test_b");
    expect(created.body).toContain("nvidia-only");
    expect(created.body.toLowerCase()).not.toContain("jira");
  });

  test("updates an open batch pull request instead of opening a second one", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 }],
      },
    } as never);
    raw.rest.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        body: "stale body",
        head: {
          ref: CODE_SKIP_UNSKIP_BRANCH,
          sha: "headsha",
          repo: { full_name: "pytorch/pytorch" },
        },
      },
    } as never);
    raw.rest.pulls.listFiles.mockResolvedValue({
      data: [{ filename: "test/test_foo.py" }],
    } as never);

    await handlePassingCodeSkips(octokit, [
      row({ name: "test_a", code_skips: ["broken"] }),
    ]);

    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
    expect(raw.rest.git.updateRef).toHaveBeenCalledTimes(1);
    const update = raw.rest.pulls.update.mock.calls[0][0] as {
      pull_number: number;
      body: string;
    };
    expect(update.pull_number).toBe(7);
    expect(update.body).toContain("test_a");
    expect(update.body).toContain("A human must review");
  });
});
