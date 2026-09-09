import {
  buildStateBySha,
  buildStatusByTrunkSha,
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
    merge_commit_sha: "",
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

describe("buildStatusByTrunkSha", () => {
  const TRUNK_A = "1".repeat(40);
  const TRUNK_B = "2".repeat(40);

  test("keys each commit's status by its own trunk sha", () => {
    const bySha = buildStatusByTrunkSha([
      { sha: TRUNK_A, status: GREENLIGHT_STATUS_LAND },
      { sha: TRUNK_B, status: GREENLIGHT_STATUS_NO_LAND },
    ]);
    expect(bySha.get(TRUNK_A)).toBe(GREENLIGHT_STATUS_LAND);
    expect(bySha.get(TRUNK_B)).toBe(GREENLIGHT_STATUS_NO_LAND);
  });

  test("two landings of one PR keep their own verdicts", () => {
    // The regression this whole keying exists for: a PR that lands, is
    // reverted, is changed and lands again. Keyed by PR, both commits would
    // take the later verdict and the first would carry an approval that was
    // never about it.
    const bySha = buildStatusByTrunkSha([
      { sha: TRUNK_A, status: GREENLIGHT_STATUS_NO_LAND },
      { sha: TRUNK_B, status: GREENLIGHT_STATUS_LAND },
    ]);
    expect(bySha.get(TRUNK_A)).toBe(GREENLIGHT_STATUS_NO_LAND);
    expect(bySha.get(TRUNK_B)).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("lookups are case-insensitive on the sha", () => {
    const bySha = buildStatusByTrunkSha([
      { sha: TRUNK_A.toUpperCase(), status: GREENLIGHT_STATUS_LAND },
    ]);
    expect(bySha.get(TRUNK_A)).toBe(GREENLIGHT_STATUS_LAND);
  });

  test("drops rows with no sha", () => {
    expect(
      buildStatusByTrunkSha([
        { sha: "", status: GREENLIGHT_STATUS_LAND },
        { sha: "   ", status: GREENLIGHT_STATUS_LAND },
      ]).size
    ).toBe(0);
  });

  test("undefined and empty input give an empty map", () => {
    expect(buildStatusByTrunkSha(undefined).size).toBe(0);
    expect(buildStatusByTrunkSha([]).size).toBe(0);
  });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const TRUNK_A = "d".repeat(40);

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

describe("selectStateForSha", () => {
  const rows = [
    row({
      head_sha: SHA_A,
      merge_commit_sha: TRUNK_A,
      status: GREENLIGHT_STATUS_LAND,
    }),
    row({
      head_sha: SHA_B,
      merge_commit_sha: "",
      status: GREENLIGHT_STATUS_NO_LAND,
    }),
  ];

  test("matches a reviewed head, which is what the PR picker selects", () => {
    expect(selectStateForSha(rows, SHA_A)).toEqual(rows[0]);
    expect(selectStateForSha(rows, SHA_B)).toEqual(rows[1]);
  });

  test("matches the trunk commit that reviewed head landed as", () => {
    // Mergebot rebases, so a commit page never sees the reviewed sha.
    expect(selectStateForSha(rows, TRUNK_A)).toEqual(rows[0]);
  });

  test("a commit that was never reviewed gets nothing, not the PR verdict", () => {
    // Most picker entries are ordinary commits that were never a review head;
    // showing them another commit's approval would say something untrue.
    expect(selectStateForSha(rows, SHA_C)).toBeUndefined();
  });

  test("an unrelated sha gets nothing, so a forged PR reference resolves to nothing", () => {
    expect(selectStateForSha(rows, "f".repeat(40))).toBeUndefined();
  });

  test("never matches on an empty merge_commit_sha", () => {
    expect(selectStateForSha(rows, "")).toBeUndefined();
    expect(selectStateForSha(rows, undefined)).toBeUndefined();
  });

  test("matching is case-insensitive on both shas", () => {
    expect(selectStateForSha(rows, SHA_A.toUpperCase())).toEqual(rows[0]);
    expect(selectStateForSha(rows, TRUNK_A.toUpperCase())).toEqual(rows[0]);
  });

  test("undefined when the PR has no recorded state at all", () => {
    expect(selectStateForSha(undefined, SHA_A)).toBeUndefined();
    expect(selectStateForSha([], SHA_A)).toBeUndefined();
  });
});
