// Pins which reverts the GreenLight Quality page lists and counts: the reverts
// carrying a GreenLight LAND that the table lists, the stale ones it leaves out,
// the staleness note the tile and the table share, and the exclusion lines on
// the tile's face.
//
// merged_version_approved is 'no' when mergebot's record of the merged head
// differs from the head the verdict shown was issued on, and 'unknown' when the
// verdict was not LAND, no merged head was found, or only the branch history
// shows a different one. Only 'no' is stale.

import { intFormatter } from "components/common/numberFormat";
import {
  exclusionLine,
  revertRateSub,
} from "components/greenlight/quality/tileConfigs";
import {
  approvedRevertRows,
  finiteNumber,
  RevertStats,
  revertStats,
  stalenessCounts,
  staleVerdictNote,
  staleVerdictNoteOf,
} from "lib/greenlight/qualityFigures";
import { ANCHOR, revert, shas, withTotals } from "./greenlightQuality.helpers";
import {
  emittedColumns,
  outputName,
  querySql,
  selectBody,
  sqlCode,
  topLevelItems,
} from "./greenlightQualityColumnSync.helpers";

const REVERTS_QUERY = "greenlight_quality_reverts";

const CONFIRMED = revert("confirmed", "LAND", "yes");
const UNVERIFIED = revert("unverified", "LAND", "unknown", "");
const GHFIRST_CURRENT = revert("ghfirst-current", "LAND", "yes", "ghfirst");
const GHFIRST_UNVERIFIED = revert(
  "ghfirst-unverified",
  "LAND",
  "unknown",
  "ghfirst"
);
const STALE = revert("stale", "LAND", "no");
const STALE_GHFIRST = revert("stale-ghfirst", "LAND", "no", "ghfirst");
const NO_LAND_REVERT = revert("no-land", "NO_LAND", "unknown");
const UNEVALUATED = revert("unevaluated", "", "unknown", "");

const MIXED = [
  ANCHOR,
  CONFIRMED,
  UNVERIFIED,
  GHFIRST_CURRENT,
  GHFIRST_UNVERIFIED,
  STALE,
  STALE_GHFIRST,
  NO_LAND_REVERT,
  UNEVALUATED,
];

describe("approvedRevertRows", () => {
  test("lists every revert of a current approved version, unverified and ghfirst ones too", () => {
    expect(shas(approvedRevertRows(MIXED))).toEqual(
      shas([CONFIRMED, UNVERIFIED, GHFIRST_CURRENT, GHFIRST_UNVERIFIED])
    );
  });

  test.each([
    ["the anchor row", ANCHOR],
    ["a stale revert", STALE],
    ["a stale ghfirst revert", STALE_GHFIRST],
    ["a NO_LAND revert", NO_LAND_REVERT],
    ["a revert GreenLight never evaluated", UNEVALUATED],
  ])("never lists %s", (_case, row) => {
    expect(approvedRevertRows([row])).toEqual([]);
  });

  // The rate's numerator is defined once, as the per-row flag the reverts chart
  // buckets, so the chart and the tile cannot count different reverts.
  test("the rate counts exactly the rows the query flags", () => {
    const numerator = topLevelItems(
      selectBody(querySql(REVERTS_QUERY), REVERTS_QUERY)
    ).find((item) => outputName(item) === "land_approved_reverts");
    expect(numerator?.replace(/\s+/g, " ")).toBe(
      "sum(counts_in_rate) OVER () AS land_approved_reverts"
    );
  });

  // The query flags the reverts the rate counts; a table that dropped one of
  // them would leave the rate counting a revert nobody can see.
  test("lists every revert the rate counts", () => {
    const counted = shas(MIXED.filter((row) => row.counts_in_rate === 1));
    expect(counted).toEqual(shas([CONFIRMED, UNVERIFIED]));
    expect(shas(approvedRevertRows(MIXED))).toEqual(
      expect.arrayContaining(counted)
    );
  });
});

// Stale drops a revert from both the rate and the table, so it takes mergebot's
// own record of the head that merged. A different head that only the branch
// history shows reads 'unknown', and the revert stays counted.
describe("when the query calls a merged version stale", () => {
  const whitespace = (text: string) => text.replace(/\s+/g, " ").trim();

  test("'no' is left only once mergebot's recorded head has been found and differs", () => {
    const projection =
      topLevelItems(selectBody(querySql(REVERTS_QUERY), REVERTS_QUERY)).find(
        (item) => outputName(item) === "merged_version_approved"
      ) ?? "";
    const call = whitespace(
      projection.replace(/\bAS\s+merged_version_approved\s*$/, "")
    );
    expect(call).toMatch(/^multiIf\(.*\)$/);
    const args = topLevelItems(call.slice("multiIf(".length, -1)).map(
      whitespace
    );
    const results = args.filter((_, i) => i % 2 === 1 || i === args.length - 1);
    expect(results.filter((result) => result === "'no'")).toEqual(["'no'"]);
    expect(args.slice(-3)).toEqual([
      expect.stringMatching(/^(\w+\.)?recorded_head = ''$/),
      "'unknown'",
      "'no'",
    ]);
  });

  // The body of `name AS (...)` in the query's code, parentheses matched.
  function cte(code: string, name: string): string {
    const open = code.indexOf(`${name} AS (`) + `${name} AS `.length;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      depth += code[i] === "(" ? 1 : code[i] === ")" ? -1 : 0;
      if (depth === 0) {
        return code.slice(open, i + 1);
      }
    }
    return "";
  }

  test("the recorded head is mergebot's, and stays inside the query", () => {
    const code = whitespace(sqlCode(REVERTS_QUERY));
    expect(code).toContain("any(mh.head_sha) AS recorded_head");
    expect(code).toContain("LEFT JOIN merge_heads AS mh");
    expect(cte(code, "merge_heads")).toMatch(/\bFROM default\.merges\b/);
    expect(emittedColumns(REVERTS_QUERY).has("recorded_head")).toBe(false);
  });
});

describe("the staleness counts and note", () => {
  test("count every revert carrying a GreenLight LAND, the stale ones the table drops included", () => {
    expect(stalenessCounts(MIXED)).toMatchObject({ total: 6, stale: 2 });
  });

  test("the listed rows and the stale ones make up those reverts, each once", () => {
    const { total, stale } = stalenessCounts(MIXED);
    expect(approvedRevertRows(MIXED).length + stale).toBe(total);
  });

  const lead = staleVerdictNote([]).replace(/\.$/, "");

  test("the note states how many of them were excluded as stale", () => {
    expect(staleVerdictNote(MIXED)).toBe(
      `${lead}: ${intFormatter(2)} of ${intFormatter(
        6
      )} reverts carrying a GreenLight LAND here.`
    );
  });

  test("with no such revert the note states the limitation alone", () => {
    expect(staleVerdictNote([ANCHOR, NO_LAND_REVERT, UNEVALUATED])).toBe(
      `${lead}.`
    );
  });

  test("an unverified revert counts toward the total and never as stale", () => {
    expect(staleVerdictNote([UNVERIFIED])).toBe(
      `${lead}: ${intFormatter(0)} of ${intFormatter(
        1
      )} reverts carrying a GreenLight LAND here.`
    );
  });

  // The table builds the note from counts it already holds; the tile, from the
  // rows. Both have to say the same.
  test("the note from the counts is the note from the rows", () => {
    for (const rows of [MIXED, [ANCHOR], [STALE], [UNVERIFIED, STALE]]) {
      expect(staleVerdictNoteOf(stalenessCounts(rows))).toBe(
        staleVerdictNote(rows)
      );
    }
  });
});

describe("finiteNumber", () => {
  test.each([
    [0, 0],
    [3, 3],
    ["3", 3],
    ["2.5", 2.5],
  ])("reads %p as %p", (value, expected) => {
    expect(finiteNumber(value)).toBe(expected);
  });

  test.each([null, undefined, "abc", NaN, Infinity, -Infinity])(
    "reads %p as unknown, never as zero",
    (value) => {
      expect(finiteNumber(value)).toBeUndefined();
    }
  );
});

describe("the tile's exclusion lines", () => {
  test("the stale count is read from the window total the query reports", () => {
    const rows = withTotals([ANCHOR], { land_approved_stale_reverts: 3 });
    expect(revertStats(rows).landApprovedStale).toBe(3);
  });

  test("a total the query does not report is unknown, not zero", () => {
    expect(revertStats([ANCHOR]).landApprovedStale).toBeUndefined();
    expect(revertStats([]).landApprovedStale).toBeUndefined();
  });

  test.each([
    [0, ""],
    [undefined, ""],
    [1, "1 excluded as stale"],
    [12345, `${intFormatter(12345)} excluded as stale`],
  ])("a count of %p reads %p", (count, line) => {
    expect(exclusionLine(count, "stale")).toBe(line);
  });

  const stats = (overrides: Partial<RevertStats>): RevertStats => ({
    landApproved: 0,
    evaluatedPrs: 40,
    ...overrides,
  });

  test("ghfirst comes first, then stale", () => {
    expect(
      revertRateSub(stats({ landApprovedGhfirst: 2, landApprovedStale: 1 }))
    ).toEqual({
      count: "0",
      rest: " / 40 PRs",
      exclusions: ["2 excluded as ghfirst", "1 excluded as stale"],
    });
  });

  test("an exclusion that removed nothing is left off", () => {
    expect(revertRateSub(stats({ landApprovedStale: 1 })).exclusions).toEqual([
      "1 excluded as stale",
    ]);
    expect(
      revertRateSub(stats({ landApprovedGhfirst: 0, landApprovedStale: 0 }))
        .exclusions
    ).toEqual([]);
  });

  test("with no approved revert removed as ghfirst, the line names every ghfirst revert", () => {
    expect(
      revertRateSub(stats({ landApprovedGhfirst: 0, ghfirst: 5 })).exclusions
    ).toEqual(["5 excluded as ghfirst"]);
  });

  test("the lines read the query's own totals", () => {
    const rows = withTotals(MIXED, {
      land_approved_reverts: 2,
      land_approved_ghfirst_reverts: 2,
      land_approved_stale_reverts: 2,
      ghfirst_reverts: 3,
    });
    expect(revertRateSub(revertStats(rows))).toEqual({
      count: "2",
      rest: " / 40 PRs",
      exclusions: ["2 excluded as ghfirst", "2 excluded as stale"],
    });
  });
});
