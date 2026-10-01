// Pins what the three GreenLight Quality queries that return bucket rows share:
// one spine of bucket starts, written once and copied verbatim, that falls back
// to the single whole-window row on an empty window, and a granularity parameter
// the page's bucket sizes and the tiles' whole-window row both reach.
//
// lib/GeneralUtils is mocked because it carries octokit, which does not load
// under this jest environment; with it gone the real query catalog can be read.

import { QUALITY_CHARTS } from "components/greenlight/quality/chartConfigs";
import {
  CHART_GRANULARITY_OPTIONS,
  defaultGranularity,
} from "lib/greenlight/qualityCharts";
import { QUALITY_QUERIES } from "lib/greenlight/qualityQuery";
import {
  queryParamsJson,
  sqlCode,
} from "./greenlightQualityColumnSync.helpers";

jest.mock("lib/GeneralUtils", () => ({ fetcher: jest.fn() }));

const GRANULARITIES = CHART_GRANULARITY_OPTIONS.map((option) => option.value);

// The queries a chart reads bucket rows from.
const BUCKETED = Array.from(
  new Set(
    Object.values(QUALITY_CHARTS).flatMap((chart) =>
      chart.source.query === "reverts"
        ? []
        : [QUALITY_QUERIES[chart.source.query]]
    )
  )
).sort();

// Each `arrayJoin(...) AS alias` in a query's code whose array comes from
// range(): the spine of bucket starts. Parentheses are matched outside string
// literals, since the block holds several.
function spineBlocks(query: string): string[] {
  const code = sqlCode(query);
  const blocks: string[] = [];
  for (const match of Array.from(code.matchAll(/arrayJoin\(/g))) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let quoted = false;
    let close = -1;
    for (let i = open; i < code.length && close === -1; i++) {
      if (code[i] === "'") {
        quoted = !quoted;
      } else if (!quoted && code[i] === "(") {
        depth += 1;
      } else if (!quoted && code[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
        }
      }
    }
    const alias = code.slice(close + 1).match(/^\s*AS\s+\w+/);
    const block = code.slice(match.index, close + 1) + (alias?.[0] ?? "");
    if (close !== -1 && block.includes("range(")) {
      blocks.push(block);
    }
  }
  return blocks;
}

// sqlfluff lays a block out by its own line width, so only the tokens count.
function normalised(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\(\s/g, "(")
    .replace(/\s\)/g, ")")
    .trim();
}

describe("the bucket spine", () => {
  test("three queries return bucket rows", () => {
    expect(BUCKETED).toEqual(
      [
        QUALITY_QUERIES.coverage,
        QUALITY_QUERIES.latency,
        QUALITY_QUERIES.mergeAuthority,
      ].sort()
    );
  });

  test.each(BUCKETED)("%s builds exactly one spine", (query) => {
    expect(spineBlocks(query)).toHaveLength(1);
  });

  test("the three spines are one text, whitespace aside", () => {
    const texts = BUCKETED.map((query) => normalised(spineBlocks(query)[0]));
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });

  // Without the guard, an empty window at day or week asks range() for no
  // buckets, or a start past 2106 wraps toUInt32 into thousands of them.
  test.each(BUCKETED)(
    "%s falls back to the single window row unless the window is non-empty",
    (query) => {
      const spine = normalised(spineBlocks(query)[0]);
      expect(spine).toContain(
        "if(granularity IN ('day', 'week') AND window_end > window_start,"
      );
      expect(spine).toMatch(/\[window_start\]\)\) AS bucket$/);
    }
  );
});

// The page keys a week by its ISO week, which starts on Monday, so a query's
// week bucket must start on Monday too. ClickHouse's toStartOfWeek starts on a
// Sunday unless told otherwise.
test.each(BUCKETED)("%s starts its week buckets on Monday", (query) => {
  const code = normalised(sqlCode(query));
  const weekStarts = Array.from(
    code.matchAll(/granularity = 'week', (\w+)\(/g),
    (m) => m[1]
  );
  expect(weekStarts.length).toBeGreaterThan(0);
  expect(new Set(weekStarts)).toEqual(new Set(["toMonday"]));
  expect(code).toContain(
    "if(granularity = 'day', toStartOfDay(window_start), toMonday(window_start))"
  );
  expect(code).not.toMatch(/toStartOfWeek|dateTrunc/);
});

describe("the granularity parameter", () => {
  // The tiles send no granularity, so their queries run on params.json's
  // default, and each tile reads the first row back: a default of day or week
  // would put the first bucket's figures on every tile. The tests entries reach
  // ClickHouse without that default fill, so each has to name its own.
  test.each(BUCKETED)(
    "%s declares granularity, defaults it to the tiles' whole-window row, and tests every size",
    (query) => {
      const { params, defaults, tests } = queryParamsJson(query);
      expect(params.granularity).toBe("String");
      expect(defaults.granularity).toBe("window");
      expect(
        tests
          .map((entry) => entry.granularity)
          .filter((g) => !["window", ...GRANULARITIES].includes(g))
      ).toEqual([]);
      expect(new Set(tests.map((entry) => entry.granularity))).toEqual(
        new Set(["window", ...GRANULARITIES])
      );
    }
  );

  // Any value a query does not branch on takes the whole-window row, so a
  // bucket size the page sends that the SQL does not know plots one point and
  // fails nowhere.
  test.each(BUCKETED)(
    "%s branches on every bucket size the page can send",
    (query) => {
      expect(
        Array.from(new Set([1, 90, 91, 365].map(defaultGranularity))).sort()
      ).toEqual([...GRANULARITIES].sort());
      const branched = new Set(
        Array.from(
          sqlCode(query).matchAll(/granularity\s*=\s*'(\w+)'/g),
          (m) => m[1]
        )
      );
      expect(GRANULARITIES.filter((g) => !branched.has(g))).toEqual([]);
    }
  );
});
