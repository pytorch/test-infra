// Pins the ECharts option components/greenlight/quality/chartOptions builds for
// each GreenLight Quality trend chart: the shared grid, the y-axes the series
// need, the band marking partial buckets and how a rebuilt option merges, the
// colours drawn against the Paper in both of the app's themes, the tooltip and
// the description a screen reader gets.

import {
  alpha,
  getContrastRatio,
  getOverlayAlpha,
  lighten,
} from "@mui/material/styles";
import {
  QUALITY_CHART_ORDER,
  QUALITY_CHARTS,
  QualityChartConfig,
  QualityChartKey,
} from "components/greenlight/quality/chartConfigs";
import {
  CHART_PAPER_ELEVATION,
  chartOption,
} from "components/greenlight/quality/chartOptions";
import { qualityColors } from "components/greenlight/quality/tileColors";
import * as echarts from "echarts";
import {
  bucketSpine,
  ChartBucket,
  ChartGranularity,
  chartPlot,
} from "lib/greenlight/qualityCharts";
import { ABSENT, secondsFormatter } from "lib/greenlight/qualityFigures";
import {
  composite,
  decoded,
  rgbOf,
  ThemeMode,
  THEMES,
  WINDOW,
} from "./greenlightQuality.helpers";

// A daily window of 31 buckets, the first whole and the last partial.
const MONTH = {
  effective_start: "2026-08-29T00:00:00.000Z",
  effective_end: "2026-09-28T04:13:00.000Z",
};

// Two whole weeks, midnight to midnight: no bucket is partial.
const WHOLE_DAYS = {
  effective_start: "2026-08-03T00:00:00.000Z",
  effective_end: "2026-08-17T00:00:00.000Z",
};

// The colour a chart is drawn on: the Paper, lightened in dark mode by the
// overlay MUI grades by elevation.
function paperSurface(mode: ThemeMode): string {
  const paper = THEMES[mode].palette.background.paper;
  return mode === "dark"
    ? lighten(paper, getOverlayAlpha(CHART_PAPER_ELEVATION))
    : paper;
}

function build(
  chart: QualityChartConfig,
  spine: ChartBucket[],
  rows: any[],
  mode: ThemeMode = "light",
  granularity: ChartGranularity = "day"
): any {
  const plot = chartPlot(
    spine,
    rows,
    granularity,
    chart.source,
    chart.series.map((series) => series.value)
  );
  return chartOption(chart, spine, plot, THEMES[mode], granularity);
}

function optionFor(key: QualityChartKey, mode: ThemeMode = "light"): any {
  return build(QUALITY_CHARTS[key], bucketSpine(MONTH, "day"), [], mode);
}

// One latency row per day of MONTH; the last, partial day measured nothing.
function monthOfLatency(): any[] {
  return bucketSpine(MONTH, "day").map((bucket, i, spine) => ({
    latency_bucket: `${bucket.key}T00:00:00.000Z`,
    n_end_to_end: i === spine.length - 1 ? 0 : 5,
    n_e2e_within_cutoff: i === spine.length - 1 ? 0 : 4,
    e2e_p50_s: i === spine.length - 1 ? null : 600,
    e2e_cutoff_s: 1800,
  }));
}

// The chart's own series, without the band carrier ECharts needs past them.
function chartSeries(option: any, chart: QualityChartConfig): any[] {
  return option.series.slice(0, chart.series.length);
}

describe("layout", () => {
  // A bucket has to sit at the same x on every chart in the stack.
  test("every chart takes the same fixed grid, whatever its labels", () => {
    const grids = QUALITY_CHART_ORDER.map((key) => optionFor(key).grid);
    expect(new Set(grids.map((grid) => JSON.stringify(grid))).size).toBe(1);
    expect(grids[0]).not.toHaveProperty("containLabel");
    expect(grids[0].left).toBeGreaterThan(0);
    expect(grids[0].right).toBeGreaterThan(0);
  });

  test.each(QUALITY_CHART_ORDER)(
    "every %s series is plotted against an axis of the kind its values need",
    (key) => {
      const chart = QUALITY_CHARTS[key];
      const option = optionFor(key);
      const expectedAxis = {
        count: { type: "value", minInterval: 1 },
        share: { type: "value", name: "%", min: 0 },
        minutes: { type: "log" },
      };
      chart.series.forEach((series, i) => {
        const { yAxisIndex } = option.series[i];
        expect(yAxisIndex).toBeGreaterThanOrEqual(0);
        expect(yAxisIndex).toBeLessThan(option.yAxis.length);
        const role =
          series.value.kind === "share" || series.value.kind === "queryShare"
            ? "share"
            : series.value.kind === "p50Minutes"
            ? "minutes"
            : "count";
        expect(option.yAxis[yAxisIndex]).toMatchObject(expectedAxis[role]);
      });
      const carrier = option.series[chart.series.length];
      expect(carrier.yAxisIndex).toBeGreaterThanOrEqual(0);
      expect(carrier.yAxisIndex).toBeLessThan(option.yAxis.length);
    }
  );

  test("an axis appears only for the values some series plots, in the order they first need it", () => {
    const shareFirst: QualityChartConfig = {
      title: "share first",
      source: { query: "latency", bucketField: "latency_bucket" },
      series: [
        {
          name: "share",
          color: "neutral",
          value: {
            kind: "share",
            countField: "n_review_runs_failed",
            denominatorField: "n_review_runs",
          },
        },
        {
          name: "count",
          color: "fault",
          value: { kind: "count", countField: "n_review_runs_failed" },
        },
      ],
      details: () => [],
    };
    const option = build(shareFirst, bucketSpine(MONTH, "day"), []);
    expect(option.yAxis.map((axis: any) => axis.name)).toEqual([
      "%",
      undefined,
    ]);
    expect(option.series.map((series: any) => series.yAxisIndex)).toEqual([
      0, 1, 1,
    ]);
    expect(optionFor("endToEnd").yAxis.map((axis: any) => axis.type)).toEqual([
      "value",
      "log",
    ]);
  });

  test("only the latency shares are pinned to 100%; the small failure and authority shares fit their data", () => {
    const shareMax = (key: QualityChartKey) =>
      optionFor(key).yAxis.find((axis: any) => axis.name === "%")?.max;
    expect(shareMax("endToEnd")).toBe(100);
    expect(shareMax("firstFeedback")).toBe(100);
    expect(shareMax("runsFailed")).toBeUndefined();
    expect(shareMax("mergedGlAlone")).toBeUndefined();
  });
});

describe("partial buckets", () => {
  // A line breaks where a bucket measured nothing, so a partial last bucket of
  // zeros has no mark of its own to fade: the band is what shows it.
  test("a line-only chart bands its partial last bucket even where it plots nothing", () => {
    const chart = QUALITY_CHARTS.endToEnd;
    const spine = bucketSpine(MONTH, "day");
    expect(spine).toHaveLength(31);
    const option = build(chart, spine, monthOfLatency());
    expect(chartSeries(option, chart).map((series) => series.type)).toEqual([
      "line",
      "line",
    ]);
    expect(option.series[0].data[30]).toBeNull();
    const carrier = option.series[chart.series.length];
    expect(carrier).toMatchObject({ type: "bar", silent: true });
    expect(carrier.name).toBeUndefined();
    expect(carrier.data).toEqual(Array(31).fill(null));
    expect(carrier.markArea.data).toEqual([[{ xAxis: 30 }, { xAxis: 30 }]]);
    expect(option.xAxis.axisTick.interval).toBe(0);
  });

  test("a band marks every partial bucket, and no whole one", () => {
    const spine = bucketSpine(WINDOW, "day");
    const option = build(QUALITY_CHARTS.verdicts, spine, []);
    expect(option.series.at(-1).markArea.data).toEqual([
      [{ xAxis: 0 }, { xAxis: 0 }],
      [{ xAxis: 12 }, { xAxis: 12 }],
    ]);
  });

  test("the band carrier stays out of the legend", () => {
    for (const key of QUALITY_CHART_ORDER) {
      expect(optionFor(key).legend.data).toEqual(
        QUALITY_CHARTS[key].series.map((series) => series.name)
      );
    }
  });

  // Each rebuilt option is merged into the chart, and a merge keeps any series
  // a later option leaves out: a band carrier dropped once nothing is partial
  // would go on drawing the last band it held.
  test.each(QUALITY_CHART_ORDER)(
    "%s carries its band series even when no bucket is partial, holding no band",
    (key) => {
      const spine = bucketSpine(WHOLE_DAYS, "day");
      expect(spine.filter((bucket) => bucket.partial)).toEqual([]);
      const option = build(QUALITY_CHARTS[key], spine, []);
      expect(option.series).toHaveLength(QUALITY_CHARTS[key].series.length + 1);
      expect(option.series.at(-1).markArea.data).toEqual([]);
    }
  );
});

// The rebuilt option merged into a live chart, as the page's poll does it, on
// the ECharts this page ships with.
describe("an option merged into a live chart", () => {
  function merged(first: any, second: any, between?: (_chart: any) => void) {
    const chart = echarts.init(null as any, null, {
      renderer: "svg",
      ssr: true,
      width: 800,
      height: 320,
    });
    try {
      chart.setOption({ ...first, animation: false });
      between?.(chart);
      chart.setOption({ ...second, animation: false });
      return chart.getOption() as any;
    } finally {
      chart.dispose();
    }
  }

  test("keeps a series the reader hid from the legend hidden", () => {
    const next = build(QUALITY_CHARTS.endToEnd, bucketSpine(MONTH, "day"), []);
    const option = merged(optionFor("endToEnd"), next, (chart) =>
      chart.dispatchAction({ type: "legendUnSelect", name: "p50" })
    );
    expect(option.legend[0].selected).toMatchObject({ p50: false });
  });

  test("clears a band the new option no longer holds", () => {
    const option = merged(
      optionFor("verdicts"),
      build(QUALITY_CHARTS.verdicts, bucketSpine(WHOLE_DAYS, "day"), [])
    );
    expect(option.series).toHaveLength(
      QUALITY_CHARTS.verdicts.series.length + 1
    );
    expect(option.series.at(-1).markArea.data).toEqual([]);
  });
});

// The app's dark divider is nearly the colour of the elevated Paper the charts
// are drawn on, so nothing a reader must see may take it.
describe.each(["light", "dark"] as const)(
  "what the chart draws against the Paper in %s mode",
  (mode) => {
    const theme = THEMES[mode];
    const option = optionFor("runsFailed", mode);
    const surface = paperSurface(mode);

    test("the gridlines come from the text colour, on the left axis alone", () => {
      const gridline = option.yAxis[0].splitLine.lineStyle.color;
      expect(rgbOf(gridline)).toEqual(rgbOf(theme.palette.text.primary));
      expect(gridline).not.toBe(theme.palette.divider);
      expect(option.yAxis.slice(1).map((axis: any) => axis.splitLine)).toEqual([
        { show: false },
      ]);
    });

    test("the gridlines stand clear of the Paper", () => {
      const gridline = option.yAxis[0].splitLine.lineStyle.color;
      expect(
        getContrastRatio(composite(gridline, surface), surface)
      ).toBeGreaterThanOrEqual(1.5);
    });

    test("the axis pointer and the legend's controls come from the text colours", () => {
      expect(option.tooltip.axisPointer.lineStyle.color).toBe(
        theme.palette.text.secondary
      );
      expect(rgbOf(option.legend.inactiveColor)).toEqual(
        rgbOf(theme.palette.text.primary)
      );
      expect(option.legend).toMatchObject({
        pageIconColor: theme.palette.text.primary,
        pageIconInactiveColor: theme.palette.text.disabled,
        pageTextStyle: { color: theme.palette.text.secondary },
      });
      const drawn = [
        option.tooltip.axisPointer.lineStyle.color,
        option.legend.inactiveColor,
        option.legend.pageIconColor,
        option.legend.pageIconInactiveColor,
        option.legend.pageTextStyle.color,
      ];
      expect(drawn).not.toContain(theme.palette.divider);
    });
  }
);

test("the app's dark divider would all but vanish on the charts' Paper", () => {
  const surface = paperSurface("dark");
  expect(surface).toBe("rgb(59, 59, 59)");
  expect(getContrastRatio(THEMES.dark.palette.divider, surface)).toBeLessThan(
    1.1
  );
});

// Charts that draw a line over bars: the merge chart and both review-run
// charts. Nothing else fades a bar or rings a marker.
describe.each(["light", "dark"] as const)(
  "lines drawn over bars in %s mode",
  (mode) => {
    const theme = THEMES[mode];
    const colours = qualityColors(theme);
    const base = (series: { color: string }) =>
      series.color === "neutral"
        ? theme.palette.text.secondary
        : colours[series.color as keyof typeof colours];

    test.each(["mergedGlAlone", "runsFailed", "runsOverRuntime"] as const)(
      "%s fills its bars faintly and rings its markers in the Paper's colour",
      (key) => {
        const chart = QUALITY_CHARTS[key];
        const drawn = chartSeries(optionFor(key, mode), chart);
        chart.series.forEach((series, i) => {
          if (drawn[i].type === "bar") {
            expect(drawn[i].itemStyle.color).toBe(alpha(base(series), 0.35));
          } else {
            expect(drawn[i].itemStyle).toMatchObject({
              borderColor: paperSurface(mode),
              borderWidth: 1.5,
            });
            expect(drawn[i].lineStyle.color).toBe(drawn[i].itemStyle.color);
          }
        });
      }
    );

    test("the grey share line over the review-run bars keeps its full colour", () => {
      const grey = chartSeries(
        optionFor("runsFailed", mode),
        QUALITY_CHARTS.runsFailed
      ).find((series) => series.name === "% of runs");
      expect(grey.lineStyle.color).toBe(theme.palette.text.secondary);
      expect(grey.itemStyle.color).toBe(theme.palette.text.secondary);
    });

    test("bars alone, or lines alone, are drawn in full with no rings", () => {
      const verdicts = chartSeries(
        optionFor("verdicts", mode),
        QUALITY_CHARTS.verdicts
      );
      expect(verdicts.map((series) => series.itemStyle.color)).toEqual([
        colours.land,
        colours.fault,
      ]);
      const endToEnd = chartSeries(
        optionFor("endToEnd", mode),
        QUALITY_CHARTS.endToEnd
      );
      expect(endToEnd.map((series) => series.itemStyle.borderColor)).toEqual([
        undefined,
        undefined,
      ]);
    });
  }
);

describe("the axis", () => {
  test("weekly buckets are labelled by their Monday", () => {
    const option = build(
      QUALITY_CHARTS.verdicts,
      bucketSpine(WINDOW, "week"),
      [],
      "light",
      "week"
    );
    expect(option.xAxis.data).toEqual(["Jul 27", "Aug 3", "Aug 10"]);
  });

  test("the description names the chart, its buckets and the span they cover", () => {
    expect(optionFor("endToEnd").aria.label.description).toBe(
      "End-to-end: push → verdict: 31 daily buckets, " +
        "2026-08-29 00:00 → 2026-09-28 04:13 UTC."
    );
    const weekly = build(
      QUALITY_CHARTS.verdicts,
      bucketSpine(WINDOW, "week"),
      [],
      "light",
      "week"
    );
    expect(weekly.aria.label.description).toBe(
      "Verdicts: 3 weekly buckets, 2026-07-31 19:35 → 2026-08-12 14:00 UTC."
    );
  });
});

describe("line colours", () => {
  const lineColours = (key: QualityChartKey, mode: ThemeMode) =>
    chartSeries(optionFor(key, mode), QUALITY_CHARTS[key])
      .filter((series) => series.type === "line")
      .map((series) => series.lineStyle.color);

  test("in light mode the second line of a pair takes a hue apart from the tile's", () => {
    const light = qualityColors(THEMES.light);
    expect(lineColours("endToEnd", "light")).toEqual([
      light.secondFigure,
      THEMES.light.palette.info.dark,
    ]);
    expect(lineColours("mergedGlAlone", "light")).toEqual([
      light.firstFigure,
      THEMES.light.palette.info.dark,
    ]);
  });

  test("in dark mode every line keeps its tile's colour", () => {
    const dark = qualityColors(THEMES.dark);
    expect(lineColours("endToEnd", "dark")).toEqual([
      dark.secondFigure,
      dark.firstFigure,
    ]);
    expect(lineColours("mergedGlAlone", "dark")).toEqual([
      dark.firstFigure,
      dark.secondFigure,
    ]);
  });
});

describe("the tooltip", () => {
  const spine = bucketSpine(MONTH, "day");
  const chart = QUALITY_CHARTS.endToEnd;
  const option = build(chart, spine, monthOfLatency());

  // The lines of one tooltip, tags other than the breaks stripped.
  function lines(params: { dataIndex: number; seriesIndex: number }[]) {
    return decoded(
      option.tooltip.formatter(params).replace(/<(?!br\/>)[^>]*>/g, "")
    ).split("<br/>");
  }

  test("names the bucket's span, each shown series' figure and the counts behind its shares", () => {
    expect(
      lines([
        { dataIndex: 0, seriesIndex: 0 },
        { dataIndex: 0, seriesIndex: 1 },
      ])
    ).toEqual([
      "2026-08-29 00:00 → 2026-08-30 00:00 UTC",
      "% within cutoff: 80.0%",
      `p50: ${secondsFormatter(600)}`,
      `4 of 5 within ${secondsFormatter(1800)}`,
    ]);
  });

  test("marks a partial bucket, and shows no figure where nothing was measured", () => {
    expect(
      lines([
        { dataIndex: 30, seriesIndex: 0 },
        { dataIndex: 30, seriesIndex: 1 },
      ])
    ).toEqual([
      "2026-09-28 00:00 → 2026-09-28 04:13 UTC · partial bucket",
      `% within cutoff: ${ABSENT}`,
      `p50: ${ABSENT}`,
      `0 of 0 within ${secondsFormatter(1800)}`,
    ]);
  });

  test("leaves out a series the legend hid, and the band carrier", () => {
    expect(
      lines([
        { dataIndex: 0, seriesIndex: 0 },
        { dataIndex: 0, seriesIndex: chart.series.length },
      ])
    ).toEqual([
      "2026-08-29 00:00 → 2026-08-30 00:00 UTC",
      "% within cutoff: 80.0%",
      `4 of 5 within ${secondsFormatter(1800)}`,
    ]);
  });

  test("a bucket with no row lists no detail lines", () => {
    const empty = build(chart, spine, []);
    const html = empty.tooltip.formatter([{ dataIndex: 3, seriesIndex: 0 }]);
    expect(
      decoded(html.replace(/<(?!br\/>)[^>]*>/g, "")).split("<br/>")
    ).toEqual([
      "2026-09-01 00:00 → 2026-09-02 00:00 UTC",
      `% within cutoff: ${ABSENT}`,
    ]);
  });

  test("escapes series names and detail lines", () => {
    const hostile: QualityChartConfig = {
      title: "hostile",
      source: { query: "coverage", bucketField: "coverage_bucket" },
      series: [
        {
          name: "<b>LAND</b>",
          color: "land",
          value: { kind: "count", countField: "prs_land" },
        },
      ],
      details: () => ['<img src=x onerror="alert(1)">'],
    };
    const html = build(hostile, spine, [
      { coverage_bucket: "2026-08-29T00:00:00.000Z", prs_land: 2 },
    ]).tooltip.formatter([{ dataIndex: 0, seriesIndex: 0 }]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;LAND&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  test("a bucket of one PR says so in the singular", () => {
    const prs = QUALITY_CHARTS.prsEvaluated;
    const html = build(prs, spine, [
      {
        coverage_bucket: "2026-08-29T00:00:00.000Z",
        prs_evaluated: 1,
        prs_with_verdict: 1,
        prs_land: 1,
        prs_no_land: 0,
      },
    ]).tooltip.formatter([{ dataIndex: 0, seriesIndex: 0 }]);
    expect(html.split("<br/>").at(-1)).toBe("1 PR");
  });
});
