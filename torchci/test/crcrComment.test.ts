import { RecentWorkflowsData } from "lib/types";
import {
  CRCR_SECTION_END,
  CRCR_SECTION_START,
  crcrSectionForSweep,
  crcrSectionHasBlocks,
  isSafeHandle,
  latestAttemptPerJob,
  latestAttemptsForHead,
  MAX_JOB_BULLETS_PER_REPO,
  notifiedHandles,
  notifiedHandlesByRepo,
  pinLedger,
  renderCrcrSection,
} from "../lib/crcr/crcrComment";

const HUD_PR_URL = "https://hud.pytorch.org/pr/pytorch/pytorch/42";

function crcrJob(
  overrides: Partial<RecentWorkflowsData> = {}
): RecentWorkflowsData {
  // A check run's name embeds its repo, workflow and job, so keep `name` in step
  // with the overrides the way fetchCrcrWorkflows does -- a fixture that lets
  // the two drift tests a job identity the relay cannot produce.
  const jobName = overrides.jobName ?? "test-L3-checkrun-creation";
  return {
    name: `crcr/pytorch/crcr-test/CRCR L3 CI/${jobName}`,
    jobName,
    workflowId: 0,
    workflowUniqueId: 0,
    id: 111,
    completed_at: "2023-08-08 06:03:21",
    html_url: "https://github.com/pytorch/crcr-test/actions/runs/555",
    head_sha: "abcdef1234567890",
    head_sha_timestamp: "",
    head_branch: "",
    pr_number: 42,
    conclusion: "failure",
    failure_captures: [],
    failure_lines: [],
    failure_context: [],
    downstreamLevel: "L3",
    downstreamRepo: "pytorch/crcr-test",
    ...overrides,
  };
}

function render(
  failed: RecentWorkflowsData[],
  totals: Map<string, number> = new Map(),
  oncalls: Record<string, string[]> = {},
  pinned: Map<string, Set<string>> = new Map()
): string {
  const failedByRepo = new Map<string, RecentWorkflowsData[]>();
  for (const job of failed) {
    const repo = job.downstreamRepo!;
    failedByRepo.set(repo, [...(failedByRepo.get(repo) ?? []), job]);
  }
  return renderCrcrSection(
    failedByRepo,
    totals,
    HUD_PR_URL,
    (repo) => oncalls[repo] ?? [],
    pinned
  );
}

// One Dr. CI sweep, exactly as pages/api/drci/drci.ts runs it: read the markers
// out of the body being replaced, render, and keep only the section. The pin
// state lives in those markers, so only a sequence of sweeps can test it.
function sweep(
  body: string,
  failed: RecentWorkflowsData[],
  oncalls: Record<string, string[]>
): string {
  const failedByRepo = new Map<string, RecentWorkflowsData[]>();
  for (const job of failed) {
    const repo = job.downstreamRepo!;
    failedByRepo.set(repo, [...(failedByRepo.get(repo) ?? []), job]);
  }
  return renderCrcrSection(
    failedByRepo,
    new Map(),
    HUD_PR_URL,
    (repo) => oncalls[repo] ?? [],
    notifiedHandlesByRepo(body)
  );
}

function mentions(text: string, login: string): number {
  return (text.match(new RegExp(`@${login}\\b`, "g")) ?? []).length;
}

describe("pins across a sequence of sweeps", () => {
  test("notifies once, then never again while the failure stands", () => {
    const jobs = [crcrJob()];
    const oncalls = { "pytorch/crcr-test": ["alice"] };

    const s1 = sweep("", jobs, oncalls);
    expect(mentions(s1, "alice")).toBeGreaterThan(0);

    // Three more sweeps of the same failure: the marker read back each time is
    // what has to keep alice from being paged again.
    const s2 = sweep(s1, jobs, oncalls);
    const s3 = sweep(s2, jobs, oncalls);
    expect(mentions(s2, "alice")).toBe(0);
    expect(mentions(s3, "alice")).toBe(0);
    expect(s3).toContain("On-call alice has been notified.");
    // Byte-identical to the sweep before it, so a sweep that finds nothing new
    // leaves the comment alone instead of rewriting it every 15 minutes.
    expect(s3).toBe(s2);
  });

  test("notifies a new on-call once, without re-paging the others", () => {
    const jobs = [crcrJob()];

    const s1 = sweep("", jobs, { "pytorch/crcr-test": ["alice"] });
    expect(mentions(s1, "alice")).toBeGreaterThan(0);

    // On-calls are added to the allowlist one at a time, over three sweeps. Each
    // newcomer is paged exactly once and nobody else is paged again -- which
    // only holds if the render re-emits the markers for people it is not
    // mentioning this time round.
    const s2 = sweep(s1, jobs, { "pytorch/crcr-test": ["alice", "bob"] });
    expect(mentions(s2, "bob")).toBeGreaterThan(0);
    expect(mentions(s2, "alice")).toBe(0);

    const s3 = sweep(s2, jobs, {
      "pytorch/crcr-test": ["alice", "bob", "carol"],
    });
    expect(mentions(s3, "carol")).toBeGreaterThan(0);
    expect(mentions(s3, "alice")).toBe(0);
    expect(mentions(s3, "bob")).toBe(0);

    const s4 = sweep(s3, jobs, {
      "pytorch/crcr-test": ["alice", "bob", "carol"],
    });
    expect(mentions(s4, "alice")).toBe(0);
    expect(mentions(s4, "bob")).toBe(0);
    expect(mentions(s4, "carol")).toBe(0);
  });

  test("mentions a login on call for three repos once per repo, then never again", () => {
    const jobs = [
      crcrJob({ downstreamRepo: "a/one", name: "crcr/a/one/CI/build" }),
      crcrJob({ downstreamRepo: "b/two", name: "crcr/b/two/CI/build" }),
      crcrJob({ downstreamRepo: "c/three", name: "crcr/c/three/CI/build" }),
    ];
    const oncalls = {
      "a/one": ["alice"],
      "b/two": ["alice"],
      "c/three": ["alice"],
    };

    const s1 = sweep("", jobs, oncalls);
    // Each repo holds its own pin, because each repo is its own incident: two
    // mentions per block (the summary and the sentence), three blocks.
    expect(mentions(s1, "alice")).toBe(6);

    // The pins are spent, so the rewrite says nothing new.
    const s2 = sweep(s1, jobs, oncalls);
    expect(mentions(s2, "alice")).toBe(0);
  });

  test("re-mentions a shared on-call when one of their repos fails again", () => {
    // The reviewer's case: alice covers A and B, B stays red while A recovers and
    // then breaks again. A per-login pin would still be held by B's block, so A's
    // new outage would be reported with nobody told about it.
    const forA = crcrJob({
      downstreamRepo: "a/one",
      name: "crcr/a/one/CI/build",
    });
    const forB = crcrJob({
      downstreamRepo: "b/two",
      name: "crcr/b/two/CI/build",
    });
    const oncalls = { "a/one": ["alice"], "b/two": ["alice"] };

    const bothRed = sweep("", [forA, forB], oncalls);
    expect(mentions(bothRed, "alice")).toBe(4);

    // B keeps failing; A recovers and takes its pin with it.
    const onlyB = sweep(bothRed, [forB], oncalls);
    expect(mentions(onlyB, "alice")).toBe(0);

    // A breaks again: a new outage, so alice is told about it even though B's
    // failure never cleared.
    const aAgain = sweep(onlyB, [forA, forB], oncalls);
    expect(mentions(aAgain, "alice")).toBeGreaterThan(0);
    expect(notifiedHandles(aAgain)).toEqual(new Set(["alice"]));

    // And it is spent for A as well, so the sweep after is silent.
    expect(mentions(sweep(aAgain, [forA, forB], oncalls), "alice")).toBe(0);
  });

  test("re-notifies after the failure clears and comes back", () => {
    const jobs = [crcrJob()];
    const oncalls = { "pytorch/crcr-test": ["alice"] };

    const s1 = sweep("", jobs, oncalls);
    expect(mentions(s1, "alice")).toBeGreaterThan(0);

    // The repo passes: the block goes away and takes its markers with it.
    const s2 = sweep(s1, [], oncalls);
    expect(s2).toBe("");

    // A new outage is news, so alice is paged again.
    const s3 = sweep(s2, jobs, oncalls);
    expect(mentions(s3, "alice")).toBeGreaterThan(0);
  });

  test("keeps the pins through the push-triggered rewrite of the comment", () => {
    const jobs = [crcrJob()];
    const oncalls = { "pytorch/crcr-test": ["alice"] };

    const s1 = sweep("", jobs, oncalls);
    expect(mentions(s1, "alice")).toBeGreaterThan(0);

    // drciBot rewrites the comment on pull_request.synchronize and rebuilds the
    // results with no CRCR section in them (upsertDrCiComment passes no results),
    // so the blocks go. The ledger is what it keeps instead: without it the next
    // sweep finds no markers and pages alice again for the same standing outage,
    // on the most frequent trigger there is.
    const rewritten = `<!-- drci-comment-start -->\n${pinLedger(
      s1
    )}<!-- drci-comment-end -->`;
    expect(rewritten).not.toContain("<details>");
    expect(notifiedHandles(rewritten)).toEqual(new Set(["alice"]));

    const s2 = sweep(rewritten, jobs, oncalls);
    expect(mentions(s2, "alice")).toBe(0);
    expect(s2).toContain("On-call alice has been notified.");
  });

  test("the ledger is empty when nobody has been paged", () => {
    // Nothing to carry, and in particular no empty section left in the comment
    // for a later sweep to mistake for a rendered one.
    expect(pinLedger("no section here")).toBe("");
    expect(pinLedger(sweep("", [crcrJob()], {}))).toBe("");
  });

  test("pages the new owner when a repo's on-calls are replaced", () => {
    const jobs = [crcrJob()];

    const s1 = sweep("", jobs, { "pytorch/crcr-test": ["alice"] });
    expect(mentions(s1, "alice")).toBeGreaterThan(0);

    // Emptied: the block says so rather than silently rendering nothing.
    const s2 = sweep(s1, jobs, { "pytorch/crcr-test": [] });
    expect(s2).toContain("No on-call is configured");

    const s3 = sweep(s2, jobs, { "pytorch/crcr-test": ["bob"] });
    expect(mentions(s3, "bob")).toBeGreaterThan(0);
  });
});

describe("renderCrcrSection", () => {
  test("renders nothing when no downstream repo failed", () => {
    expect(render([])).toBe("");
  });

  test("groups a repo's jobs into one block with the on-call pin", () => {
    const section = render(
      [
        crcrJob({ id: 111 }),
        crcrJob({
          id: 222,
          name: "crcr/pytorch/crcr-test/CRCR L3 CI/test-L3-callback",
          jobName: "test-L3-callback",
          conclusion: "timed_out",
        }),
      ],
      new Map([["pytorch/crcr-test", 4]]),
      { "pytorch/crcr-test": ["oncall-a", "oncall-b"] }
    );

    // Delimiters so the section can be spliced back into the comment.
    expect(section.startsWith(CRCR_SECTION_START)).toBe(true);
    expect(section.trimEnd().endsWith(CRCR_SECTION_END)).toBe(true);

    // One block, not one bullet list per job.
    expect(section.match(/<details>/g)!.length).toBe(1);

    // The summary carries owner and ratio while collapsed.
    expect(section).toContain(
      "<b>pytorch/crcr-test</b> · L3 · 2 of 4 jobs failed · on-call @oncall-a @oncall-b"
    );

    // Both jobs, each linked to the HUD deep link and the downstream run.
    expect(section).toContain(
      `[crcr/pytorch/crcr-test/CRCR L3 CI/test-L3-checkrun-creation](${HUD_PR_URL}#111) ([gh](https://github.com/pytorch/crcr-test/actions/runs/555)) — \`failure\``
    );
    expect(section).toContain(`test-L3-callback](${HUD_PR_URL}#222)`);
    expect(section).toContain("`timed_out`");

    // The pin is written once, with the markers that suppress it next sweep.
    expect(section).toContain(
      "<!-- crcr-pinned:pytorch/crcr-test:oncall-a -->"
    );
    expect(section).toContain(
      "<!-- crcr-pinned:pytorch/crcr-test:oncall-b -->"
    );
    expect(section).toContain("@oncall-a @oncall-b — please investigate.");
    expect(notifiedHandles(section)).toEqual(new Set(["oncall-a", "oncall-b"]));
    expect(notifiedHandlesByRepo(section)).toEqual(
      new Map([["pytorch/crcr-test", new Set(["oncall-a", "oncall-b"])]])
    );
  });

  test("re-renders handles without the mention once the repo is pinned", () => {
    const jobs = [crcrJob()];
    const oncalls = { "pytorch/crcr-test": ["oncall-a"] };

    const first = render(jobs, new Map([["pytorch/crcr-test", 1]]), oncalls);
    expect(first).toContain("@oncall-a — please investigate.");
    expect(first).toContain("<!-- crcr-pinned:pytorch/crcr-test:oncall-a -->");

    // The next sweep reads the markers out of the comment body and re-renders.
    const second = render(
      jobs,
      new Map([["pytorch/crcr-test", 1]]),
      oncalls,
      notifiedHandlesByRepo(first)
    );

    // Still named, so the reader knows who owns it, but no longer a mention
    // GitHub would turn into a second notification.
    expect(second).toContain("On-call oncall-a has been notified.");
    expect(second).not.toContain("@oncall-a");
    // The marker survives, which is what keeps the pin spent.
    expect(notifiedHandles(second)).toEqual(new Set(["oncall-a"]));
  });

  test("pages an on-call added after the first sweep, and only them", () => {
    const jobs = [crcrJob()];
    const first = render(jobs, new Map(), {
      "pytorch/crcr-test": ["oncall-a"],
    });
    expect(first).toContain("@oncall-a");

    // oncall-b joins the allowlist later. A pin keyed by repo alone would never
    // page them, so the handle has to be part of the key.
    const second = render(
      jobs,
      new Map(),
      {
        "pytorch/crcr-test": ["oncall-a", "oncall-b"],
      },
      notifiedHandlesByRepo(first)
    );

    expect(second).toContain("@oncall-b");
    expect(second).not.toContain("@oncall-a");
    // oncall-a is still named, so the reader knows who else owns it, but as
    // plain text rather than a mention.
    expect(second).toContain("oncall-a has");
    expect(second).toContain("already been notified.");
    // The summary reflects the same split: only the newly paged get an `@`.
    expect(second).toContain("on-call oncall-a @oncall-b");
  });

  test("mentions a login shared by two repos once in each block", () => {
    const section = render(
      [
        crcrJob(),
        crcrJob({
          id: 333,
          name: "crcr/a-org/a-repo/CI/build",
          jobName: "build",
          downstreamRepo: "a-org/a-repo",
        }),
      ],
      new Map(),
      {
        "pytorch/crcr-test": ["shared-oncall"],
        "a-org/a-repo": ["shared-oncall"],
      }
    );

    // Each repo is its own incident with its own pin, so a shared on-call is
    // mentioned in both blocks -- and each block carries the marker that keeps
    // it from being mentioned again for that repo.
    const blocks = section
      .split("<details><summary>")
      .slice(1)
      .map((b) => b.split("</details>")[0]);
    expect(blocks).toHaveLength(2);
    const [forA, forPytorch] = blocks;
    expect(forA).toContain("<b>a-org/a-repo</b>");
    expect(forA).toContain("@shared-oncall");
    expect(forA).toContain("<!-- crcr-pinned:a-org/a-repo:shared-oncall -->");
    expect(forPytorch).toContain("<b>pytorch/crcr-test</b>");
    expect(forPytorch).toContain("@shared-oncall");
    expect(forPytorch).toContain(
      "<!-- crcr-pinned:pytorch/crcr-test:shared-oncall -->"
    );
    expect(notifiedHandlesByRepo(section)).toEqual(
      new Map([
        ["a-org/a-repo", new Set(["shared-oncall"])],
        ["pytorch/crcr-test", new Set(["shared-oncall"])],
      ])
    );
  });

  test("ignores allowlist entries that are not valid handles", () => {
    const section = render([crcrJob()], new Map(), {
      "pytorch/crcr-test": ["oncall-a", "</summary><b>x</b>", "bad name"],
    });

    // Dropped rather than escaped: the value lands in a public comment.
    expect(section).not.toContain("</summary><b>x</b>");
    expect(section).not.toContain("bad name");
    expect(section).toContain("@oncall-a");
    expect(notifiedHandles(section)).toEqual(new Set(["oncall-a"]));
    // The entry does have handles, so the block must not claim it has none.
    expect(section).not.toContain("No on-call is configured");
  });

  test("drops handles whose mention would resolve to someone else", () => {
    // GitHub strips a trailing hyphen when resolving `@trail-`, so rendering it
    // would page whoever `trail` is and record a pin for a handle never paged.
    const section = render([crcrJob()], new Map(), {
      "pytorch/crcr-test": ["trail-", "a--b", "-lead", "a.b"],
    });

    for (const rejected of ["@trail", "a--b", "@-lead", "a.b"]) {
      expect(section).not.toContain(rejected);
    }
    expect(notifiedHandles(section).size).toBe(0);
    // Nothing usable survived, but the allowlist is not empty, so the block does
    // not claim that no on-call is configured.
    expect(section).not.toContain("No on-call is configured");
  });

  test("drops handles ending in a separator, hyphen or underscore alike", () => {
    // GitHub does not treat a trailing separator as part of a login, so these
    // would page a different account than the one written.
    const section = render([crcrJob()], new Map(), {
      "pytorch/crcr-test": ["a_", "ab_", "a__b", "org/team_", "a/b_", "trail-"],
    });

    for (const rejected of [
      "@a_",
      "@ab_",
      "@a__b",
      "@org/team_",
      "@a/b_",
      "@trail",
    ]) {
      expect(section).not.toContain(rejected);
    }
    expect(notifiedHandles(section).size).toBe(0);
  });

  test("tolerates an @ the allowlist wrote out in full", () => {
    // The allowlist header documents `[@oncall1, @oncall2]` and neither parser
    // strips it, so the entry must not be silently dropped.
    const section = render([crcrJob()], new Map(), {
      "pytorch/crcr-test": ["@oncall-a"],
    });

    expect(section).toContain("@oncall-a");
    expect(section).not.toContain("@@");
    expect(notifiedHandles(section)).toEqual(new Set(["oncall-a"]));
  });

  test("keeps interior single separators", () => {
    // Interior separators are part of the name and the live allowlist uses them.
    for (const ok of [
      "can-gaa-hou",
      "jewelkm89",
      "a_b-c",
      "a-b_c",
      "pytorch/pytorch-dev-infra",
      "KarhouTam",
      "subinz1",
    ]) {
      expect(isSafeHandle(ok)).toBe(true);
    }
    // Doubled separators are not a shape any of these names takes, and GitHub
    // logins forbid consecutive hyphens, so they stay out.
    for (const rejected of ["a__b", "a--b", "a_-b", "a-_b"]) {
      expect(isSafeHandle(rejected)).toBe(false);
    }
  });

  test("accepts the handle shapes the allowlist can legitimately hold", () => {
    const section = render([crcrJob()], new Map(), {
      "pytorch/crcr-test": ["alice_b", "bob-2", "pytorch/pytorch-dev-infra"],
    });

    expect(section).toContain("@alice_b");
    expect(section).toContain("@bob-2");
    expect(section).toContain("@pytorch/pytorch-dev-infra");
    expect(notifiedHandles(section)).toEqual(
      new Set(["alice_b", "bob-2", "pytorch/pytorch-dev-infra"])
    );
  });

  test("mentions a team handle the way the allowlist spells it", () => {
    const section = render([crcrJob()], new Map(), {
      "pytorch/crcr-test": ["pytorch/pytorch-dev-infra"],
    });

    expect(section).toContain("@pytorch/pytorch-dev-infra");
    expect(notifiedHandles(section)).toEqual(
      new Set(["pytorch/pytorch-dev-infra"])
    );
  });

  test("states that no on-call is configured instead of dropping the row", () => {
    const section = render([crcrJob()], new Map(), {});

    expect(section).toContain(
      "No on-call is configured for this repo in `.github/allowlist.yml`."
    );
    // No marker: its meaning is "someone was mentioned", and writing one here
    // would suppress the pin for a repo whose on-calls are added later.
    expect(notifiedHandles(section).size).toBe(0);
  });

  test("labels a blocking L4 block and still pins its owner", () => {
    const section = render(
      [crcrJob({ downstreamLevel: "L4" })],
      new Map([["pytorch/crcr-test", 2]]),
      { "pytorch/crcr-test": ["oncall-a"] }
    );

    // The level is what tells a reader whether the block is advisory or holding
    // the merge; L4 failures reach this section too, so their owner is named.
    expect(section).toContain(
      "<b>pytorch/crcr-test</b> · L4 (blocking) · 1 of 2 jobs failed"
    );
    expect(section).toContain("@oncall-a — please investigate.");
    // Telling an L4 on-call the failure is non-blocking would send them away
    // from a failure that is holding the merge.
    expect(section).toContain("This is **blocking**");
    expect(section).not.toContain("non-blocking");
  });

  test("tells an L3 on-call their failure does not hold the merge", () => {
    const section = render(
      [crcrJob({ downstreamLevel: "L3" })],
      new Map([["pytorch/crcr-test", 2]]),
      { "pytorch/crcr-test": ["oncall-a"] }
    );

    expect(section).toContain("This is **non-blocking**");
    expect(section).not.toContain("This is **blocking**");
  });

  test("groups several repos into one block each, sorted by repo", () => {
    const section = render(
      [
        crcrJob({
          downstreamRepo: "z-org/z-repo",
          name: "crcr/z-org/z-repo/CI/build",
        }),
        crcrJob(),
        crcrJob({
          downstreamRepo: "a-org/a-repo",
          name: "crcr/a-org/a-repo/CI/build",
        }),
      ],
      new Map([
        ["z-org/z-repo", 1],
        ["a-org/a-repo", 1],
        ["pytorch/crcr-test", 1],
      ]),
      { "pytorch/crcr-test": ["oncall-a"] }
    );

    expect(section.match(/<details>/g)!.length).toBe(3);
    expect(section.indexOf("a-org/a-repo")).toBeLessThan(
      section.indexOf("pytorch/crcr-test")
    );
    expect(section.indexOf("pytorch/crcr-test")).toBeLessThan(
      section.indexOf("z-org/z-repo")
    );
  });

  test("falls back to the failing count when the total is unknown", () => {
    const one = render([crcrJob()], new Map());
    expect(one).toContain("<b>pytorch/crcr-test</b> · L3 · 1 job failed");

    const two = render([crcrJob({ id: 1 }), crcrJob({ id: 2 })], new Map());
    expect(two).toContain("<b>pytorch/crcr-test</b> · L3 · 2 jobs failed");
  });

  test("caps the job bullets and reports how many were left out", () => {
    const jobs = Array.from({ length: MAX_JOB_BULLETS_PER_REPO + 3 }, (_, i) =>
      crcrJob({
        id: i,
        name: `crcr/pytorch/crcr-test/CI/job-${String(i).padStart(2, "0")}`,
      })
    );
    const section = render(jobs, new Map([["pytorch/crcr-test", jobs.length]]));

    expect(section.match(/\* \[/g)!.length).toBe(MAX_JOB_BULLETS_PER_REPO);
    expect(section).toContain("* …and 3 more");
    // The summary keeps the exact counts even when the list is trimmed.
    expect(section).toContain(`${jobs.length} of ${jobs.length} jobs failed`);
  });
});

describe("crcrSectionForSweep", () => {
  const oncalls = (repo: string) =>
    repo === "pytorch/crcr-test" ? ["oncall-a"] : [];

  function failedByRepo(jobs: RecentWorkflowsData[]) {
    const map = new Map<string, RecentWorkflowsData[]>();
    for (const job of jobs) {
      const repo = job.downstreamRepo!;
      map.set(repo, [...(map.get(repo) ?? []), job]);
    }
    return map;
  }

  test("renders the section and spends the pin when everything was read", () => {
    const section = crcrSectionForSweep(
      "",
      failedByRepo([crcrJob()]),
      new Map([["pytorch/crcr-test", 2]]),
      HUD_PR_URL,
      oncalls,
      true
    );

    expect(section).toContain("@oncall-a");
    expect(notifiedHandles(section)).toEqual(new Set(["oncall-a"]));
  });

  test("keeps the pins but not the blocks it cannot re-render", () => {
    // A sweep that cannot read the allowlist cannot rebuild the section, but
    // replacing it outright would drop the markers that record alice as paged and
    // the next sweep would page her a second time. Keeping the blocks instead
    // would leave an old sweep's failure list standing for as long as the read
    // fails, so the sweep keeps the pins alone.
    const pinned = crcrSectionForSweep(
      "",
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      oncalls,
      true
    );
    expect(crcrSectionHasBlocks(pinned)).toBe(true);

    const next = crcrSectionForSweep(
      `body\n${pinned}`,
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      null,
      true
    );

    expect(crcrSectionHasBlocks(next)).toBe(false);
    expect(next).not.toContain("<details");
    expect(notifiedHandles(next)).toEqual(new Set(["oncall-a"]));
    // "Could not read the allowlist" must not be reported as "this repo has no
    // on-calls", which is what a pin-less render would have said.
    expect(next).not.toContain("No on-call is configured");
  });

  test("keeps the pins but not the blocks when the rows could not be read", () => {
    const pinned = crcrSectionForSweep(
      "",
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      oncalls,
      true
    );

    // Nothing is known about the failures this sweep, so no failure list is
    // claimed -- the comment reports what it knows and recovers next sweep --
    // but the pins are not lost with it.
    const next = crcrSectionForSweep(
      `body\n${pinned}`,
      new Map(),
      new Map(),
      HUD_PR_URL,
      oncalls,
      false
    );

    expect(next).not.toContain("<details");
    expect(notifiedHandles(next)).toEqual(new Set(["oncall-a"]));
  });

  test("a sustained outage produces the same body every sweep", () => {
    // The comment is rewritten every 15 minutes and drci.ts skips the API call
    // when the body is unchanged, so a read that keeps failing has to converge on
    // one body instead of churning the comment.
    const pinned = crcrSectionForSweep(
      "",
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      oncalls,
      true
    );

    const sweep1 = crcrSectionForSweep(
      `body\n${pinned}`,
      new Map(),
      new Map(),
      HUD_PR_URL,
      oncalls,
      false
    );
    const sweep2 = crcrSectionForSweep(
      `body\n${sweep1}`,
      new Map(),
      new Map(),
      HUD_PR_URL,
      oncalls,
      false
    );

    expect(sweep2).toBe(sweep1);
  });

  test("recovers with the handles already pinned rendered bare", () => {
    const pinned = crcrSectionForSweep(
      "",
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      oncalls,
      true
    );

    // One unreadable sweep, then the allowlist is back.
    const degraded = crcrSectionForSweep(
      `body\n${pinned}`,
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      null,
      true
    );
    const recovered = crcrSectionForSweep(
      `body\n${degraded}`,
      failedByRepo([crcrJob()]),
      new Map([["pytorch/crcr-test", 2]]),
      HUD_PR_URL,
      oncalls,
      true
    );

    expect(crcrSectionHasBlocks(recovered)).toBe(true);
    expect(recovered).toContain(
      "<b>pytorch/crcr-test</b> · L3 · 1 of 2 jobs failed · on-call oncall-a"
    );
    expect(recovered).not.toContain("@oncall-a");
    expect(recovered).toContain("On-call oncall-a has been notified.");
    expect(notifiedHandles(recovered)).toEqual(new Set(["oncall-a"]));
  });

  test("drops the section once the failures are gone", () => {
    const pinned = crcrSectionForSweep(
      "",
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      oncalls,
      true
    );

    // The rows were read and hold no failures: the failure cleared, so the
    // section goes -- and the pins with it, so a later outage is news again.
    // That holds even when the allowlist is the thing that failed: whether
    // anything is failing is known without it.
    for (const onCalls of [oncalls, null]) {
      expect(
        crcrSectionForSweep(
          `body\n${pinned}`,
          new Map(),
          new Map(),
          HUD_PR_URL,
          onCalls,
          true
        )
      ).toBe("");
    }
  });

  test("renders nothing without pins when there is no section to keep", () => {
    // First failure ever, allowlist unreadable: no pins are spent, and the empty
    // section lets the caller's flat list report the jobs.
    expect(
      crcrSectionForSweep(
        "body with no crcr section",
        failedByRepo([crcrJob()]),
        new Map(),
        HUD_PR_URL,
        null,
        true
      )
    ).toBe("");
  });

  test("keeps a bare ledger when the allowlist cannot be read", () => {
    // What a push leaves behind: the pins with no blocks. Keeping it is what
    // stops the next sweep paging everyone again -- and it is what the caller
    // must not mistake for a section it can show.
    const ledger = pinLedger(
      crcrSectionForSweep(
        "",
        failedByRepo([crcrJob()]),
        new Map(),
        HUD_PR_URL,
        oncalls,
        true
      )
    );
    expect(ledger).not.toContain("<details");

    const next = crcrSectionForSweep(
      `body\n${ledger}`,
      failedByRepo([crcrJob()]),
      new Map(),
      HUD_PR_URL,
      null,
      true
    );
    expect(next).toBe(ledger);
    expect(crcrSectionHasBlocks(next)).toBe(false);
    expect(notifiedHandles(next)).toEqual(new Set(["oncall-a"]));
  });
});

describe("crcrSectionHasBlocks", () => {
  test("tells a rendered section from the ledger that has no blocks", () => {
    const rendered = render([crcrJob()], new Map(), {
      "pytorch/crcr-test": ["oncall-a"],
    });
    expect(crcrSectionHasBlocks(rendered)).toBe(true);
    expect(crcrSectionHasBlocks(pinLedger(rendered))).toBe(false);
    expect(crcrSectionHasBlocks("")).toBe(false);
  });
});

describe("latestAttemptPerJob", () => {
  test("keeps the highest attempt of a re-run job", () => {
    const failedFirst = crcrJob({
      id: 1,
      name: "crcr/pytorch/crcr-test/CI/build",
      jobName: "build",
      conclusion: "failure",
      runAttempt: 1,
    });
    const passedRetry = crcrJob({
      id: 2,
      name: "crcr/pytorch/crcr-test/CI/build",
      jobName: "build",
      conclusion: "success",
      runAttempt: 2,
    });

    // The re-run supersedes the failure, so only the green attempt survives --
    // otherwise a rerun that fixed the job would still render as red.
    const latest = latestAttemptPerJob([failedFirst, passedRetry]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(2);
    expect(latest[0].conclusion).toBe("success");
  });

  test("keeps the failure when the latest attempt is the failing one", () => {
    const passedFirst = crcrJob({
      id: 1,
      jobName: "build",
      conclusion: "success",
      runAttempt: 1,
    });
    const failedRetry = crcrJob({
      id: 2,
      jobName: "build",
      conclusion: "failure",
      runAttempt: 2,
    });

    const latest = latestAttemptPerJob([passedFirst, failedRetry]);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(2);
  });

  test("keeps a newer run's attempt over an older run's retry", () => {
    // run_attempt counts attempts of ONE run and starts over at 1 for the next,
    // so an older run's retry must not outrank a newer run's first attempt: a
    // re-dispatch for the same commit (a reopen, say) is a new run, and ranking
    // on the attempt alone reports the job red after the new run passed it --
    // and at L4 keeps blocking the merge on it.
    const olderRetry = crcrJob({
      id: 1,
      jobName: "build",
      runId: 101,
      conclusion: "failure",
      runAttempt: 2,
    });
    const newerRun = crcrJob({
      id: 2,
      jobName: "build",
      runId: 202,
      conclusion: "success",
      runAttempt: 1,
    });

    for (const rows of [
      [olderRetry, newerRun],
      [newerRun, olderRetry],
    ]) {
      const latest = latestAttemptPerJob(rows);
      expect(latest).toHaveLength(1);
      expect(latest[0].id).toBe(2);
    }
  });

  test("dedups per job, not per repo", () => {
    const latest = latestAttemptPerJob([
      crcrJob({ id: 1, jobName: "build", runAttempt: 1 }),
      crcrJob({ id: 2, jobName: "test", runAttempt: 1 }),
      crcrJob({ id: 3, jobName: "test", runAttempt: 2 }),
    ]);

    expect(latest.map((j) => j.id).sort()).toEqual([1, 3]);
  });

  test("treats a missing attempt as the first one", () => {
    const latest = latestAttemptPerJob([
      crcrJob({ id: 1, jobName: "build" }),
      crcrJob({ id: 2, jobName: "build" }),
    ]);

    // Both claim attempt 1; one row survives rather than the job counting twice.
    expect(latest).toHaveLength(1);
  });
  test("keeps same-named jobs from different workflows of one repo", () => {
    // The check run name embeds the workflow, so these are two distinct jobs
    // despite sharing a job name and a repo.
    const latest = latestAttemptPerJob([
      crcrJob({
        id: 1,
        name: "crcr/pytorch/crcr-test/CI/test",
        jobName: "test",
      }),
      crcrJob({
        id: 2,
        name: "crcr/pytorch/crcr-test/Nightly/test",
        jobName: "test",
      }),
    ]);

    expect(latest.map((j) => j.id).sort()).toEqual([1, 2]);
  });

  test("prefers the failing row when two attempts tie", () => {
    // The relay defaults run_attempt to 1 when the downstream omits it, so both
    // genuine attempts can claim attempt 1. Row order is then arbitrary, and
    // reporting a green row would drop a real failure.
    const green = crcrJob({ id: 1, jobName: "build", conclusion: "success" });
    const red = crcrJob({ id: 2, jobName: "build", conclusion: "failure" });

    expect(latestAttemptPerJob([green, red])[0].id).toBe(2);
    expect(latestAttemptPerJob([red, green])[0].id).toBe(2);
  });

  test("does not let a conclusion-less attempt bury a known failure", () => {
    // The downstream reported completed without a conclusion the second time
    // round. That row says nothing about the job, so it must not win on attempt
    // number and report the job as not-failed -- the first attempt is still the
    // last thing actually known about it. Blindly taking the highest attempt
    // drops the job from the section, from its pin, and for L4 from the blocking
    // failures, while still counting it in the denominator.
    const failed = crcrJob({
      id: 1,
      jobName: "build",
      conclusion: "failure",
      runAttempt: 1,
    });
    const unknown = crcrJob({
      id: 2,
      jobName: "build",
      conclusion: "",
      runAttempt: 2,
    });

    expect(latestAttemptPerJob([failed, unknown]).map((j) => j.id)).toEqual([
      1,
    ]);
    expect(latestAttemptPerJob([unknown, failed]).map((j) => j.id)).toEqual([
      1,
    ]);
  });

  test("still resolves a known re-run over a known failure", () => {
    // The rule above must not undo the re-run fix: both rows reported, so the
    // higher attempt still wins and a green re-run clears the red.
    const failed = crcrJob({
      id: 1,
      jobName: "build",
      conclusion: "failure",
      runAttempt: 1,
    });
    const passed = crcrJob({
      id: 2,
      jobName: "build",
      conclusion: "success",
      runAttempt: 2,
    });

    expect(latestAttemptPerJob([failed, passed]).map((j) => j.id)).toEqual([2]);
  });

  test("keeps one row for a job that never reported a conclusion", () => {
    // Nothing is known about it, but it ran, so it stays in the denominator
    // rather than vanishing from the ratio.
    const first = crcrJob({ id: 1, jobName: "build", conclusion: "" });
    const second = crcrJob({ id: 2, jobName: "build", conclusion: "" });

    expect(latestAttemptPerJob([first, second])).toHaveLength(1);
  });
});

describe("latestAttemptsForHead", () => {
  test("keeps a current-head failure when a stale run holds a higher attempt", () => {
    // The old run was re-run after the new push, so its attempt 2 is the highest
    // for this job. Resolving attempts before the head filter would pick the
    // stale row and then drop it, silently deleting the failure that is still
    // red on the commit the comment describes.
    const staleRetry = crcrJob({
      id: 1,
      name: "crcr/pytorch/crcr-test/CI/build",
      jobName: "build",
      head_sha: "old111",
      conclusion: "success",
      runAttempt: 2,
    });
    const currentFailure = crcrJob({
      id: 2,
      name: "crcr/pytorch/crcr-test/CI/build",
      jobName: "build",
      head_sha: "new222",
      conclusion: "failure",
      runAttempt: 1,
    });

    expect(
      latestAttemptsForHead([staleRetry, currentFailure], "new222").map(
        (job) => job.id
      )
    ).toEqual([2]);
  });

  test("resolves the current head's own re-runs to the latest attempt", () => {
    const failedFirst = crcrJob({
      id: 1,
      jobName: "build",
      head_sha: "new222",
      conclusion: "failure",
      runAttempt: 1,
    });
    const passedRetry = crcrJob({
      id: 2,
      jobName: "build",
      head_sha: "new222",
      conclusion: "success",
      runAttempt: 2,
    });

    const rows = latestAttemptsForHead([failedFirst, passedRetry], "new222");
    expect(rows).toHaveLength(1);
    expect(rows[0].conclusion).toBe("success");
  });

  test("drops rows from a superseded push", () => {
    const stale = crcrJob({ id: 1, head_sha: "old111", runAttempt: 1 });
    expect(latestAttemptsForHead([stale], "new222")).toEqual([]);
  });

  test("keeps rows written before the head SHA column existed", () => {
    // An empty SHA is missing data, not a different commit, so it stays -- for a
    // job this commit has no row for.
    const legacy = crcrJob({ id: 1, head_sha: "", runAttempt: 1 });
    expect(latestAttemptsForHead([legacy], "new222").map((j) => j.id)).toEqual([
      1,
    ]);
  });

  test("does not let a row of unknown commit keep a job red once this commit passed", () => {
    // Both rows claim attempt 1, so the tie-break inside latestAttemptPerJob
    // would hand this job to the failing one. When the failing row's commit is
    // unknown and this commit has its own row, that reports a job as red -- and
    // at L4 as blocking -- that this commit already passed.
    const unknownCommitFailure = crcrJob({
      id: 1,
      name: "crcr/pytorch/crcr-test/CI/build",
      jobName: "build",
      head_sha: "",
      conclusion: "failure",
      runAttempt: 1,
    });
    const thisCommitPass = crcrJob({
      id: 2,
      name: "crcr/pytorch/crcr-test/CI/build",
      jobName: "build",
      head_sha: "new222",
      conclusion: "success",
      runAttempt: 1,
    });

    for (const rows of [
      [unknownCommitFailure, thisCommitPass],
      [thisCommitPass, unknownCommitFailure],
    ]) {
      const result = latestAttemptsForHead(rows, "new222");
      expect(result.map((job) => job.id)).toEqual([2]);
      expect(result[0].conclusion).toBe("success");
    }
  });
});

describe("notifiedHandles", () => {
  const inSection = (inner: string) =>
    `${CRCR_SECTION_START}\n${inner}\n${CRCR_SECTION_END}\n`;

  test("reads every marker out of the section, keyed by repo", () => {
    const body = inSection(
      "<!-- crcr-pinned:pytorch/crcr-test:alice -->@alice\n" +
        "<!-- crcr-pinned:a-org/a-repo:bob-2 -->@bob-2"
    );
    expect(notifiedHandles(body)).toEqual(new Set(["alice", "bob-2"]));
    expect(notifiedHandlesByRepo(body)).toEqual(
      new Map([
        ["pytorch/crcr-test", new Set(["alice"])],
        ["a-org/a-repo", new Set(["bob-2"])],
      ])
    );
  });

  test("accepts team handles and underscored logins", () => {
    const body = inSection(
      "<!-- crcr-pinned:pytorch/crcr-test:pytorch/pytorch-dev-infra -->@pytorch/pytorch-dev-infra" +
        "<!-- crcr-pinned:pytorch/crcr-test:alice_smith -->@alice_smith"
    );
    expect(notifiedHandles(body)).toEqual(
      new Set(["pytorch/pytorch-dev-infra", "alice_smith"])
    );
  });

  test("ignores markers outside the section", () => {
    // A marker is plain text in a comment people discuss; one quoted elsewhere
    // on the PR must not be able to suppress a real page.
    const body =
      "As discussed: <!-- crcr-pinned:pytorch/crcr-test:alice --> means paged.\n" +
      inSection("<!-- crcr-pinned:a-org/a-repo:bob-2 -->@bob-2");
    expect(notifiedHandles(body)).toEqual(new Set(["bob-2"]));
  });

  test("ignores unrelated markers and comments with no section", () => {
    expect(notifiedHandles("")).toEqual(new Set());
    expect(notifiedHandles("<!-- pr-status-start -->text")).toEqual(new Set());
    // A marker with no repo is not one of ours, and a half-open section is not
    // a section.
    expect(
      notifiedHandles(
        inSection("<!-- crcr-pinned:alice -->") +
          `${CRCR_SECTION_START}<!-- crcr-pinned:pytorch/crcr-test:a -->`
      )
    ).toEqual(new Set());
  });

  test("defuses its own control strings in downstream text", () => {
    // Workflow and job names are downstream text rendered mid-bullet. A name
    // holding a pin marker must not be read as a pin, or a handle could be
    // recorded as paged by a sweep that never mentioned it -- a missed page.
    const injected = render(
      [
        crcrJob({
          name: "crcr/pytorch/crcr-test/CI/<!-- crcr-pinned:pytorch/crcr-test:alice -->",
        }),
      ],
      new Map(),
      { "pytorch/crcr-test": ["oncall-a"] }
    );
    expect(injected).toContain("@oncall-a"); // the real on-call is still paged
    expect(injected).not.toContain("<!-- crcr-pinned:pytorch/crcr-test:alice");
    expect(notifiedHandles(injected)).toEqual(new Set(["oncall-a"]));
  });

  test("is not truncated by a delimiter inside a job name", () => {
    // The same text could contain the section-end delimiter, which -- read
    // anywhere -- would cut the section short and drop every marker behind it.
    const section = render(
      [crcrJob({ name: `crcr/pytorch/crcr-test/CI/${CRCR_SECTION_END}` })],
      new Map(),
      { "pytorch/crcr-test": ["oncall-a"] }
    );
    const body = `before\n${section}after`;
    expect(notifiedHandles(body)).toEqual(new Set(["oncall-a"]));
  });

  test("defuses control strings in the run URL and the conclusion", () => {
    const section = render(
      [
        crcrJob({
          html_url: `${CRCR_SECTION_END}`,
          conclusion: `<!-- crcr-pinned:alice -->`,
        }),
      ],
      new Map(),
      { "pytorch/crcr-test": ["oncall-a"] }
    );
    expect(notifiedHandles(`before\n${section}after`)).toEqual(
      new Set(["oncall-a"])
    );
  });
});
