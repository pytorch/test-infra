import * as clickhouse from "lib/clickhouse";
import {
  buildPrReviewSections,
  PR_REVIEW_REPOS,
} from "lib/prReview/prReviewComment";
import * as prReviewRender from "lib/prReview/prReviewRender";

const ROW = {
  pr_number: 196508,
  head_sha: "183b1a21182c55bbb7e833aed6f6af2cd279ef6f",
  status: "succeeded",
  verdict: "ready_for_human_review",
  summary: "Looks coherent.",
  findings_count: 0,
  findings_json: "",
  review_run_id: 36866468841,
  timestamp: "2026-10-01 19:50:00.000",
};
const OTHER = { ...ROW, pr_number: 199010, verdict: "changes_requested" };

describe("buildPrReviewSections", () => {
  let queryClickhouseSaved: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouseSaved = jest
      .spyOn(clickhouse, "queryClickhouseSaved")
      .mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("issues no query for a repo that is not enabled", async () => {
    const sections = await buildPrReviewSections(
      "pytorch",
      "vision",
      new Map([[ROW.pr_number, ROW.head_sha]])
    );
    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("holds every repo entry in lower case", () => {
    for (const name of PR_REVIEW_REPOS) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it("issues no query when no PRs were passed", async () => {
    const sections = await buildPrReviewSections(
      "pytorch",
      "pytorch",
      new Map()
    );
    expect(sections.size).toBe(0);
    expect(queryClickhouseSaved).not.toHaveBeenCalled();
  });

  it("batches the sweep into one query and keys sections by PR", async () => {
    queryClickhouseSaved.mockResolvedValue([ROW]);
    const sections = await buildPrReviewSections(
      "PyTorch",
      "PyTorch",
      new Map([
        [ROW.pr_number, ROW.head_sha],
        [123, "abc"],
      ])
    );
    expect(queryClickhouseSaved).toHaveBeenCalledTimes(1);
    expect(queryClickhouseSaved).toHaveBeenCalledWith(
      "pr_review_verdicts_for_prs",
      { repo: "pytorch/pytorch", prNumbers: [ROW.pr_number, 123] }
    );
    expect(Array.from(sections.keys())).toEqual([ROW.pr_number]);
    expect(sections.get(ROW.pr_number)).toContain("Ready for human review");
  });

  it("keeps other PRs' sections when one row's render throws", async () => {
    queryClickhouseSaved.mockResolvedValue([ROW, OTHER]);
    const real = prReviewRender.renderPrReviewSection;
    jest
      .spyOn(prReviewRender, "renderPrReviewSection")
      .mockImplementation((row, ...rest) => {
        if (row.pr_number === ROW.pr_number) {
          throw new Error("boom");
        }
        return real(row, ...rest);
      });
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const sections = await buildPrReviewSections(
      "pytorch",
      "pytorch",
      new Map([
        [ROW.pr_number, ROW.head_sha],
        [OTHER.pr_number, OTHER.head_sha],
      ])
    );
    expect(Array.from(sections.keys())).toEqual([OTHER.pr_number]);
    expect(errors).toHaveBeenCalled();
  });
});
