// Pins the chart definitions in components/greenlight/quality/chartConfigs
// against the tiles they expand: titles, the columns each series reads, which
// verdict each colour paints, the tooltip lines, and the toggle wiring.
//
// lib/GeneralUtils is mocked because it carries octokit, which does not load
// under this jest environment; with it gone the real query catalog can be read.

import { intFormatter } from "components/common/numberFormat";
import {
  chartElementId,
  chartKeyOfTile,
  chartToggle,
  countedRevertsMessage,
  QUALITY_CHART_ORDER,
  QUALITY_CHARTS,
  QualityChartKey,
  revertTotalsNote,
} from "components/greenlight/quality/chartConfigs";
import {
  COVERAGE_TILES,
  LATENCY_TILES,
  MERGE_AUTHORITY_LABEL,
  mergeAuthorityShares,
  noVerdictCount,
  noVerdictGap,
  REVERT_RATE_LABEL,
  REVIEW_RUN_TILES,
  reviewRunFraction,
} from "components/greenlight/quality/tileConfigs";
import {
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
} from "lib/greenlight/greenlightRender";
import { bucketValue, bucketValueText } from "lib/greenlight/qualityCharts";
import { QUALITY_QUERIES } from "lib/greenlight/qualityQuery";
import { tileKeyed } from "./greenlightQuality.helpers";
import { emittedColumns } from "./greenlightQualityColumnSync.helpers";

jest.mock("lib/GeneralUtils", () => ({ fetcher: jest.fn() }));

const CONFIG_TILES = [...COVERAGE_TILES, ...LATENCY_TILES, ...REVIEW_RUN_TILES];

// Every property a read takes off a row, whatever it then does with it.
function fieldsRead(read: (_row: any) => unknown): string[] {
  const seen = new Set<string>();
  read(
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (typeof property === "string") {
            seen.add(property);
          }
          return 1;
        },
      }
    )
  );
  return Array.from(seen);
}

describe("chart definitions", () => {
  test("every chart has an element id of its own", () => {
    const ids = QUALITY_CHART_ORDER.map(chartElementId);
    expect(new Set(ids).size).toBe(QUALITY_CHART_ORDER.length);
    expect(ids.filter((id) => !/^[A-Za-z][\w-]*$/.test(id))).toEqual([]);
    expect(new Set(QUALITY_CHART_ORDER)).toEqual(
      new Set(Object.keys(QUALITY_CHARTS))
    );
  });

  test("each chart is titled with the label of the tile that opens it", () => {
    expect(
      Object.fromEntries(
        QUALITY_CHART_ORDER.map((key) => [key, QUALITY_CHARTS[key].title])
      )
    ).toEqual({
      ...Object.fromEntries(
        CONFIG_TILES.map((tile) => [chartKeyOfTile(tile.key), tile.label])
      ),
      mergedGlAlone: MERGE_AUTHORITY_LABEL,
      approvedReverts: REVERT_RATE_LABEL,
    });
  });

  test.each([
    ["prsEvaluated", "prs_evaluated"],
    ["verdicts", "verdicts_total"],
  ] as const)(
    "%s paints each verdict from that verdict's own column",
    (key, tileKey) => {
      const tile = tileKeyed(COVERAGE_TILES, tileKey);
      const named = (name: string) =>
        QUALITY_CHARTS[key].series.find((series) => series.name === name);
      expect(named(GREENLIGHT_STATUS_LAND)).toMatchObject({
        color: "land",
        value: { kind: "count", countField: tile.landField },
      });
      expect(named(GREENLIGHT_STATUS_NO_LAND)).toMatchObject({
        color: "fault",
        value: { kind: "count", countField: tile.noLandField },
      });
    }
  );

  test("the PR bars stack to the bucket's PR total, the gap being the tile's own", () => {
    const row = {
      prs_evaluated: 10,
      prs_with_verdict: 7,
      prs_land: 4,
      prs_no_land: 3,
    };
    const values = QUALITY_CHARTS.prsEvaluated.series.map(
      (series) => bucketValue(series.value, row) ?? 0
    );
    expect(values.reduce((sum, n) => sum + n, 0)).toBe(row.prs_evaluated);
    expect(values[2]).toBe(noVerdictCount(row));
    expect(noVerdictGap(row)).toBe(`${intFormatter(values[2])} no verdict`);
  });

  test.each([
    ["endToEnd", "end_to_end"],
    ["firstFeedback", "first_feedback"],
  ] as const)("%s plots its own tile's clock", (key, tileKey) => {
    const tile = tileKeyed(LATENCY_TILES, tileKey);
    expect(QUALITY_CHARTS[key].series.map((series) => series.value)).toEqual([
      {
        kind: "share",
        countField: tile.withinField,
        denominatorField: tile.nField,
      },
      { kind: "p50Minutes", secondsField: tile.p50Field, nField: tile.nField },
    ]);
  });

  test.each([
    ["runsFailed", "runs_failed"],
    ["runsOverRuntime", "runs_over_runtime"],
  ] as const)(
    "%s plots its own tile's fraction, and states it as the tile does",
    (key, tileKey) => {
      const tile = tileKeyed(REVIEW_RUN_TILES, tileKey);
      const chart = QUALITY_CHARTS[key];
      expect(chart.series.map((series) => series.value)).toEqual([
        { kind: "count", countField: tile.countField },
        {
          kind: "share",
          countField: tile.countField,
          denominatorField: tile.nField,
        },
      ]);
      const row = {
        [tile.countField]: 3,
        [tile.nField]: 1234,
        review_runtime_cutoff_s: 1980,
      };
      const fraction = reviewRunFraction(tile, row);
      expect(chart.details(row)).toEqual([
        `${fraction.count}${fraction.rest}`,
        tile.subNote?.(row),
      ]);
    }
  );

  test("the merge chart gives each share the colour the tile gives it", () => {
    const row = {
      gl_only: 3,
      merged_evaluated_prs: 24,
      merged_prs_total: 140,
      pct_gl_only: 12.5,
      pct_of_all_merges: 2.14,
    };
    const shares = mergeAuthorityShares(row);
    expect(
      QUALITY_CHARTS.mergedGlAlone.series.map((series) => ({
        color: series.color,
        text: bucketValueText(
          series.value,
          row,
          bucketValue(series.value, row)
        ),
      }))
    ).toEqual([
      { color: "neutral", text: intFormatter(row.gl_only) },
      { color: "firstFigure", text: shares.evaluated.pct },
      { color: "secondFigure", text: shares.allMerges.pct },
    ]);
    expect(QUALITY_CHARTS.mergedGlAlone.details(row)).toEqual([
      shares.evaluated.fraction,
      shares.allMerges.fraction,
    ]);
  });

  // The two green figures a tile carries are too close to tell apart as lines
  // in light mode, so the second line drawn takes a hue of its own; the first
  // keeps its tile colour, which is what pairs the chart with its tile.
  test("of each pair of lines, only the second leaves the tile's colour", () => {
    const lines = (key: QualityChartKey) =>
      QUALITY_CHARTS[key].series
        .filter((series) => series.value.kind !== "count")
        .map((series) => series.lightHue === true);
    expect(lines("endToEnd")).toEqual([false, true]);
    expect(lines("firstFeedback")).toEqual([false, true]);
    expect(lines("mergedGlAlone")).toEqual([false, true]);
  });

  test("a bucket's count of one PR or verdict is singular", () => {
    expect(QUALITY_CHARTS.prsEvaluated.details({ prs_evaluated: 1 })).toEqual([
      "1 PR",
    ]);
    expect(QUALITY_CHARTS.prsEvaluated.details({ prs_evaluated: 2 })).toEqual([
      "2 PRs",
    ]);
    expect(QUALITY_CHARTS.verdicts.details({ verdicts_total: 1 })).toEqual([
      "1 verdict",
    ]);
    expect(QUALITY_CHARTS.verdicts.details({ verdicts_total: 12345 })).toEqual([
      `${intFormatter(12345)} verdicts`,
    ]);
  });

  // The reads check in greenlightQualityColumnSync tests against the union of
  // every query's columns, so it passes a chart reading another query's column
  // off its own rows, which then plots a flat line of nothing.
  test("each chart reads only columns its own query emits", () => {
    const foreign = QUALITY_CHART_ORDER.flatMap((key) => {
      const chart = QUALITY_CHARTS[key];
      if (chart.source.query === "reverts") {
        return [];
      }
      const query = QUALITY_QUERIES[chart.source.query];
      const emitted = emittedColumns(query);
      const read = new Set([
        chart.source.bucketField,
        ...chart.series.flatMap((series) => [
          ...fieldsRead((row) => bucketValue(series.value, row)),
          ...fieldsRead((row) => bucketValueText(series.value, row, 1)),
        ]),
        ...fieldsRead((row) => chart.details(row)),
      ]);
      return Array.from(read)
        .filter((field) => !emitted.has(field))
        .map((field) => `${key} reads ${field}, which ${query} does not emit`);
    });
    expect(foreign).toEqual([]);
  });

  test("every config-driven tile opens a chart, and an unknown tile none", () => {
    expect(
      CONFIG_TILES.map((tile) => tile.key).filter((key) => !chartKeyOfTile(key))
    ).toEqual([]);
    expect(chartKeyOfTile("no_such_tile")).toBeUndefined();
  });
});

describe("chartToggle", () => {
  test("a tile without a chart gets no toggle", () => {
    expect(
      chartToggle(undefined, {
        openCharts: new Set<QualityChartKey>(["verdicts"]),
        onToggleChart: jest.fn(),
      })
    ).toEqual({});
  });

  test("a tile's toggle reports its chart's state and flips that chart alone", () => {
    const onToggleChart = jest.fn();
    expect(
      chartToggle("verdicts", {
        openCharts: new Set<QualityChartKey>(["endToEnd"]),
        onToggleChart,
      })
    ).toMatchObject({
      selected: false,
      controlsId: chartElementId("verdicts"),
    });
    const open = chartToggle("verdicts", {
      openCharts: new Set<QualityChartKey>(["verdicts"]),
      onToggleChart,
    });
    expect(open).toMatchObject({
      selected: true,
      controlsId: chartElementId("verdicts"),
    });
    open.onToggle?.();
    expect(onToggleChart.mock.calls).toEqual([["verdicts"]]);
  });
});

describe("the revert chart's notes", () => {
  test("say nothing while the bars hold every revert the tile counts", () => {
    expect(revertTotalsNote(3, 3)).toBeUndefined();
    expect(revertTotalsNote(0, 0)).toBeUndefined();
    expect(revertTotalsNote(2, undefined)).toBeUndefined();
  });

  test("name both counts when the capped rows fall short of the tile", () => {
    expect(revertTotalsNote(4999, 5210)).toBe(
      `These bars hold ${intFormatter(4999)} of the ${intFormatter(
        5210
      )} reverts the tile counts.`
    );
  });

  test("an empty chart names what the tile's exclusion lines removed", () => {
    expect(
      countedRevertsMessage(["2 excluded as ghfirst", "1 excluded as stale"])
    ).toBe(
      "No counted reverts in this window: 2 excluded as ghfirst, 1 excluded as stale."
    );
    expect(countedRevertsMessage([])).toBe(
      "No counted reverts in this window."
    );
  });
});
