import { resolveRelease } from "lib/api/releases/config";
import {
  clearDiscoveryCache,
  discoverLinks,
  issueTitlePattern,
  milestoneTitle,
  newestMatching,
  NOTHING_FOUND,
} from "lib/api/releases/discover";
import { getOctokit } from "lib/github";
import { Octokit } from "octokit";
import { DISCOVERY, MINOR, SHARED } from "./fixtures";

jest.mock("lib/github", () => ({ getOctokit: jest.fn() }));
jest.mock("octokit", () => ({ Octokit: jest.fn() }));

// Titles as they are in pytorch/pytorch.
const ISSUES = [
  { number: 199813, title: "[v.2.15.0] Release Tracker", html_url: "u/199813" },
  { number: 198239, title: "[v2.14.1] Release Tracker", html_url: "u/198239" },
  {
    number: 201644,
    title: "Release 2.15 validations checklist and cherry-picks",
    html_url: "u/201644",
  },
  {
    number: 167476,
    title: "Release 2.9.1 validations checklist and cherry-picks",
    html_url: "u/167476",
  },
  {
    number: 164758,
    title: "Release 2.9.0 validations and cherry picks",
    html_url: "u/164758",
  },
  {
    number: 5,
    title: "[v.2.15.0] Release Tracker",
    html_url: "u/5",
    pull_request: {},
  },
];
const MILESTONES = [
  { number: 71, title: "2.16.0", html_url: "m/71" },
  { number: 72, title: "2.15.1", html_url: "m/72" },
];

const tracker = DISCOVERY.tracker_issue as any;
const validation = DISCOVERY.validation_issue as any;

describe("the discovery rules", () => {
  test("the milestone is titled with the version", () => {
    expect(milestoneTitle({ title: "{version}" }, "2.16.0")).toBe("2.16.0");
  });

  test("the tracker title is found with or without the dot after v", () => {
    const find = (version: string, type: "minor" | "patch") =>
      newestMatching(ISSUES, issueTitlePattern(tracker, version, type))
        ?.number ?? null;
    expect(find("2.15.0", "minor")).toBe(199813);
    expect(find("2.14.1", "patch")).toBe(198239);
    expect(find("2.16.0", "minor")).toBeNull();
  });

  test("a pull request never matches", () => {
    const onlyPr = ISSUES.filter((i) => "pull_request" in i);
    expect(
      newestMatching(onlyPr, issueTitlePattern(tracker, "2.15.0", "minor"))
    ).toBeNull();
  });

  test("the version is matched literally, not as a pattern", () => {
    const issues = [
      { number: 1, title: "[v.2x15y0] Release Tracker", html_url: "u/1" },
    ];
    expect(
      newestMatching(issues, issueTitlePattern(tracker, "2.15.0", "minor"))
    ).toBeNull();
  });

  test("a minor release's validation issue is titled with the minor or the version", () => {
    const find = (version: string) =>
      newestMatching(ISSUES, issueTitlePattern(validation, version, "minor"))
        ?.number ?? null;
    expect(find("2.15.0")).toBe(201644);
    expect(find("2.9.0")).toBe(164758);
  });

  test("a patch release does not take its minor release's validation issue", () => {
    const find = (version: string) =>
      newestMatching(ISSUES, issueTitlePattern(validation, version, "patch"))
        ?.number ?? null;
    expect(find("2.15.1")).toBeNull();
    expect(find("2.9.1")).toBe(167476);
  });

  test("the newest of several matches wins", () => {
    const issues = [10, 30, 20].map((n) => ({
      number: n,
      title: "[v2.16.0] Release Tracker",
      html_url: `u/${n}`,
    }));
    expect(
      newestMatching(issues, issueTitlePattern(tracker, "2.16.0", "minor"))
        ?.number
    ).toBe(30);
  });
});

describe("discoverLinks", () => {
  function fakeOctokit(found: { milestones?: any[]; issues?: any[] } = {}) {
    const listMilestones = jest.fn();
    const search = jest.fn(async () => ({
      data: { items: found.issues ?? ISSUES },
    }));
    return {
      paginate: jest.fn(async () => found.milestones ?? MILESTONES),
      rest: {
        issues: { listMilestones },
        search: { issuesAndPullRequests: search },
      },
      search,
    };
  }

  const credentials = {
    APP_ID: process.env.APP_ID,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
  };

  beforeEach(() => {
    clearDiscoveryCache();
    (getOctokit as jest.Mock).mockReset();
    (Octokit as unknown as jest.Mock).mockReset();
    process.env.APP_ID = "1";
    process.env.PRIVATE_KEY = "key";
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(credentials)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("finds the milestone and the issues a release has", async () => {
    const octokit = fakeOctokit();
    (getOctokit as jest.Mock).mockResolvedValue(octokit);
    const config = resolveRelease(SHARED, null, "2.15.0");
    const links = await discoverLinks(config);
    expect(links.milestone).toBeNull(); // 2.15.0's milestone is not in the fake list
    expect(links.tracker_issue).toEqual({
      number: 199813,
      title: "[v.2.15.0] Release Tracker",
      url: "u/199813",
    });
    expect(links.validation_issue?.number).toBe(201644);
    expect(octokit.search).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'repo:pytorch/pytorch is:issue label:"release tracker"',
      })
    );
  });

  test("finds the milestone titled with the version", async () => {
    (getOctokit as jest.Mock).mockResolvedValue(fakeOctokit());
    const links = await discoverLinks(MINOR);
    expect(links.milestone).toEqual({
      number: 71,
      title: "2.16.0",
      url: "m/71",
    });
    expect(links.tracker_issue).toBeNull();
  });

  test("asks GitHub once for five minutes", async () => {
    (getOctokit as jest.Mock).mockResolvedValue(fakeOctokit());
    await discoverLinks(MINOR);
    await discoverLinks(MINOR);
    expect(getOctokit).toHaveBeenCalledTimes(1);
  });

  test("asks GitHub unauthenticated when the app's credentials are not set", async () => {
    delete process.env.APP_ID;
    delete process.env.PRIVATE_KEY;
    // a preview deployment holds no PyTorchBot key; the data is public
    (Octokit as unknown as jest.Mock).mockImplementation(() => fakeOctokit());
    const links = await discoverLinks(MINOR);
    expect(getOctokit).not.toHaveBeenCalled();
    expect(Octokit).toHaveBeenCalledTimes(1);
    expect(Octokit).toHaveBeenCalledWith();
    expect(links.milestone?.number).toBe(71);
  });

  test("uses the app's installation when its credentials are set", async () => {
    (getOctokit as jest.Mock).mockResolvedValue(fakeOctokit());
    await discoverLinks(MINOR);
    expect(getOctokit).toHaveBeenCalledWith("pytorch", "pytorch");
    expect(Octokit).not.toHaveBeenCalled();
  });

  test("one credential alone is not enough, so it is unauthenticated too", async () => {
    delete process.env.PRIVATE_KEY;
    (Octokit as unknown as jest.Mock).mockImplementation(() => fakeOctokit());
    await discoverLinks(MINOR);
    expect(getOctokit).not.toHaveBeenCalled();
    expect(Octokit).toHaveBeenCalledTimes(1);
  });

  test("a GitHub failure costs the links and nothing else", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    (getOctokit as jest.Mock).mockRejectedValue(new Error("rate limited"));
    expect(await discoverLinks(MINOR)).toEqual(NOTHING_FOUND);
    expect(warn).toHaveBeenCalled();
    // and the next request asks again
    (getOctokit as jest.Mock).mockResolvedValue(fakeOctokit());
    expect((await discoverLinks(MINOR)).milestone?.number).toBe(71);
    warn.mockRestore();
  });
});
