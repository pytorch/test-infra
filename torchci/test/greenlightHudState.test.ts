import {
  buildStatusByPr,
  GreenlightPrStateRow,
  isGreenlightApproved,
  supersedes,
} from "lib/greenlight/greenlightHudState";
import {
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";

function row(overrides: Partial<GreenlightPrStateRow>): GreenlightPrStateRow {
  return {
    pr_number: 1,
    status: GREENLIGHT_STATUS_LAND,
    reason: "clean",
    message: "looks fine",
    head_sha: "a".repeat(40),
    eval_job: "",
    run_id: 1,
    version: "2026-09-01 00:00:00.000",
    ...overrides,
  };
}

describe("isGreenlightApproved", () => {
  test("only LAND counts as approved", () => {
    expect(isGreenlightApproved(GREENLIGHT_STATUS_LAND)).toBe(true);
    for (const status of [
      GREENLIGHT_STATUS_NO_LAND,
      GREENLIGHT_STATUS_AI_REVIEW_STARTED,
      GREENLIGHT_STATUS_CANCELLED,
      GREENLIGHT_STATUS_REVERTED,
    ]) {
      expect(isGreenlightApproved(status)).toBe(false);
    }
  });

  test("absent, empty and unknown statuses are not approved", () => {
    expect(isGreenlightApproved(undefined)).toBe(false);
    expect(isGreenlightApproved(null)).toBe(false);
    expect(isGreenlightApproved("")).toBe(false);
    expect(isGreenlightApproved("SOMETHING_NEW")).toBe(false);
  });

  test("tolerates the surrounding whitespace a ClickHouse String can carry", () => {
    expect(isGreenlightApproved(` ${GREENLIGHT_STATUS_LAND} `)).toBe(true);
  });
});

describe("supersedes", () => {
  test("a higher run_id wins even with an older version", () => {
    const newer = { run_id: 9, version: "2026-01-01 00:00:00.000" };
    const older = { run_id: 8, version: "2026-09-01 00:00:00.000" };
    expect(supersedes(newer, older)).toBe(true);
    expect(supersedes(older, newer)).toBe(false);
  });

  test("version breaks a run_id tie", () => {
    const later = { run_id: 9, version: "2026-09-02 00:00:00.000" };
    const earlier = { run_id: 9, version: "2026-09-01 00:00:00.000" };
    expect(supersedes(later, earlier)).toBe(true);
    expect(supersedes(earlier, later)).toBe(false);
  });

  test("a row does not supersede itself", () => {
    const only = { run_id: 9, version: "2026-09-01 00:00:00.000" };
    expect(supersedes(only, only)).toBe(false);
  });
});

describe("buildStatusByPr", () => {
  test("keys each PR's status by pr_number", () => {
    const byPr = buildStatusByPr([
      row({ pr_number: 10, status: GREENLIGHT_STATUS_LAND }),
      row({ pr_number: 11, status: GREENLIGHT_STATUS_NO_LAND }),
    ]);
    expect(byPr.get(10)).toBe(GREENLIGHT_STATUS_LAND);
    expect(byPr.get(11)).toBe(GREENLIGHT_STATUS_NO_LAND);
  });

  test("keeps the authoritative row when a PR somehow has several", () => {
    // The saved query already collapses these; the guard matters because
    // picking the wrong one shows an approval a later review revoked.
    const byPr = buildStatusByPr([
      row({ pr_number: 10, status: GREENLIGHT_STATUS_LAND, run_id: 5 }),
      row({ pr_number: 10, status: GREENLIGHT_STATUS_NO_LAND, run_id: 6 }),
    ]);
    expect(byPr.get(10)).toBe(GREENLIGHT_STATUS_NO_LAND);
  });

  test("order of arrival does not decide the winner", () => {
    const byPr = buildStatusByPr([
      row({ pr_number: 10, status: GREENLIGHT_STATUS_NO_LAND, run_id: 6 }),
      row({ pr_number: 10, status: GREENLIGHT_STATUS_LAND, run_id: 5 }),
    ]);
    expect(byPr.get(10)).toBe(GREENLIGHT_STATUS_NO_LAND);
  });

  test("drops rows with no usable PR number", () => {
    const byPr = buildStatusByPr([
      row({ pr_number: 0 }),
      row({ pr_number: -1 }),
      row({ pr_number: NaN }),
    ]);
    expect(byPr.size).toBe(0);
  });

  test("undefined and empty input give an empty map", () => {
    expect(buildStatusByPr(undefined).size).toBe(0);
    expect(buildStatusByPr([]).size).toBe(0);
  });
});
