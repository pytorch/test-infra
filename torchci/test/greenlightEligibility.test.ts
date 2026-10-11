import {
  compilePatterns,
  EligibilityPr,
  GreenlightEligibility,
  greenlightEligibilityGate,
  parseMergeRules,
  renderGreenlightEligibility,
} from "lib/greenlight/greenlightEligibility";
import { GateReview } from "lib/greenlight/greenlightReviewGate";
import { GREENLIGHT_PENDING_ALT_ATTR } from "lib/greenlight/greenlightSweep";
import { Octokit } from "octokit";

const FILES_ROUTE = "GET /repos/{owner}/{repo}/pulls/{pull_number}/files";

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
  rules = RULES_YAML,
  files = [] as string[],
  members = {} as Record<string, string[]>,
  reviews = [] as GateReview[],
} = {}) {
  const listReviews = jest.fn();
  return {
    rest: {
      pulls: { listReviews },
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
    paginate: jest.fn(async (route: unknown) =>
      route === listReviews ? reviews : files.map((filename) => ({ filename }))
    ),
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
  const PATH_TEAM = {
    rules: `${RULES_YAML}- { patterns: [third_party/**], approved_by: [pytorch/vendors] }\n`,
    members: { "pytorch/vendors": ["vendor"] },
  };
  const BOT_APPROVERS = {
    rules: `${RULES_YAML}- { patterns: ['*'], approved_by: [pytorchbot, pytorchgreenlight] }\n`,
  };
  const AT_CAPS = { additions: 1995, changed_files: 200 };
  const PAST_CAPS = { additions: 1996, changed_files: 201 };
  const GHSTACK = { head: { ref: "gh/alice/12/head" } };
  const RELEASE = { base: { ref: "release/2.9" } };
  const by = (login: string) => ({ user: { login } });
  const reviewed = (state: string, login: string) => ({
    reviews: [{ state, user: { login, type: "User" } }],
  });
  const DECIDED = reviewed("CHANGES_REQUESTED", "bob");
  const SPACED = {
    rules: `${RULES_YAML}- { patterns: [third_party/**], approved_by: ['  Grace '] }\n`,
  };
  // Python's str.strip keeps U+FEFF, so this entry never names eve.
  const BOM_PADDED = {
    rules: `${RULES_YAML}- { patterns: ['*'], approved_by: ['\ufeffeve'] }\n`,
  };

  // [case, fake GitHub, PR fields, outcome,
  //  rules reads + file listings + review listings]
  const CASES: [
    string,
    Parameters<typeof fakeOctokit>[0],
    Partial<EligibilityPr>,
    GreenlightEligibility | null,
    string
  ][] = [
    ["a draft", {}, { draft: true }, null, "000"],
    ["no author", {}, { user: null }, null, "000"],
    ["a bot a catch-all names", BOT_APPROVERS, by("pytorchbot"), null, "000"],
    [
      "greenlight's bare login, which a catch-all names",
      BOT_APPROVERS,
      by("PyTorchGreenLight"),
      null,
      "000",
    ],
    ["an author no rule names", DOCS, by("frank"), null, "100"],
    [
      "an author only a BOM-padded entry names",
      BOM_PADDED,
      by("eve"),
      null,
      "100",
    ],
    [
      "a non-approver's PR past the caps",
      {},
      { ...by("eve"), ...PAST_CAPS },
      null,
      "100",
    ],
    ["lines past the cap", DOCS, { additions: 1996 }, "too_big", "100"],
    ["files past the cap", DOCS, { changed_files: 201 }, "too_big", "100"],
    ["a PR at both caps", DOCS, AT_CAPS, "waiting", "111"],
    ["an author a catch-all names", {}, by("root-approver"), "waiting", "101"],
    ["a catch-all team's member", TEAM, by("team-member"), "waiting", "101"],
    [
      "a path rule team's member",
      { ...DOCS, ...PATH_TEAM },
      by("vendor"),
      "merge_rules",
      "110",
    ],
    ["files one naming rule covers", DOCS_TREE, {}, "waiting", "111"],
    ["files only two rules cover", MIXED, by("dave"), "merge_rules", "110"],
    ["an approver in another case", DOCS, by("alice"), "merge_rules", "110"],
    ["a ghstack head", DOCS, GHSTACK, "merge_rules", "100"],
    ["a base other than main", DOCS, RELEASE, "merge_rules", "100"],
    [
      "a catch-all author's decided PR",
      DECIDED,
      by("root-approver"),
      null,
      "101",
    ],
    ["a covered author's decided PR", { ...DOCS, ...DECIDED }, {}, null, "111"],
    [
      "an approval by a padded entry in another case",
      { ...DOCS, ...SPACED, ...reviewed("APPROVED", "GRACE") },
      {},
      null,
      "111",
    ],
    [
      "an approval by a rule's approver whatever its patterns",
      { ...DOCS, ...reviewed("APPROVED", "carol") },
      {},
      null,
      "111",
    ],
    [
      "an approval by an approving team's member",
      { ...DOCS, ...TEAM, ...reviewed("APPROVED", "team-member") },
      {},
      null,
      "111",
    ],
    [
      "an approval by a non-approver",
      { ...DOCS, ...reviewed("APPROVED", "eve") },
      {},
      "waiting",
      "111",
    ],
  ];

  it.each(CASES)("decides %s", async (_, options, fields, outcome, reads) => {
    const octokit = fakeOctokit(options);
    expect(await gateFor(octokit)(pr(fields))).toBe(outcome);
    const { repos, pulls } = octokit.rest;
    const routes = octokit.paginate.mock.calls.map(([route]) => route);
    expect(
      [
        repos.getContent.mock.calls.length,
        routes.filter((route) => route === FILES_ROUTE).length,
        routes.filter((route) => route === pulls.listReviews).length,
      ].join("")
    ).toBe(reads);
  });

  it("counts an approval by an approver only an unusable rule names", async () => {
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    const octokit = fakeOctokit({
      ...DOCS,
      rules: `${RULES_YAML}- { name: Unusable, patterns: ['docs/{a,b}'], approved_by: [heidi] }\n`,
      ...reviewed("APPROVED", "heidi"),
    });
    expect(await gateFor(octokit)(pr())).toBeNull();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("reads the author's team membership, the PR's files and its reviews", async () => {
    const octokit = fakeOctokit({ ...DOCS, ...TEAM });
    expect(await gateFor(octokit)(pr())).toBe("waiting");
    expect(octokit.rest.teams.getMembershipForUserInOrg).toHaveBeenCalledWith({
      org: "pytorch",
      team_slug: "everyone",
      username: "Alice",
    });
    expect(octokit.paginate).toHaveBeenCalledWith(
      FILES_ROUTE,
      expect.objectContaining({
        owner: "pytorch",
        repo: "pytorch",
        pull_number: 1,
      })
    );
    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.pulls.listReviews,
      { owner: "pytorch", repo: "pytorch", pull_number: 1, per_page: 100 }
    );
  });

  it("fetches the rules and each team lookup once per gate", async () => {
    const octokit = fakeOctokit({ ...DOCS, ...TEAM });
    const gate = gateFor(octokit);
    const results = await Promise.all(
      ["team-member", "team-member", "eve", "carol"].map((login, i) =>
        gate(pr({ number: i + 1, user: { login } }))
      )
    );
    expect(results).toEqual(["waiting", "waiting", null, "merge_rules"]);
    expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
      owner: "pytorch",
      repo: "pytorch",
      path: ".github/merge_rules.yaml",
    });
    const lookups = octokit.rest.teams.getMembershipForUserInOrg.mock.calls;
    const users = lookups.map(([args]) => args.username).sort();
    expect(users).toEqual(["carol", "eve", "team-member"]);
  });

  it("rejects when the rules cannot be read, on every check", async () => {
    const octokit = fakeOctokit();
    octokit.rest.repos.getContent.mockRejectedValue(new Error("boom"));
    const gate = gateFor(octokit);
    await expect(gate(pr())).rejects.toThrow("boom");
    await expect(gate(pr({ number: 2 }))).rejects.toThrow("boom");
    expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("rejects on malformed rules", async () => {
    const octokit = fakeOctokit({ rules: "name: x" });
    await expect(gateFor(octokit)(pr())).rejects.toThrow();
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

  it("rejects when the reviews cannot be listed", async () => {
    const octokit = fakeOctokit();
    octokit.paginate.mockRejectedValue(new Error("reviews"));
    const input = pr({ user: { login: "root-approver" } });
    await expect(gateFor(octokit)(input)).rejects.toThrow("reviews");
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
