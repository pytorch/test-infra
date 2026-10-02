import { readFileSync } from "fs";
import * as clickhouse from "lib/clickhouse";
import {
  buildGreenlightOpenedLine,
  buildGreenlightSections,
} from "lib/greenlight/greenlightComment";
import * as greenlightEligibility from "lib/greenlight/greenlightEligibility";
import { renderGreenlightEligibility } from "lib/greenlight/greenlightEligibility";
import * as greenlightRender from "lib/greenlight/greenlightRender";
import { GREENLIGHT_PENDING_ALT_ATTR } from "lib/greenlight/greenlightSweep";
import { Octokit } from "octokit";
import path from "path";
import { format } from "util";

const LAND_ROW = {
  pr_number: 194531,
  status: "LAND",
  reason: "clean",
  message: "template edits verified",
  head_sha: "013fcdd87c69d270338390baa8bf0555ca8cfd70",
  eval_job: "https://github.com/pytorch/test-infra/actions/runs/32757228321",
  version: "2026-08-24T17:42:35.589000",
};

const NO_LAND_ROW = {
  pr_number: 194654,
  status: "NO_LAND",
  reason: "breaking_change",
  message: "the new import guard is bc-breaking",
  head_sha: "b00aa03feef186eacc976cce162006f0a44936fe",
  eval_job: "https://github.com/pytorch/test-infra/actions/runs/32778700698",
  version: "2026-08-24T21:40:01.442000",
};

// A status greenlightRender has no branch for, so it falls through to "". Every
// other field is populated, so an empty render can only come from the status.
const UNKNOWN_STATUS_ROW = {
  pr_number: 194645,
  status: "SOMETHING_NEW",
  reason: "clean",
  message: "a status this renderer predates",
  head_sha: "5b9b0093017bb70bd26c6aa52595238c52b4b048",
  eval_job: "https://github.com/pytorch/test-infra/actions/runs/32782669526",
  version: "2026-08-24T22:02:55.744000",
};

// A PR the sweep covers that has no greenlight state row at all.
const NO_STATE_PR = {
  pr_number: 194000,
  head_sha: "8c9cd4b0b0e2c7bd4a2b7e1e6d3a9c5f0b1d2e3a",
};

// A PR whose only state is a shadow evaluation, which the query returns only
// when the PR has no non-shadow row.
const SHADOW_ROW = { ...NO_LAND_ROW, pr_number: 194777, shadow: true };

// The head a PR moved to after its verdict was recorded.
const PUSHED_SHA = "f1e2d3c4b5a6978877665544332211aabbccddee";

// A live review. The renderer only emits the in-progress marker while the row is
// inside the staleness window, and buildGreenlightSections stamps `now` itself,
// so this version has to track the wall clock rather than be a fixed date.
function inFlightRow() {
  return {
    ...LAND_ROW,
    pr_number: 194888,
    status: "AI_REVIEW_DISPATCHED",
    version: new Date().toISOString().replace("Z", ""),
  };
}

// What a console sink prints for the calls a console.error spy recorded.
// JSON.stringify cannot stand in for this: Error.message and Error.stack are
// non-enumerable, so it renders every logged error as `{}` and a redaction check
// built on it passes whatever the error carries.
function loggedText(spy: jest.SpyInstance): string {
  return spy.mock.calls.map((call) => format(...call)).join("\n");
}

// pr_number -> head sha, as the Dr.CI sweep hands them over. Defaults each PR's
// head to the sha its own row was reviewed at, so only the tests about a
// superseded verdict have to say otherwise.
function heads(
  ...rows: { pr_number: number; head_sha: string }[]
): Map<number, string> {
  return new Map(rows.map((row) => [row.pr_number, row.head_sha]));
}

function fakeOctokit() {
  return {
    rest: {
      pulls: {
        get: jest.fn(async ({ pull_number }: { pull_number: number }) => ({
          data: { number: pull_number },
        })),
      },
    },
  };
}

describe("buildGreenlightSections", () => {
  let queryClickhouseSaved: jest.SpyInstance;
  let octokit: ReturnType<typeof fakeOctokit>;
  let github: Octokit;
  let gateFactory: jest.SpyInstance;
  let check: jest.Mock;

  beforeEach(() => {
    queryClickhouseSaved = jest
      .spyOn(clickhouse, "queryClickhouseSaved")
      .mockResolvedValue([]);
    octokit = fakeOctokit();
    github = octokit as unknown as Octokit;
    check = jest.fn().mockResolvedValue(null);
    gateFactory = jest
      .spyOn(greenlightEligibility, "greenlightEligibilityGate")
      .mockReturnValue(check);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("issues no query for a repo that is not a greenlight repo", async () => {
    const sections = await buildGreenlightSections(
      "pytorch",
      "vision",
      heads(LAND_ROW),
      github
    );

    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  it("issues no query when no PRs were passed", async () => {
    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      new Map(),
      github
    );

    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("batches every PR into one query and keys the sections by pr_number", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW, NO_LAND_ROW]);

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(LAND_ROW, NO_LAND_ROW, NO_STATE_PR),
      github
    );

    expect(queryClickhouseSaved).toHaveBeenCalledTimes(1);
    expect(queryClickhouseSaved).toHaveBeenCalledWith("greenlight_pr_states", {
      repo: "pytorch/pytorch",
      prNumbers: [
        LAND_ROW.pr_number,
        NO_LAND_ROW.pr_number,
        NO_STATE_PR.pr_number,
      ],
    });
    expect([...sections.keys()]).toEqual([
      LAND_ROW.pr_number,
      NO_LAND_ROW.pr_number,
    ]);
    expect(sections.get(LAND_ROW.pr_number)).toContain(
      greenlightRender.GREENLIGHT_SECTION_HEADER
    );
    expect(sections.get(LAND_ROW.pr_number)).toContain(LAND_ROW.message);
    expect(sections.get(NO_LAND_ROW.pr_number)).toContain(
      greenlightRender.GREENLIGHT_NO_LAND_HEADLINE
    );
  });

  // The repo gate folds case, so a mixed-case request gets this far. Every row in
  // misc.greenlight_pr_state is written lowercase, so querying the raw spelling
  // matches nothing and the section silently renders empty.
  it("queries the canonical repo key for a mixed-case request", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW]);

    const sections = await buildGreenlightSections(
      "PyTorch",
      "PyTorch",
      heads(LAND_ROW),
      github
    );

    expect(queryClickhouseSaved).toHaveBeenCalledWith("greenlight_pr_states", {
      repo: "pytorch/pytorch",
      prNumbers: [LAND_ROW.pr_number],
    });
    expect(sections.size).toBe(1);
  });

  it("maps the row's columns onto the renderer's state", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW]);
    const render = jest.spyOn(greenlightRender, "renderGreenlightSection");

    await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(LAND_ROW),
      github
    );

    expect(render).toHaveBeenCalledWith(
      {
        // Not a column: the row does not carry the repo, so the sweep's own
        // folded key is what the renderer builds the report link from.
        repo: "pytorch/pytorch",
        prNumber: LAND_ROW.pr_number,
        status: LAND_ROW.status,
        reason: LAND_ROW.reason,
        message: LAND_ROW.message,
        headSha: LAND_ROW.head_sha,
        evalJob: LAND_ROW.eval_job,
        version: LAND_ROW.version,
      },
      expect.any(Date),
      LAND_ROW.head_sha
    );
  });

  it("hands the renderer the PR's own head, marking a superseded verdict", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW]);

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      new Map([[LAND_ROW.pr_number, PUSHED_SHA]]),
      github
    );

    expect(sections.get(LAND_ROW.pr_number)).toContain(
      greenlightRender.GREENLIGHT_OUTDATED_HEADLINE_PREFIX
    );
  });

  // A row for a PR the sweep did not ask about cannot be matched to a head sha,
  // and an unknown head must not read as a mismatch with the reviewed one.
  it("renders a row with no head sha of its own as up to date", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW, NO_LAND_ROW]);

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(LAND_ROW),
      github
    );

    expect(sections.get(NO_LAND_ROW.pr_number)).not.toContain(
      greenlightRender.GREENLIGHT_OUTDATED_HEADLINE_PREFIX
    );
  });

  // The marker is what pins a PR into the next sweep, and roughly a third of
  // review starts land on PRs with no recent CI activity for the time-windowed
  // query to select. For those it is the only thing that gets the PR swept at
  // all, so this passthrough is load-bearing rather than a backstop.
  it("passes the in-progress marker through into the returned section", async () => {
    const row = inFlightRow();
    queryClickhouseSaved.mockResolvedValue([row]);

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(row),
      github
    );

    expect(sections.get(row.pr_number)).toContain(GREENLIGHT_PENDING_ALT_ATTR);
  });

  // The only handler above this one is in drci.ts and it fails the whole sweep to
  // an empty map, so an unguarded throw on one row takes the GREEN LIGHT section
  // off every other PR in the sweep too.
  it("drops only the row whose render threw, keeping the rest of the sweep", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW, NO_LAND_ROW]);
    const thrown = new Error("render blew up on one row");
    const render = jest
      .spyOn(greenlightRender, "renderGreenlightSection")
      .mockImplementation((state) => {
        if (state.prNumber === LAND_ROW.pr_number) throw thrown;
        return "rendered";
      });
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    check.mockResolvedValue("waiting");

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(LAND_ROW, NO_LAND_ROW),
      github
    );

    expect(render).toHaveBeenCalledTimes(2);
    expect([...sections.keys()]).toEqual([NO_LAND_ROW.pr_number]);
    // A PR with a row of its own never reaches the eligibility gate, even when
    // that row renders nothing.
    expect(check).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
    // Enough to find the row, and not the model's text: `message` is scrubbed on
    // its way into the comment and not on its way into a log. The error is a
    // fixed string, as the renderer's own throws are, so rendering the whole call
    // the way a console sink does leaks nothing.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("section render threw"),
      LAND_ROW.pr_number,
      thrown
    );
    expect(loggedText(logged)).not.toContain(LAND_ROW.message);
  });

  it("skips rows that render to nothing", async () => {
    queryClickhouseSaved.mockResolvedValue([UNKNOWN_STATUS_ROW, LAND_ROW]);
    check.mockResolvedValue("waiting");

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(UNKNOWN_STATUS_ROW, LAND_ROW),
      github
    );

    expect([...sections.keys()]).toEqual([LAND_ROW.pr_number]);
    expect(check).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  it("renders the eligibility line for a PR with no state, read with the sweep's Octokit", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW]);
    check.mockResolvedValue("waiting");

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(LAND_ROW, NO_STATE_PR),
      github
    );

    expect(gateFactory).toHaveBeenCalledTimes(1);
    expect(gateFactory).toHaveBeenCalledWith(octokit, "pytorch", "pytorch");
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({
      owner: "pytorch",
      repo: "pytorch",
      pull_number: NO_STATE_PR.pr_number,
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ number: NO_STATE_PR.pr_number });
    expect(sections.get(NO_STATE_PR.pr_number)).toBe(
      renderGreenlightEligibility("waiting")
    );
    expect(sections.get(LAND_ROW.pr_number)).toContain(LAND_ROW.message);
  });

  it("renders nothing for a PR whose only state is shadow, and runs no gate for it", async () => {
    queryClickhouseSaved.mockResolvedValue([SHADOW_ROW]);
    check.mockResolvedValue("waiting");

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(SHADOW_ROW),
      github
    );

    expect(sections.size).toBe(0);
    expect(check).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  it("renders a non-shadow row as before, and runs no gate for it", async () => {
    const row = { ...LAND_ROW, shadow: false };
    queryClickhouseSaved.mockResolvedValue([row]);

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(row),
      github
    );

    expect(sections.get(row.pr_number)).toBe(
      greenlightRender.renderGreenlightSection(
        {
          repo: "pytorch/pytorch",
          prNumber: row.pr_number,
          status: row.status,
          reason: row.reason,
          message: row.message,
          headSha: row.head_sha,
          evalJob: row.eval_job,
          version: row.version,
        },
        new Date(),
        row.head_sha
      )
    );
    expect(check).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  // drci.ts fails the whole sweep to an empty map on a rejection, so a failed query
  // renders nothing for any PR -- eligibility lines included.
  it("propagates a query failure without reading any PR", async () => {
    queryClickhouseSaved.mockRejectedValue(new Error("clickhouse down"));

    await expect(
      buildGreenlightSections(
        "pytorch",
        "pytorch",
        heads(LAND_ROW, NO_STATE_PR),
        github
      )
    ).rejects.toThrow("clickhouse down");
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it.each([
    ["the eligibility check", "check"],
    ["the PR read", "pulls.get"],
  ])("drops only the PR whose %s failed, logging it", async (_, failing) => {
    const other = { pr_number: 194001, head_sha: NO_STATE_PR.head_sha };
    const thrown = new Error("github unreachable");
    check.mockImplementation(async (pr: { number: number }) => {
      if (failing === "check" && pr.number === NO_STATE_PR.pr_number) {
        throw thrown;
      }
      return "too_big";
    });
    octokit.rest.pulls.get.mockImplementation(async ({ pull_number }) => {
      if (failing === "pulls.get" && pull_number === NO_STATE_PR.pr_number) {
        throw thrown;
      }
      return { data: { number: pull_number } };
    });
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(NO_STATE_PR, other),
      github
    );

    expect([...sections.keys()]).toEqual([other.pr_number]);
    expect(sections.get(other.pr_number)).toBe(
      renderGreenlightEligibility("too_big")
    );
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("eligibility check failed"),
      NO_STATE_PR.pr_number,
      thrown
    );
  });
});

describe("buildGreenlightOpenedLine", () => {
  const PAYLOAD_PR = { number: 31, user: { login: "alice" } };
  let check: jest.Mock;
  let gateFactory: jest.SpyInstance;

  function context(action: string) {
    return {
      octokit: { marker: "probot octokit" },
      payload: { action, pull_request: PAYLOAD_PR },
    };
  }

  beforeEach(() => {
    check = jest.fn().mockResolvedValue("merge_rules");
    gateFactory = jest
      .spyOn(greenlightEligibility, "greenlightEligibilityGate")
      .mockReturnValue(check);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("checks the payload's PR with the event's Octokit on an opened event", async () => {
    const ctx = context("opened");

    const line = await buildGreenlightOpenedLine("pytorch", "pytorch", ctx);

    expect(line).toBe(renderGreenlightEligibility("merge_rules"));
    expect(gateFactory).toHaveBeenCalledWith(ctx.octokit, "pytorch", "pytorch");
    expect(check).toHaveBeenCalledWith(PAYLOAD_PR);
  });

  it.each([
    ["a synchronize event", "synchronize", "pytorch"],
    ["a repo that is not a greenlight repo", "opened", "vision"],
  ])("renders nothing and checks nothing for %s", async (_, action, repo) => {
    const line = await buildGreenlightOpenedLine(
      "pytorch",
      repo,
      context(action)
    );

    expect(line).toBe("");
    expect(check).not.toHaveBeenCalled();
  });

  it("renders nothing and logs when the check fails", async () => {
    const thrown = new Error("issue unreadable");
    check.mockRejectedValue(thrown);
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});

    const line = await buildGreenlightOpenedLine(
      "pytorch",
      "pytorch",
      context("opened")
    );

    expect(line).toBe("");
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("eligibility check failed"),
      PAYLOAD_PR.number,
      thrown
    );
  });
});

// buildGreenlightSections reaches this SQL by name through queryClickhouseSaved, so the
// only place its text can be pinned is the file itself. Nothing here runs the query.
const RENDER_QUERY_SQL = readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "greenlight_pr_states",
    "query.sql"
  ),
  "utf-8"
);

// The header comment names `shadow` and `LIMIT 1 BY` while explaining them, and the
// assertions below are about the statement, not the prose.
const RENDER_QUERY = RENDER_QUERY_SQL.replace(/--.*$/gm, "");

function clause(start: string, end: string): string {
  return RENDER_QUERY.slice(
    RENDER_QUERY.indexOf(start),
    RENDER_QUERY.indexOf(end)
  );
}

describe("greenlight_pr_states query.sql", () => {
  // A PR whose rows are all shadow has to come back as one, or the render cannot
  // tell it from a PR with no state and shows it the eligibility line.
  it("keeps shadow rows and selects the shadow column", () => {
    expect(clause("SELECT", "FROM").split(/[\s,]+/)).toContain("shadow");
    expect(clause("WHERE", "ORDER BY")).not.toContain("shadow");
  });

  // false sorts first, so the collapse keeps a PR's newest non-shadow row whenever it
  // has one, however many newer shadow rows sit above it.
  it("prefers a non-shadow row in the LIMIT 1 BY collapse", () => {
    expect(RENDER_QUERY.replace(/\s+/g, " ")).toContain(
      "ORDER BY pr_number, shadow, run_id DESC, version DESC LIMIT 1 BY pr_number"
    );
  });
});
