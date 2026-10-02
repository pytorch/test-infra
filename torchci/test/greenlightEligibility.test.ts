import {
  compilePatterns,
  EligibilityPr,
  GreenlightEligibility,
  greenlightEligibilityGate,
  parseMergeRules,
  parseTrustedAuthors,
  renderGreenlightEligibility,
} from "lib/greenlight/greenlightEligibility";
import { GREENLIGHT_PENDING_ALT_ATTR } from "lib/greenlight/greenlightSweep";
import { Octokit } from "octokit";

const FENCE = "```";

function issueBody(...lines: string[]): string {
  return lines.join("\n");
}

const TRUSTED_ISSUE = issueBody(
  FENCE,
  "@Alice",
  "@carol",
  "@dave",
  "@root-approver",
  "@team-member",
  FENCE
);

const RULES_YAML = `
- { name: Everything, patterns: ['*'], approved_by: [root-approver, pytorch/everyone] }
- { name: Docs, patterns: [docs/**], approved_by: [Alice, dave] }
- { name: Torch Python, patterns: [torch/*.py], approved_by: [carol, dave] }
- { name: No approvers, patterns: ['**'] }
`;

function notFound(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

function fakeOctokit({
  body = TRUSTED_ISSUE as unknown,
  rules = RULES_YAML,
  files = [] as string[],
  members = {} as Record<string, string[]>,
} = {}) {
  return {
    rest: {
      issues: { get: jest.fn().mockResolvedValue({ data: { body } }) },
      repos: {
        getContent: jest.fn().mockResolvedValue({
          data: { content: Buffer.from(rules).toString("base64") },
        }),
      },
      teams: {
        getMembershipForUserInOrg: jest.fn(
          async ({ org, team_slug, username }: Record<string, string>) => {
            if ((members[`${org}/${team_slug}`] ?? []).includes(username)) {
              return { data: { state: "active" } };
            }
            throw notFound();
          }
        ),
      },
    },
    paginate: jest
      .fn()
      .mockResolvedValue(files.map((filename) => ({ filename }))),
  };
}

function gateFor(octokit: ReturnType<typeof fakeOctokit>) {
  return greenlightEligibilityGate(
    octokit as unknown as Octokit,
    "pytorch",
    "pytorch"
  );
}

function pr(overrides: Partial<EligibilityPr> = {}): EligibilityPr {
  return {
    number: 1,
    draft: false,
    user: { login: "Alice" },
    additions: 10,
    deletions: 5,
    changed_files: 2,
    head: { ref: "feature" },
    base: { ref: "main" },
    ...overrides,
  };
}

describe("parseTrustedAuthors", () => {
  it("reads one lowercased login per line", () => {
    expect(
      parseTrustedAuthors(issueBody(FENCE, "@alice", "@Bob", FENCE))
    ).toEqual(new Set(["alice", "bob"]));
  });

  it("skips blank lines and comments, and allows a text info string", () => {
    const body = issueBody(
      "",
      "  ",
      "``` Text ",
      "# who may land",
      "",
      "   @alice  ",
      "\t# @mallory is a comment",
      "   ``` \t"
    );
    expect(parseTrustedAuthors(body)).toEqual(new Set(["alice"]));
  });

  it("ends the list at the closing fence", () => {
    const body = issueBody(FENCE, "@alice", FENCE, "@mallory", "anything");
    expect(parseTrustedAuthors(body)).toEqual(new Set(["alice"]));
  });

  it("splits on \\r\\n and \\r as well as \\n", () => {
    expect(parseTrustedAuthors(`${FENCE}\r\n@alice\r@bob\n${FENCE}`)).toEqual(
      new Set(["alice", "bob"])
    );
  });

  it("accepts an empty block and a 39-character login", () => {
    expect(parseTrustedAuthors(issueBody(FENCE, FENCE))).toEqual(new Set());
    const login = `a${"-".repeat(38)}`;
    expect(parseTrustedAuthors(issueBody(FENCE, `@${login}`, FENCE))).toEqual(
      new Set([login])
    );
  });

  it.each([
    ["no fence", issueBody("@alice", FENCE)],
    ["a py fence", issueBody("```py", "@alice", FENCE)],
    ["a 4-space fence", issueBody(`    ${FENCE}`, "@alice", FENCE)],
    ["text before the fence", issueBody("Trusted:", FENCE, "@alice", FENCE)],
    ["an entry without @", issueBody(FENCE, "alice", FENCE)],
    ["a trailing comment", issueBody(FENCE, "@alice # lead", FENCE)],
    ["a 40-character login", issueBody(FENCE, `@${"a".repeat(40)}`, FENCE)],
    ["an unclosed fence", issueBody(FENCE, "@alice")],
    // Python's str.strip keeps U+FEFF, so its reader rejects this line.
    ["a BOM-only line", issueBody(FENCE, "\ufeff", FENCE)],
    ["an empty body", ""],
    ["a blank body", " \n\t\n"],
  ])("rejects %s", (_, body) => {
    expect(() => parseTrustedAuthors(body)).toThrow();
  });

  it.each([[null], [undefined], [42]])("rejects a %p body", (body) => {
    expect(() => parseTrustedAuthors(body)).toThrow();
  });
});

describe("parseMergeRules", () => {
  it("splits approvers into exact-case logins and org/slug teams", () => {
    const [rule] = parseMergeRules(
      "- patterns: ['*']\n  approved_by: [Alice, pytorch/everyone]"
    );
    expect(rule.logins).toEqual(["Alice"]);
    expect(rule.teams).toEqual(["pytorch/everyone"]);
  });

  it("defaults a missing approved_by to no approvers", () => {
    const [rule] = parseMergeRules("- patterns: ['*']");
    expect(rule.logins).toEqual([]);
    expect(rule.teams).toEqual([]);
  });

  it.each([
    ["a non-list file", "name: x"],
    ["a non-mapping rule", "- just a string"],
    ["a non-list approved_by", "- approved_by: alice"],
    ["a null approved_by", "- approved_by:"],
    ["a non-string entry", "- approved_by: [123]"],
    ["a blank entry", "- approved_by: ['  ']"],
    ["a team with two slashes", "- approved_by: [pytorch/a/b]"],
    ["a team with no org", "- approved_by: [/slug]"],
    ["a team with no slug", "- approved_by: [pytorch/]"],
    ["malformed YAML", "- approved_by: [alice"],
  ])("rejects %s", (_, text) => {
    expect(() => parseMergeRules(text)).toThrow();
  });

  it.each([
    ["a brace", ["docs/{a,b}"]],
    ["a bracket", ["docs/[ab]"]],
    ["a paren", ["(docs)"]],
    ["a backslash", ["docs\\x"]],
    ["a regex that fails to compile", ["?"]],
    ["patterns that are not a list", "docs/**"],
    ["a non-string pattern", [1]],
  ])(
    "keeps the approvers of a rule with %s but covers nothing",
    (_, patterns) => {
      const logged = jest.spyOn(console, "error").mockImplementation(() => {});
      const [rule] = parseMergeRules(
        JSON.stringify([{ name: "bad", patterns, approved_by: ["Alice"] }])
      );
      expect(rule.logins).toEqual(["Alice"]);
      expect(rule.matches).toBeNull();
      expect(rule.coversAll).toBe(false);
      expect(logged).toHaveBeenCalled();
      logged.mockRestore();
    }
  );

  it.each([
    [["*"], true],
    [["**"], true],
    [["docs/**", "*"], true],
    [["**", "-x"], false],
    [["docs/**"], false],
    [[], false],
  ])("treats %j as catch-all: %p", (patterns, coversAll) => {
    const [rule] = parseMergeRules(JSON.stringify([{ patterns }]));
    expect(rule.coversAll).toBe(coversAll);
  });
});

describe("compilePatterns", () => {
  it("matches * within one folder and ** across folders", () => {
    const matches = compilePatterns(["torch/*.py", "docs/**"]);
    expect(matches("torch/a.py")).toBe(true);
    expect(matches("torch/sub/a.py")).toBe(false);
    expect(matches("docs/a/b/c.md")).toBe(true);
  });

  it("matches a prefix, as Python's re.match does", () => {
    expect(compilePatterns(["docs"])("docs/source/index.rst")).toBe(true);
    expect(compilePatterns(["torch/*.py"])("torch/a.pyc")).toBe(true);
    expect(compilePatterns(["torch/*.py"])("x/torch/a.py")).toBe(false);
  });

  it("escapes . and +", () => {
    expect(compilePatterns(["a.b"])("axb")).toBe(false);
    expect(compilePatterns(["c++/x"])("c++/x")).toBe(true);
    expect(compilePatterns(["c++/x"])("cc/x")).toBe(false);
  });

  it("excludes the - patterns", () => {
    const matches = compilePatterns(["torch/**", "-torch/csrc/**"]);
    expect(matches("torch/nn/a.py")).toBe(true);
    expect(matches("torch/csrc/a.cpp")).toBe(false);
  });

  it("matches everything not excluded when there is no positive pattern", () => {
    const matches = compilePatterns(["-docs/**"]);
    expect(matches("torch/a.py")).toBe(true);
    expect(matches("docs/a.md")).toBe(false);
  });
});

describe("greenlightEligibilityGate", () => {
  const DOCS = { files: ["docs/a.md"] };
  const DOCS_TREE = { files: ["docs/a.md", "docs/b/c.md"] };
  const MIXED = { files: ["docs/a.md", "torch/a.py"] };
  const TEAM = { members: { "pytorch/everyone": ["team-member"] } };
  const FRANK = { ...DOCS, body: issueBody(FENCE, "@frank", FENCE) };
  const AT_CAPS = { additions: 1995, changed_files: 200 };
  const GHSTACK = { head: { ref: "gh/alice/12/head" } };
  const RELEASE = { base: { ref: "release/2.9" } };
  const by = (login: string) => ({ user: { login } });

  // [case, fake GitHub, PR fields, outcome, issue reads + rules reads + file listings]
  const CASES: [
    string,
    Parameters<typeof fakeOctokit>[0],
    Partial<EligibilityPr>,
    GreenlightEligibility | null,
    string
  ][] = [
    ["a draft", {}, { draft: true }, null, "000"],
    ["no author", {}, { user: null }, null, "000"],
    ["an unlisted author", {}, by("eve"), null, "100"],
    ["lines past the cap", DOCS, { additions: 1996 }, "too_big", "100"],
    ["files past the cap", DOCS, { changed_files: 201 }, "too_big", "100"],
    ["a PR at both caps", DOCS, AT_CAPS, "waiting", "111"],
    ["an author a catch-all names", {}, by("root-approver"), "waiting", "110"],
    ["a catch-all team's member", TEAM, by("team-member"), "waiting", "110"],
    ["files one naming rule covers", DOCS_TREE, {}, "waiting", "111"],
    ["files only two rules cover", MIXED, by("dave"), "merge_rules", "111"],
    ["an approver in another case", DOCS, by("alice"), "merge_rules", "111"],
    ["a listed author no rule names", FRANK, by("frank"), "merge_rules", "111"],
    ["a ghstack head", DOCS, GHSTACK, "merge_rules", "110"],
    ["a base other than main", DOCS, RELEASE, "merge_rules", "110"],
  ];

  it.each(CASES)("decides %s", async (_, options, fields, outcome, reads) => {
    const octokit = fakeOctokit(options);
    expect(await gateFor(octokit)(pr(fields))).toBe(outcome);
    const { issues, repos } = octokit.rest;
    expect(
      [issues.get, repos.getContent, octokit.paginate]
        .map((fn) => fn.mock.calls.length)
        .join("")
    ).toBe(reads);
  });

  it("reads the author's team membership and the PR's files", async () => {
    const octokit = fakeOctokit({ ...DOCS, ...TEAM });
    expect(await gateFor(octokit)(pr())).toBe("waiting");
    expect(octokit.rest.teams.getMembershipForUserInOrg).toHaveBeenCalledWith({
      org: "pytorch",
      team_slug: "everyone",
      username: "Alice",
    });
    expect(octokit.paginate).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      expect.objectContaining({
        owner: "pytorch",
        repo: "pytorch",
        pull_number: 1,
      })
    );
  });

  it("fetches the issue, the rules and each team lookup once per gate", async () => {
    const octokit = fakeOctokit({ ...DOCS, ...TEAM });
    const gate = gateFor(octokit);
    const results = await Promise.all(
      ["team-member", "team-member", "eve", "carol"].map((login, i) =>
        gate(pr({ number: i + 1, user: { login } }))
      )
    );
    expect(results).toEqual(["waiting", "waiting", null, "merge_rules"]);
    expect(octokit.rest.issues.get).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.get).toHaveBeenCalledWith({
      owner: "pytorch",
      repo: "test-infra",
      issue_number: 8945,
    });
    expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "pytorch",
      repo: "pytorch",
      path: ".github/merge_rules.yaml",
    });
    const lookups = octokit.rest.teams.getMembershipForUserInOrg.mock.calls;
    const users = lookups.map(([args]) => args.username).sort();
    expect(users).toEqual(["carol", "team-member"]);
  });

  it("rejects when the issue cannot be read, on every check", async () => {
    const octokit = fakeOctokit();
    octokit.rest.issues.get.mockRejectedValue(new Error("boom"));
    const gate = gateFor(octokit);
    await expect(gate(pr())).rejects.toThrow("boom");
    await expect(gate(pr({ number: 2 }))).rejects.toThrow("boom");
    expect(octokit.rest.issues.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a malformed issue", { body: "@alice" }],
    ["malformed rules", { rules: "name: x" }],
  ])("rejects on %s", async (_, options) => {
    await expect(gateFor(fakeOctokit(options))(pr())).rejects.toThrow();
  });

  it("rejects when a team lookup fails with anything but 404", async () => {
    const octokit = fakeOctokit();
    octokit.rest.teams.getMembershipForUserInOrg.mockRejectedValue(
      Object.assign(new Error("Server Error"), { status: 500 })
    );
    const input = pr({ user: { login: "team-member" } });
    await expect(gateFor(octokit)(input)).rejects.toThrow("Server Error");
  });

  it("rejects when the files cannot be listed", async () => {
    const octokit = fakeOctokit();
    octokit.paginate.mockRejectedValue(new Error("files"));
    await expect(gateFor(octokit)(pr())).rejects.toThrow("files");
  });
});

describe("renderGreenlightEligibility", () => {
  it.each([
    [null, ""],
    ["too_big", "\n🟡 <b>GreenLight</b>: changes are too big to review"],
    [
      "merge_rules",
      "\n🟡 <b>GreenLight</b>: changes can't be reviewed due to merge_rules.yaml restrictions",
    ],
    ["waiting", "\n⏳ <b>GreenLight</b>: waiting for review to start"],
  ] as const)("renders %s", (eligibility, line) => {
    const rendered = renderGreenlightEligibility(eligibility);
    expect(rendered).toBe(line);
    // Either sentinel would re-sweep the PR every 15 minutes for a month.
    expect(rendered).not.toContain(GREENLIGHT_PENDING_ALT_ATTR);
    expect(rendered).not.toMatch(/\d Pending/);
  });
});
