import {
  authoritativeState,
  buildStateBySha,
  buildStatusByPr,
  GreenlightPrStateRow,
  isGreenlightApproved,
  normalizeSha,
  selectStateForSha,
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

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("normalizeSha", () => {
  test("folds case and trims, and maps absent input to empty", () => {
    expect(normalizeSha(`  ${SHA_A.toUpperCase()} `)).toBe(SHA_A);
    expect(normalizeSha(undefined)).toBe("");
    expect(normalizeSha(null)).toBe("");
  });
});

describe("buildStateBySha", () => {
  test("keys each reviewed commit's row by its head sha", () => {
    const bySha = buildStateBySha([
      row({ head_sha: SHA_A, status: GREENLIGHT_STATUS_NO_LAND }),
      row({ head_sha: SHA_B, status: GREENLIGHT_STATUS_LAND }),
    ]);
    expect(bySha.get(SHA_A)?.status).toBe(GREENLIGHT_STATUS_NO_LAND);
    expect(bySha.get(SHA_B)?.status).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("a sha reviewed twice keeps the later run", () => {
    const bySha = buildStateBySha([
      row({ head_sha: SHA_A, status: GREENLIGHT_STATUS_NO_LAND, run_id: 4 }),
      row({ head_sha: SHA_A, status: GREENLIGHT_STATUS_LAND, run_id: 7 }),
    ]);
    expect(bySha.get(SHA_A)?.status).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("lookups are case-insensitive on the sha", () => {
    const bySha = buildStateBySha([row({ head_sha: SHA_A.toUpperCase() })]);
    expect(bySha.get(SHA_A)).toBeDefined();
  });

  test("drops rows with no head sha", () => {
    expect(buildStateBySha([row({ head_sha: "" })]).size).toBe(0);
    expect(buildStateBySha([row({ head_sha: "   " })]).size).toBe(0);
  });
});

describe("authoritativeState", () => {
  test("picks the highest run_id across commits, not the latest version", () => {
    const best = authoritativeState([
      row({
        head_sha: SHA_A,
        run_id: 9,
        version: "2026-01-01 00:00:00.000",
        status: GREENLIGHT_STATUS_LAND,
      }),
      row({
        head_sha: SHA_B,
        run_id: 8,
        version: "2026-09-01 00:00:00.000",
        status: GREENLIGHT_STATUS_NO_LAND,
      }),
    ]);
    expect(best?.status).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("undefined when the PR has no recorded state", () => {
    expect(authoritativeState(undefined)).toBeUndefined();
    expect(authoritativeState([])).toBeUndefined();
  });
});

describe("selectStateForSha", () => {
  const rows = [
    row({ head_sha: SHA_A, status: GREENLIGHT_STATUS_NO_LAND, run_id: 4 }),
    row({ head_sha: SHA_B, status: GREENLIGHT_STATUS_LAND, run_id: 7 }),
  ];

  test("a reviewed commit gets its own verdict, flagged as such", () => {
    expect(selectStateForSha(rows, SHA_A)).toEqual({
      state: rows[0],
      isForThisSha: true,
    });
  });

  test("an unreviewed commit falls back to the PR's authoritative verdict", () => {
    // The trunk case: pytorch rebases on merge, so a landed commit's sha is
    // never a sha GreenLight reviewed.
    expect(selectStateForSha(rows, SHA_C)).toEqual({
      state: rows[1],
      isForThisSha: false,
    });
  });

  test("the fallback is never the newest row by version alone", () => {
    const raced = [
      row({
        head_sha: SHA_A,
        run_id: 9,
        version: "2026-01-01 00:00:00.000",
        status: GREENLIGHT_STATUS_LAND,
      }),
      row({
        head_sha: SHA_B,
        run_id: 8,
        version: "2026-09-01 00:00:00.000",
        status: GREENLIGHT_STATUS_NO_LAND,
      }),
    ];
    expect(selectStateForSha(raced, SHA_C)?.state.status).toBe(
      GREENLIGHT_STATUS_LAND
    );
  });

  test("undefined when the PR has no recorded state at all", () => {
    expect(selectStateForSha(undefined, SHA_A)).toBeUndefined();
    expect(selectStateForSha([], SHA_A)).toBeUndefined();
  });

  test("an absent sha still yields the PR's authoritative verdict", () => {
    expect(selectStateForSha(rows, undefined)).toEqual({
      state: rows[1],
      isForThisSha: false,
    });
  });
});
