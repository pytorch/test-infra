import * as clickhouse from "lib/clickhouse";
import { buildGreenlightSections } from "lib/greenlight/greenlightComment";
import * as greenlightRender from "lib/greenlight/greenlightRender";

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

// pr_number -> head sha, as the Dr.CI sweep hands them over. Defaults each PR's
// head to the sha its own row was reviewed at, so only the tests about a
// superseded verdict have to say otherwise.
function heads(
  ...rows: { pr_number: number; head_sha: string }[]
): Map<number, string> {
  return new Map(rows.map((row) => [row.pr_number, row.head_sha]));
}

describe("buildGreenlightSections", () => {
  const OLD_ENV = process.env;
  let queryClickhouseSaved: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.DRCI_GREENLIGHT_COMMENT_ENABLED = "true";
    queryClickhouseSaved = jest
      .spyOn(clickhouse, "queryClickhouseSaved")
      .mockResolvedValue([]);
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  it("issues no query when the comment flag is off", async () => {
    process.env.DRCI_GREENLIGHT_COMMENT_ENABLED = "false";

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(LAND_ROW)
    );

    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("issues no query for a repo that is not greenlight-enabled", async () => {
    const sections = await buildGreenlightSections(
      "pytorch",
      "vision",
      heads(LAND_ROW)
    );

    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("issues no query when no PRs were passed", async () => {
    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      new Map()
    );

    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("batches every PR into one query and keys the sections by pr_number", async () => {
    queryClickhouseSaved.mockResolvedValue([LAND_ROW, NO_LAND_ROW]);

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(LAND_ROW, NO_LAND_ROW, NO_STATE_PR)
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
      heads(LAND_ROW)
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

    await buildGreenlightSections("pytorch", "pytorch", heads(LAND_ROW));

    expect(render).toHaveBeenCalledWith(
      {
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
      new Map([[LAND_ROW.pr_number, PUSHED_SHA]])
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
      heads(LAND_ROW)
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
      heads(row)
    );

    expect(sections.get(row.pr_number)).toContain(
      greenlightRender.GREENLIGHT_PENDING_ALT_ATTR
    );
  });

  it("skips rows that render to nothing", async () => {
    queryClickhouseSaved.mockResolvedValue([UNKNOWN_STATUS_ROW, LAND_ROW]);

    const sections = await buildGreenlightSections(
      "pytorch",
      "pytorch",
      heads(UNKNOWN_STATUS_ROW, LAND_ROW)
    );

    expect([...sections.keys()]).toEqual([LAND_ROW.pr_number]);
  });
});
