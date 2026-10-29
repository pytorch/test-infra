import { readFileSync } from "fs";
import fetchDisabledNonFlakyTests from "lib/fetchDisabledNonFlakyTests";
import fetchFlakyTests, {
  fetchFlakyTestsAcrossFileReruns,
} from "lib/fetchFlakyTests";
import fetchIssuesByLabel from "lib/fetchIssuesByLabel";
import fetchPassingCodeSkips from "lib/fetchPassingCodeSkips";
import {
  buildPullRequestBody,
  CODE_SKIP_MIN_GREEN,
  CODE_SKIP_UNSKIP_BRANCH,
  CODE_SKIP_UNSKIP_PR_TITLE,
  CODE_SKIP_WINDOW_DAYS,
  handlePassingCodeSkips,
  planCodeSkipEdits,
  removeCodeSkipDecorator,
  repoPathForTestFile,
} from "lib/flakyBot/codeSkipUnskip";
import { getOctokit } from "lib/github";
import { PassingCodeSkipRow } from "lib/types";
import nock from "nock";
import { Octokit } from "octokit";
import handler from "pages/api/flaky-tests/disable";

jest.mock("lib/fetchPassingCodeSkips", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("lib/fetchFlakyTests", () => ({
  __esModule: true,
  default: jest.fn(),
  fetchFlakyTestsAcrossFileReruns: jest.fn(),
}));
jest.mock("lib/fetchIssuesByLabel", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("lib/fetchDisabledNonFlakyTests", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("lib/github", () => ({
  __esModule: true,
  getOctokit: jest.fn(),
}));

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
    @known_failure_skip_if(lambda: True, "broken")
    def test_a(self):
        pass

    @known_failure_skip_if(lambda: TEST_WITH_ROCM, "https://github.com/pytorch/pytorch/issues/180006")
    def test_b(self):
        pass

    @unittest.skip("unconditional")
    def test_c(self):
        pass

    @skipIfRocm(msg="https://github.com/pytorch/pytorch/issues/180007")
    def test_d(self):
        pass

    @skipIfRocm
    def test_e(self):
        pass

    @skipIfRocmArch(MI300_ARCH)
    def test_f(self):
        pass

    @skipIfRocmVersionAtLeast((7, 14))
    def test_g(self):
        pass
`;

describe("code skip decorator removal", () => {
  test("removes a known_failure_skip_if on that function", () => {
    const result = removeCodeSkipDecorator(
      SOURCE,
      "test_a",
      "TestFoo",
      "broken"
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).not.toContain(
      '@known_failure_skip_if(lambda: True, "broken")'
    );
    expect(result.source).toContain("def test_a(self):");
    expect(result.source).toContain("def test_b(self):");
    expect(result.source).toContain("issues/180006");
  });

  test("removes a known_failure_skip_if whose reason matches", () => {
    const reason = "https://github.com/pytorch/pytorch/issues/180006";
    const result = removeCodeSkipDecorator(SOURCE, "test_b", "TestFoo", reason);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).not.toContain("issues/180006");
    expect(result.source).toContain(
      '@known_failure_skip_if(lambda: True, "broken")'
    );
  });

  test("removes a multiline known_failure_skip_if and leaves the neighbor decorator", () => {
    const source = `class TestFoo(TestCase):
    @serialTest
    @known_failure_skip_if(
        lambda: TEST_WITH_ROCM,
        "https://github.com/pytorch/pytorch/issues/180006",
    )
    def test_b(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_b",
      "test_foo.TestFoo",
      "https://github.com/pytorch/pytorch/issues/180006"
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.source).toContain("@serialTest");
    expect(result.source).not.toContain("known_failure_skip_if");
    expect(result.source).toContain("def test_b(self):");
  });

  test("does not remove a known_failure_skip_if whose reason differs", () => {
    const result = removeCodeSkipDecorator(
      SOURCE,
      "test_b",
      "TestFoo",
      "https://github.com/pytorch/pytorch/issues/1"
    );
    expect(result.ok).toBe(false);
  });

  test("leaves plain skips, skipIfRocm, and ROCm arch/version helpers in place", () => {
    const cases: [string, string][] = [
      ["test_c", "unconditional"],
      ["test_d", "https://github.com/pytorch/pytorch/issues/180007"],
      [
        "test_d",
        "skipIfRocm: https://github.com/pytorch/pytorch/issues/180007",
      ],
      ["test_e", "skipIfRocm: test doesn't currently work on the ROCm stack"],
      ["test_f", "skipIfRocm: test skipped on MI300_ARCH"],
      ["test_g", "ROCm version at least (7, 14): known failure"],
    ];
    for (const [name, reason] of cases) {
      const result = removeCodeSkipDecorator(SOURCE, name, "TestFoo", reason);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("could not isolate");
      }
    }
  });

  test("leaves the retired rerun_code_skip decorator in place", () => {
    const source = `class TestFoo(TestCase):
    @rerun_code_skip("broken")
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
  });

  test("does not edit when two functions share the name", () => {
    const source = `class TestFoo(TestCase):
    @known_failure_skip_if(lambda: True, "broken")
    def test_a(self):
        pass

class TestFoo(TestCase):
    @known_failure_skip_if(lambda: True, "broken")
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
    const source = `@known_failure_skip_if(lambda: True, "broken")
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
    expect(source).toContain('@known_failure_skip_if(lambda: True, "broken")');
  });

  test("does not delete a class skip when a parent class has tests", () => {
    const source = `class Parent(TestCase):
    def test_one(self):
        pass

@known_failure_skip_if(lambda: True, "broken")
class Child(Parent):
    def test_three(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_three",
      "Child",
      "broken"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("class-level");
    }
    expect(source).toContain('@known_failure_skip_if(lambda: True, "broken")');

    const plan = planCodeSkipEdits(
      [
        row({
          name: "test_three",
          classname: "Child",
          code_skips: ["broken"],
        }),
      ],
      new Map([["test/test_foo.py", source]])
    );
    expect(plan.removed).toHaveLength(0);
    expect(plan.files).toHaveLength(0);
    const body = buildPullRequestBody(plan);
    expect(body).toContain("Left in place");
    expect(body).toContain("class-level");
  });

  test("does not delete a class skip when the parent header wraps to a closing paren", () => {
    const source = `class Parent(
    TestCase,
):
    def test_one(self):
        pass

@known_failure_skip_if(lambda: True, "broken")
class Child(Parent):
    def test_three(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_three",
      "Child",
      "broken"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("class-level");
    }
    expect(source).toContain('@known_failure_skip_if(lambda: True, "broken")');
  });

  test("removes a class skip on a wrapped header whose only base is TestCase", () => {
    const source = `@known_failure_skip_if(lambda: True, "broken")
class TestFoo(
    TestCase,
):
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
    expect(result.source).not.toContain("known_failure_skip_if");
    expect(result.source).toContain("def test_a(self):");
  });

  test("does not delete a class skip when the base class is imported", () => {
    const source = `from other_tests import Parent

@known_failure_skip_if(lambda: True, "broken")
class Child(Parent):
    def test_three(self):
        pass
`;
    const result = removeCodeSkipDecorator(
      source,
      "test_three",
      "Child",
      "broken"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("imported");
      expect(result.reason).toContain("not visible");
    }
    expect(source).toContain('@known_failure_skip_if(lambda: True, "broken")');
  });

  test("removes a class skip when it covers only that test", () => {
    const source = `@known_failure_skip_if(lambda: True, "broken")
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
    expect(result.source).not.toContain("known_failure_skip_if");
    expect(result.source).toContain("def test_a(self):");
  });

  test("picks the class named by the JUnit classname", () => {
    const source = `class TestA(TestCase):
    @known_failure_skip_if(lambda: True, "aaa")
    def test_same(self):
        pass

class TestB(TestCase):
    @known_failure_skip_if(lambda: True, "bbb")
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
    expect(result.source).toContain(
      '@known_failure_skip_if(lambda: True, "aaa")'
    );
    expect(result.source).not.toContain(
      '@known_failure_skip_if(lambda: True, "bbb")'
    );
  });
});

describe("code skip batch plan", () => {
  test("edits every safe test in one file and names the ones left in place", () => {
    const rows = [
      row({ name: "test_a", code_skips: ["broken"] }),
      row({
        name: "test_b",
        code_skips: ["https://github.com/pytorch/pytorch/issues/180006"],
      }),
      row({
        name: "test_d",
        code_skips: [
          "skipIfRocm: https://github.com/pytorch/pytorch/issues/180007",
        ],
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
    expect(plan.files[0].content).not.toContain(
      '@known_failure_skip_if(lambda: True, "broken")'
    );
    expect(plan.files[0].content).not.toContain("issues/180006");
    expect(plan.files[0].content).toContain("issues/180007");
    expect(plan.files[0].content).toContain("def test_c(self):");
    expect(plan.omitted.map((item) => item.row.name).sort()).toEqual([
      "test_d",
      "test_mixed",
    ]);

    const body = buildPullRequestBody(plan);
    expect(body).toContain("test_a");
    expect(body).toContain("test_b");
    expect(body).toContain("greens=160");
    expect(body).toContain("could not isolate");
    expect(body).toContain("known_failure_skip_if");
    expect(body).toContain("more than one code_skip");
    expect(body).toContain(`${CODE_SKIP_WINDOW_DAYS} days`);
    expect(body).toContain(`${CODE_SKIP_MIN_GREEN} greens`);
    expect(body).toContain("does not merge");
    expect(body.toLowerCase()).not.toContain("jira");
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
        issues: {
          listComments: jest.fn(record("listComments", { data: [] })),
          createComment: jest.fn(record("createComment", { data: {} })),
        },
        pulls: {
          get: jest.fn(record("pulls.get", { data: {} })),
          create: jest.fn(record("pulls.create", { data: { number: 42 } })),
          update: jest.fn(record("pulls.update", { data: {} })),
          listFiles: jest.fn(record("listFiles", { data: [] })),
          listCommits: jest.fn(
            record("listCommits", {
              data: [
                {
                  commit: {
                    message: `${CODE_SKIP_UNSKIP_PR_TITLE}\n\nRemove 1 code-skip decorator(s).`,
                  },
                },
              ],
            })
          ),
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

  test("closes an open draft when nothing cleared the bar", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 }],
      },
    } as never);
    raw.rest.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        draft: true,
        body: "stale body",
        head: {
          ref: CODE_SKIP_UNSKIP_BRANCH,
          sha: "headsha",
          repo: { full_name: "pytorch/pytorch" },
        },
      },
    } as never);

    await handlePassingCodeSkips(octokit, []);

    expect(raw.rest.search.issuesAndPullRequests).toHaveBeenCalled();
    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
    expect(raw.rest.git.updateRef).not.toHaveBeenCalled();
    expect(raw.rest.issues.createComment).toHaveBeenCalled();
    const comment = raw.rest.issues.createComment.mock.calls[0][0] as {
      issue_number: number;
      body: string;
    };
    expect(comment.issue_number).toBe(7);
    expect(comment.body).toContain("Nothing currently qualifies");
    const closed = raw.rest.pulls.update.mock.calls[0][0] as {
      pull_number: number;
      state: string;
    };
    expect(closed.pull_number).toBe(7);
    expect(closed.state).toBe("closed");
  });

  test("does not close a pull request that a person has marked ready", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 }],
      },
    } as never);
    raw.rest.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        draft: false,
        body: "ready body",
        head: {
          ref: CODE_SKIP_UNSKIP_BRANCH,
          sha: "headsha",
          repo: { full_name: "pytorch/pytorch" },
        },
      },
    } as never);

    await handlePassingCodeSkips(octokit, []);

    expect(raw.rest.pulls.update).not.toHaveBeenCalled();
    expect(raw.rest.issues.createComment).not.toHaveBeenCalled();
    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
  });

  test("does not close a draft when the code-skip query failed", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 }],
      },
    } as never);
    raw.rest.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        draft: true,
        body: "stale body",
        head: {
          ref: CODE_SKIP_UNSKIP_BRANCH,
          sha: "headsha",
          repo: { full_name: "pytorch/pytorch" },
        },
      },
    } as never);

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await handlePassingCodeSkips(octokit, null);

    expect(warn).toHaveBeenCalledWith(
      "code-skip query failed; leaving any open draft alone."
    );
    warn.mockRestore();
    expect(raw.rest.search.issuesAndPullRequests).not.toHaveBeenCalled();
    expect(raw.rest.pulls.update).not.toHaveBeenCalled();
    expect(raw.rest.issues.createComment).not.toHaveBeenCalled();
    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
  });

  test("a thrown code-skip query leaves the open draft alone", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 }],
      },
    } as never);
    raw.rest.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        draft: true,
        body: "stale body",
        head: {
          ref: CODE_SKIP_UNSKIP_BRANCH,
          sha: "headsha",
          repo: { full_name: "pytorch/pytorch" },
        },
      },
    } as never);
    (fetchPassingCodeSkips as jest.Mock).mockRejectedValue(
      new Error("missing table")
    );
    (fetchFlakyTests as jest.Mock).mockResolvedValue([]);
    (fetchFlakyTestsAcrossFileReruns as jest.Mock).mockResolvedValue([]);
    (fetchIssuesByLabel as jest.Mock).mockResolvedValue([]);
    (fetchDisabledNonFlakyTests as jest.Mock).mockResolvedValue([]);
    (getOctokit as jest.Mock).mockResolvedValue(octokit);

    const previousKey = process.env.FLAKY_TEST_BOT_KEY;
    process.env.FLAKY_TEST_BOT_KEY = "test-key";
    const end = jest.fn();
    const res = { status: jest.fn(() => ({ end })) };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handler(
        { headers: { authorization: "test-key" } } as never,
        res as never
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("any open draft is left alone")
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("missing table")
      );
      expect(raw.rest.pulls.update).not.toHaveBeenCalled();
      expect(raw.rest.issues.createComment).not.toHaveBeenCalled();
    } finally {
      if (previousKey === undefined) {
        delete process.env.FLAKY_TEST_BOT_KEY;
      } else {
        process.env.FLAKY_TEST_BOT_KEY = previousKey;
      }
      warn.mockRestore();
    }
  });

  test("opens no pull request when no candidate has an opt-in decorator", async () => {
    const { octokit, raw } = fakeOctokit();
    await handlePassingCodeSkips(octokit, [
      row({
        name: "test_d",
        code_skips: [
          "skipIfRocm: https://github.com/pytorch/pytorch/issues/180007",
        ],
      }),
    ]);
    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
    expect(raw.rest.search.issuesAndPullRequests).toHaveBeenCalled();
    expect(raw.rest.pulls.update).not.toHaveBeenCalled();
  });

  test("opens one draft pull request for every safe removal", async () => {
    const { octokit, raw } = fakeOctokit();
    await handlePassingCodeSkips(octokit, [
      row({ name: "test_a", code_skips: ["broken"] }),
      row({
        name: "test_b",
        code_skips: ["https://github.com/pytorch/pytorch/issues/180006"],
      }),
      row({
        name: "test_e",
        code_skips: [
          "skipIfRocm: test doesn't currently work on the ROCm stack",
        ],
      }),
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
    expect(created.body).toContain("Left in place");
    expect(created.body).toContain("test_e");
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
        draft: true,
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
    const moved = raw.rest.git.updateRef.mock.calls[0][0] as { force: boolean };
    expect(moved.force).toBe(true);
  });

  test("does not push when the open pull request is not a draft", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 }],
      },
    } as never);
    raw.rest.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        draft: false,
        body: "stale body",
        head: {
          ref: CODE_SKIP_UNSKIP_BRANCH,
          sha: "headsha",
          repo: { full_name: "pytorch/pytorch" },
        },
      },
    } as never);

    await handlePassingCodeSkips(octokit, [
      row({ name: "test_a", code_skips: ["broken"] }),
    ]);

    expect(raw.rest.git.updateRef).not.toHaveBeenCalled();
    expect(raw.rest.git.createRef).not.toHaveBeenCalled();
    expect(raw.rest.pulls.create).not.toHaveBeenCalled();
    expect(raw.rest.pulls.update).not.toHaveBeenCalled();
    expect(raw.rest.issues.createComment).toHaveBeenCalled();
    const comment = raw.rest.issues.createComment.mock.calls[0][0] as {
      issue_number: number;
      body: string;
    };
    expect(comment.issue_number).toBe(7);
    expect(comment.body).toContain("not a draft");
    expect(comment.body).toContain("human has taken it out of draft");
  });

  test("does not force-push over commits the bot did not create", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 }],
      },
    } as never);
    raw.rest.pulls.get.mockResolvedValue({
      data: {
        number: 7,
        draft: true,
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
    raw.rest.pulls.listCommits.mockResolvedValue({
      data: [
        {
          commit: {
            message: `${CODE_SKIP_UNSKIP_PR_TITLE}\n\nRemove 1 code-skip decorator(s).`,
          },
        },
        { commit: { message: "Reviewer: keep the neighbor assertion" } },
      ],
    } as never);

    await handlePassingCodeSkips(octokit, [
      row({ name: "test_a", code_skips: ["broken"] }),
    ]);

    expect(raw.rest.git.updateRef).not.toHaveBeenCalled();
    expect(raw.rest.git.createRef).not.toHaveBeenCalled();
    expect(raw.rest.pulls.update).not.toHaveBeenCalled();
    const comment = raw.rest.issues.createComment.mock.calls[0][0] as {
      body: string;
    };
    expect(comment.body).toContain("did not create");
  });

  test("a fork pull request with the same title does not block the pytorch draft", async () => {
    const { octokit, raw } = fakeOctokit();
    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [
          { title: CODE_SKIP_UNSKIP_PR_TITLE, number: 99 },
          { title: CODE_SKIP_UNSKIP_PR_TITLE, number: 7 },
        ],
      },
    } as never);
    raw.rest.pulls.get.mockImplementation(async (...args: unknown[]) => {
      const pullNumber = (args[0] as { pull_number: number }).pull_number;
      if (pullNumber === 99) {
        return {
          data: {
            number: 99,
            draft: true,
            body: "fork body",
            head: {
              ref: "someone-branch",
              sha: "forksha",
              repo: { full_name: "someone/pytorch" },
            },
          },
        };
      }
      return {
        data: {
          number: 7,
          draft: true,
          body: "stale body",
          head: {
            ref: CODE_SKIP_UNSKIP_BRANCH,
            sha: "headsha",
            repo: { full_name: "pytorch/pytorch" },
          },
        },
      };
    });
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
    };
    expect(update.pull_number).toBe(7);

    raw.rest.search.issuesAndPullRequests.mockResolvedValue({
      data: {
        items: [{ title: CODE_SKIP_UNSKIP_PR_TITLE, number: 99 }],
      },
    } as never);
    raw.rest.pulls.create.mockClear();
    raw.rest.git.updateRef.mockClear();
    raw.rest.pulls.update.mockClear();

    await handlePassingCodeSkips(octokit, [
      row({ name: "test_a", code_skips: ["broken"] }),
    ]);

    expect(raw.rest.git.updateRef).not.toHaveBeenCalled();
    expect(raw.rest.pulls.create).toHaveBeenCalledTimes(1);
    const created = raw.rest.pulls.create.mock.calls[0][0] as {
      head: string;
      draft: boolean;
    };
    expect(created.head).toBe(CODE_SKIP_UNSKIP_BRANCH);
    expect(created.draft).toBe(true);
  });
});
