import {
  classifyFp,
  lastCloseActor,
  MERGEBOT_LOGIN,
  verifyFpForPr,
} from "../lib/autorevert/fpVerification";

const REVERT_TIME = new Date("2026-05-04T21:30:00Z");

function pr(state: "open" | "closed", labels: string[] = []) {
  return { state, labels: labels.map((name) => ({ name })) };
}

function commitAt(iso: string) {
  return { commit: { committer: { date: iso } } };
}

function timeline(...events: Array<{ event: string; actor?: string | null }>) {
  return events.map((e) => ({
    event: e.event,
    actor: e.actor === undefined ? null : { login: e.actor ?? "" },
  }));
}

describe("lastCloseActor", () => {
  it("returns the actor of the most recent closed event", () => {
    expect(
      lastCloseActor(
        timeline(
          { event: "closed", actor: MERGEBOT_LOGIN },
          { event: "reopened", actor: MERGEBOT_LOGIN },
          { event: "closed", actor: "alice" }
        )
      )
    ).toBe("alice");
  });

  it("returns undefined when no closed event exists", () => {
    expect(lastCloseActor(timeline({ event: "labeled", actor: "bot" }))).toBe(
      undefined
    );
  });
});

describe("classifyFp decision tree", () => {
  it("autorevert: disable label -> confirmed_fp", () => {
    const result = classifyFp({
      pr: pr("closed", ["autorevert: disable", "Merged"]),
      commits: [],
      timeline: timeline({ event: "closed", actor: MERGEBOT_LOGIN }),
      revertTime: REVERT_TIME,
    });
    expect(result.verification_status).toBe("confirmed_fp");
    expect(result.verification_reason).toMatch(/autorevert: disable/);
  });

  it("open PR -> legit_revert (not relanded)", () => {
    const result = classifyFp({
      pr: pr("open", ["Merged"]),
      commits: [],
      timeline: [],
      revertTime: REVERT_TIME,
    });
    expect(result.verification_status).toBe("legit_revert");
    expect(result.verification_reason).toMatch(/still open/);
  });

  it("commits after revert -> legit_revert (author fixed)", () => {
    const result = classifyFp({
      pr: pr("closed", ["Merged"]),
      commits: [
        commitAt("2026-05-04T22:00:00Z"),
        commitAt("2026-05-04T22:30:00Z"),
      ],
      timeline: timeline({ event: "closed", actor: MERGEBOT_LOGIN }),
      revertTime: REVERT_TIME,
    });
    expect(result.verification_status).toBe("legit_revert");
    expect(result.commits_after_revert).toBe(2);
    expect(result.verification_reason).toMatch(/2 commit\(s\) after revert/);
  });

  it("terminal close by non-mergebot -> legit_revert (the new step; PR #182078 shape)", () => {
    // PR #182078 went through merge->revert cycles; mergebot closed+reopened
    // on each cycle, then the AUTHOR closed manually after the last revert.
    // Sticky `Merged` label is present but the author's close is the
    // authoritative signal that the PR was abandoned.
    const result = classifyFp({
      pr: pr("closed", ["Merged", "Reverted", "fb-exported"]),
      commits: [],
      timeline: timeline(
        { event: "closed", actor: MERGEBOT_LOGIN },
        { event: "reopened", actor: MERGEBOT_LOGIN },
        { event: "closed", actor: MERGEBOT_LOGIN },
        { event: "reopened", actor: MERGEBOT_LOGIN },
        { event: "closed", actor: "Ruishenl" }
      ),
      revertTime: REVERT_TIME,
    });
    expect(result.verification_status).toBe("legit_revert");
    expect(result.verification_reason).toMatch(
      /closed by Ruishenl.*not pytorchmergebot/
    );
    // Sticky Merged label is reported but does not change classification.
    expect(result.pr_merged).toBe(true);
  });

  it("terminal close by mergebot + Merged label -> confirmed_fp (clean reland)", () => {
    const result = classifyFp({
      pr: pr("closed", ["Merged"]),
      commits: [],
      timeline: timeline(
        { event: "closed", actor: MERGEBOT_LOGIN },
        { event: "reopened", actor: MERGEBOT_LOGIN },
        { event: "closed", actor: MERGEBOT_LOGIN }
      ),
      revertTime: REVERT_TIME,
    });
    expect(result.verification_status).toBe("confirmed_fp");
    expect(result.verification_reason).toMatch(/'Merged' label/);
  });

  it("closed-not-merged with no actor info and no Merged label -> legit_revert (abandoned)", () => {
    const result = classifyFp({
      pr: pr("closed"),
      commits: [],
      timeline: [],
      revertTime: REVERT_TIME,
    });
    expect(result.verification_status).toBe("legit_revert");
    expect(result.verification_reason).toMatch(/abandoned/);
  });
});

describe("verifyFpForPr (mocked octokit)", () => {
  function makeOctokit(opts: {
    pr: any;
    commits: any[];
    timeline?: any[];
    throwOn?: "pr" | "commits" | "timeline";
  }) {
    let timelineCalled = false;
    const get = jest.fn(async () => {
      if (opts.throwOn === "pr") throw new Error("boom-pr");
      return { data: opts.pr };
    });
    const listCommits = jest.fn();
    const listEventsForTimeline = jest.fn();
    const paginate = jest.fn(async (fn: any) => {
      if (fn === listCommits) {
        if (opts.throwOn === "commits") throw new Error("boom-commits");
        return opts.commits;
      }
      if (fn === listEventsForTimeline) {
        timelineCalled = true;
        if (opts.throwOn === "timeline") throw new Error("boom-timeline");
        return opts.timeline ?? [];
      }
      return [];
    });
    return {
      paginate,
      timelineCalledRef: () => timelineCalled,
      rest: {
        pulls: { get, listCommits },
        issues: { listEventsForTimeline },
      },
    };
  }

  it("does NOT fetch timeline when PR is open (saves an API call)", async () => {
    const octokit = makeOctokit({
      pr: pr("open", ["Merged"]),
      commits: [],
    });
    const result = await verifyFpForPr(octokit, 182078, REVERT_TIME);
    expect(result.verification_status).toBe("legit_revert");
    expect(octokit.timelineCalledRef()).toBe(false);
  });

  it("does NOT fetch timeline when PR has commits after revert", async () => {
    const octokit = makeOctokit({
      pr: pr("closed", ["Merged"]),
      commits: [commitAt("2026-05-04T22:00:00Z")],
    });
    const result = await verifyFpForPr(octokit, 182078, REVERT_TIME);
    expect(result.verification_status).toBe("legit_revert");
    expect(octokit.timelineCalledRef()).toBe(false);
  });

  it("FETCHES timeline for closed PR with no post-revert commits", async () => {
    const octokit = makeOctokit({
      pr: pr("closed", ["Merged", "Reverted"]),
      commits: [],
      timeline: [{ event: "closed", actor: { login: "Ruishenl" } }],
    });
    const result = await verifyFpForPr(octokit, 182078, REVERT_TIME);
    expect(octokit.timelineCalledRef()).toBe(true);
    expect(result.verification_status).toBe("legit_revert");
    expect(result.verification_reason).toMatch(/Ruishenl/);
  });

  it("returns unknown on API error", async () => {
    const octokit = makeOctokit({
      pr: null,
      commits: [],
      throwOn: "pr",
    });
    const result = await verifyFpForPr(octokit, 999999, REVERT_TIME);
    expect(result.verification_status).toBe("unknown");
    expect(result.commits_after_revert).toBe(-1);
  });
});
