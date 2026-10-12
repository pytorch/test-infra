// Pins the GreenLight Quality trend charts as the page renders them: which
// fetches the charts make and share, what a chart shows before, instead of and
// beside its plot, the order the charts stack in, and the theme they draw on.
//
// The real useQualityQuery runs over a stand-in for SWR that records every key,
// fetcher and option it is handed. lib/GeneralUtils is mocked because it carries
// octokit, which does not load under this jest environment. echarts-for-react
// is a stub that keeps what it is handed: a server render has no canvas.

import {
  chartElementId,
  QUALITY_CHART_ORDER,
  QUALITY_CHARTS,
  QualityChartKey,
  revertTotalsNote,
} from "components/greenlight/quality/chartConfigs";
import CoverageTiles from "components/greenlight/quality/CoverageTiles";
import LatencyPanels from "components/greenlight/quality/LatencyPanels";
import QualityCharts from "components/greenlight/quality/QualityCharts";
import ReviewRunPanels from "components/greenlight/quality/ReviewRunPanels";
import TrustPanels from "components/greenlight/quality/TrustPanels";
import fs from "fs";
import { fetcher } from "lib/GeneralUtils";
import { ChartGranularity } from "lib/greenlight/qualityCharts";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import {
  QUALITY_QUERIES,
  QualityQueryState,
  qualityUrl,
  REFRESH_INTERVAL_MS,
  ShadowMode,
} from "lib/greenlight/qualityQuery";
import path from "path";
import { ReactNode } from "react";
import {
  ANCHOR,
  ariaLabels,
  attribute,
  INVERTED_WINDOW,
  useSWRStub as mockUseSWR,
  renderThemed,
  revert,
  rgbOf,
  SHORT_WINDOW,
  swrStub,
  tags,
  texts,
  ThemeMode,
  THEMES,
  WINDOW,
  WINDOW_PROPS,
  withTotals,
} from "./greenlightQuality.helpers";
import { ROOT } from "./greenlightQualityColumnSync.helpers";

jest.mock("lib/GeneralUtils", () => ({ fetcher: jest.fn() }));

jest.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null, fetcher: unknown, options: any) =>
    mockUseSWR(key, fetcher, options),
}));

const mockCharts: any[] = [];

jest.mock("echarts-for-react", () => ({
  __esModule: true,
  default: (props: any) => {
    mockCharts.push(props);
    return null;
  },
}));

const LOADING: QualityQueryState = { loading: true, rows: [] };

function ready(row: any): QualityQueryState {
  return { loading: false, rows: [row], row };
}

function urlFor(
  query: string,
  granularity?: ChartGranularity,
  shadowMode: ShadowMode = WINDOW_PROPS.shadowMode
): string {
  return qualityUrl(
    query,
    WINDOW_PROPS.startTime,
    WINDOW_PROPS.stopTime,
    shadowMode,
    granularity
  );
}

function charts(
  open: QualityChartKey[],
  {
    coverage = ready(WINDOW),
    granularity = "day",
    mode = "light",
    shadowMode = WINDOW_PROPS.shadowMode,
    autoRefresh = WINDOW_PROPS.autoRefresh,
  }: {
    coverage?: QualityQueryState;
    granularity?: ChartGranularity;
    mode?: ThemeMode;
    shadowMode?: ShadowMode;
    autoRefresh?: boolean;
  } = {}
): string {
  return renderThemed(
    <QualityCharts
      {...WINDOW_PROPS}
      shadowMode={shadowMode}
      autoRefresh={autoRefresh}
      openCharts={new Set(open)}
      onGranularityChange={() => {}}
      coverage={coverage}
      granularity={granularity}
    />,
    mode
  );
}

const TOGGLES = {
  openCharts: new Set<QualityChartKey>(QUALITY_CHART_ORDER),
  onToggleChart: () => {},
};

function keysFetched(): (string | null)[] {
  return swrStub.calls.map((call) => call.key);
}

function hasSkeleton(markup: string): boolean {
  return tags(markup).some((tag) =>
    /\bMuiSkeleton-root\b/.test(attribute(tag.attributes, "class") ?? "")
  );
}

beforeEach(() => {
  swrStub.reset();
  mockCharts.length = 0;
});

describe("what the charts fetch", () => {
  test("with no chart open nothing renders and nothing is fetched", () => {
    expect(charts([])).toBe("");
    expect(keysFetched().length).toBeGreaterThan(0);
    expect(keysFetched().filter((key) => key !== null)).toEqual([]);
  });

  test("each source is fetched once at the page's bucket size, however many of its charts are open", () => {
    charts(["endToEnd", "firstFeedback", "runsFailed", "runsOverRuntime"], {
      granularity: "week",
    });
    expect(keysFetched().filter((key) => key !== null)).toEqual([
      urlFor(QUALITY_QUERIES.latency, "week"),
    ]);
    swrStub.reset();
    charts(["prsEvaluated", "verdicts", "mergedGlAlone"]);
    expect(keysFetched().filter((key) => key !== null)).toEqual([
      urlFor(QUALITY_QUERIES.coverage, "day"),
      urlFor(QUALITY_QUERIES.mergeAuthority, "day"),
    ]);
    expect(
      swrStub.calls
        .filter((call) => call.key !== null)
        .map((call) => call.fetcher)
    ).toEqual([fetcher, fetcher]);
  });

  test("a chart's fetch polls on the page's refresh, and the revert chart never polls", () => {
    charts(["endToEnd", "approvedReverts"], { autoRefresh: true });
    const options = (url: string) =>
      swrStub.calls.find((call) => call.key === url)?.options;
    expect(options(urlFor(QUALITY_QUERIES.latency, "day"))).toMatchObject({
      refreshInterval: REFRESH_INTERVAL_MS,
    });
    expect(options(urlFor(QUALITY_QUERIES.reverts))).toMatchObject({
      refreshInterval: 0,
    });
  });

  test("the tiles' own fetches stay whole-window, fetched and polled as before", () => {
    renderThemed(
      <LatencyPanels {...WINDOW_PROPS} autoRefresh {...TOGGLES} />,
      "light"
    );
    expect(swrStub.calls).toEqual([
      {
        key: urlFor(QUALITY_QUERIES.latency),
        fetcher,
        options: {
          refreshInterval: REFRESH_INTERVAL_MS,
          revalidateOnFocus: false,
        },
      },
    ]);
  });

  // The reverts query is the page's slowest, and the tile has already fetched
  // its rows under this key.
  test("the revert chart reads the tile's fetch and can never run it", () => {
    charts(["approvedReverts"]);
    const [chartCall] = swrStub.calls.filter((call) => call.key !== null);
    swrStub.reset();
    renderThemed(<TrustPanels {...WINDOW_PROPS} {...TOGGLES} />, "light");
    const tileCall = swrStub.calls.find(
      (call) => call.key === urlFor(QUALITY_QUERIES.reverts)
    );
    expect(chartCall.key).toBe(urlFor(QUALITY_QUERIES.reverts));
    expect(chartCall.key).toBe(tileCall?.key);
    expect(chartCall.fetcher).toBeNull();
    expect(chartCall.options).toMatchObject({ refreshInterval: 0 });
    expect(tileCall?.fetcher).toBe(fetcher);
  });

  test("an empty window fetches nothing and reads as no data, not as loading", () => {
    const markup = charts(["verdicts", "endToEnd", "approvedReverts"], {
      coverage: ready(INVERTED_WINDOW),
    });
    expect(keysFetched().filter((key) => key !== null)).toEqual([]);
    expect(
      texts(markup).filter((text) => text === NO_DATA_IN_WINDOW)
    ).toHaveLength(3);
    expect(hasSkeleton(markup)).toBe(false);
    expect(mockCharts).toEqual([]);
  });

  test("while coverage loads the charts fetch alongside it and show a skeleton", () => {
    const markup = charts(["runsFailed"], { coverage: LOADING });
    expect(keysFetched().filter((key) => key !== null)).toEqual([
      urlFor(QUALITY_QUERIES.latency, "day"),
    ]);
    expect(hasSkeleton(markup)).toBe(true);
    expect(mockCharts).toEqual([]);
  });
});

describe("what a chart shows", () => {
  test("open charts stack in the tiles' order under the ids their tiles control", () => {
    const markup = charts([
      "runsOverRuntime",
      "prsEvaluated",
      "approvedReverts",
      "endToEnd",
    ]);
    expect(
      tags(markup)
        .map((tag) => attribute(tag.attributes, "id"))
        .filter((id) => id?.startsWith("greenlight-quality-chart-"))
    ).toEqual(
      (
        [
          "prsEvaluated",
          "endToEnd",
          "approvedReverts",
          "runsOverRuntime",
        ] as QualityChartKey[]
      ).map(chartElementId)
    );
  });

  test("a chart is drawn on the coverage window's buckets, not on its own rows'", () => {
    swrStub.data.set(
      urlFor(QUALITY_QUERIES.latency, "day"),
      ["2026-07-31", "2026-09-11"].map((day) => ({
        latency_bucket: `${day}T00:00:00.000Z`,
        n_review_runs_failed: 1,
        n_review_runs: 2,
      }))
    );
    charts(["runsFailed"], { coverage: ready(SHORT_WINDOW) });
    expect(mockCharts).toHaveLength(1);
    const { xAxis, series } = mockCharts[0].option;
    expect(xAxis.data).toEqual(["Sep 10", "Sep 11", "Sep 12"]);
    expect(series[0].data).toEqual([0, 1, 0]);
  });

  test.each([
    ["day", "days"],
    ["week", "weeks"],
  ] as const)(
    "rows that all miss the %s buckets read as an error, not as zeros",
    (granularity, noun) => {
      swrStub.data.set(urlFor(QUALITY_QUERIES.latency, granularity), [
        { latency_bucket: "2020-01-06T00:00:00.000Z", n_review_runs: 4 },
      ]);
      const markup = charts(["runsFailed"], { granularity });
      expect(texts(markup)).toContain(
        `${QUALITY_QUERIES.latency}: none of its rows falls on the charted ${noun}.`
      );
      expect(mockCharts).toEqual([]);
    }
  );

  test("no misalignment is claimed while the rows are still loading", () => {
    const markup = charts(["runsFailed"]);
    expect(hasSkeleton(markup)).toBe(true);
    expect(markup).not.toContain("none of its rows");
  });

  test("a window the coverage row cannot place reads as no data, not as misaligned rows", () => {
    swrStub.data.set(urlFor(QUALITY_QUERIES.latency, "day"), [
      { latency_bucket: "2026-08-03T00:00:00.000Z", n_review_runs: 4 },
    ]);
    const markup = charts(["runsFailed"], { coverage: ready({}) });
    expect(texts(markup)).toContain(NO_DATA_IN_WINDOW);
    expect(markup).not.toContain("none of its rows");
  });

  test("a failed query names itself where its chart would be", () => {
    swrStub.errors.set(
      urlFor(QUALITY_QUERIES.latency, "day"),
      new Error("Unexpected token <")
    );
    const markup = charts(["runsFailed"]);
    expect(texts(markup)).toContain(
      `${QUALITY_QUERIES.latency}: Unexpected token <`
    );
    expect(mockCharts).toEqual([]);
  });

  test.each(["light", "dark"] as const)(
    "in %s mode the charts draw on the matching ECharts theme",
    (mode) => {
      swrStub.data.set(urlFor(QUALITY_QUERIES.coverage, "day"), []);
      charts(["verdicts"], { mode });
      expect(mockCharts.map((chart) => chart.theme)).toEqual([
        mode === "dark" ? "dark-hud" : undefined,
      ]);
    }
  );

  // A merge keeps what the reader chose in the legend; notMerge would drop it on
  // every poll, since each one rebuilds the option.
  test("every chart takes its rebuilt option by merging", () => {
    for (const query of [
      QUALITY_QUERIES.coverage,
      QUALITY_QUERIES.latency,
      QUALITY_QUERIES.mergeAuthority,
    ]) {
      swrStub.data.set(urlFor(query, "day"), []);
    }
    swrStub.data.set(urlFor(QUALITY_QUERIES.reverts), []);
    charts([...QUALITY_CHART_ORDER]);
    expect(mockCharts).toHaveLength(QUALITY_CHART_ORDER.length);
    for (const props of mockCharts) {
      expect(props).not.toHaveProperty("notMerge");
    }
  });

  test.each(["light", "dark"] as const)(
    "in %s mode a marker over bars is ringed in the colour of the Paper the chart sits on",
    (mode) => {
      swrStub.data.set(urlFor(QUALITY_QUERIES.latency, "day"), []);
      const markup = charts(["runsFailed"], { mode });
      const paper = tags(markup).find(
        (tag) =>
          attribute(tag.attributes, "id") === chartElementId("runsFailed")
      );
      const overlay = Number(
        attribute(paper?.attributes ?? "", "style")?.match(
          /--Paper-overlay:linear-gradient\(rgba\(255, 255, 255, ([\d.]+)\)/
        )?.[1] ?? 0
      );
      const surface = rgbOf(THEMES[mode].palette.background.paper).map(
        (channel) => Math.round(channel + (255 - channel) * overlay)
      );
      const ring = mockCharts[0].option.series[1].itemStyle.borderColor;
      expect(rgbOf(ring)).toEqual(surface);
    }
  );

  test("in shadow mode the merge chart says it will not reconcile with its tile", () => {
    const caveat = QUALITY_CHARTS.mergedGlAlone.shadowCaveat as string;
    expect(caveat).toMatch(/whole day's or week's merges\.$/);
    const note = (shadowMode: ShadowMode) =>
      ariaLabels(charts(["mergedGlAlone"], { shadowMode })).join("\n");
    expect(note("shadow")).toContain(caveat);
    expect(note("all")).not.toContain(caveat);
    expect(note("enforcing")).not.toContain(caveat);
  });
});

describe("the revert chart", () => {
  const reverts = urlFor(QUALITY_QUERIES.reverts);

  test("with nothing counted it names what the tile's exclusion lines removed", () => {
    swrStub.data.set(
      reverts,
      withTotals(
        [
          revert("stale", "LAND", "no"),
          revert("ghfirst", "LAND", "yes", "ghfirst"),
          revert("ghfirst-unverified", "LAND", "unknown", "ghfirst"),
        ],
        {
          land_approved_reverts: 0,
          land_approved_ghfirst_reverts: 2,
          land_approved_stale_reverts: 1,
          ghfirst_reverts: 2,
        }
      )
    );
    const markup = charts(["approvedReverts"]);
    expect(mockCharts).toHaveLength(1);
    expect(texts(markup)).toContain(
      "No counted reverts in this window: 2 excluded as ghfirst, 1 excluded as stale."
    );
  });

  test("with nothing excluded either it says only that nothing was counted", () => {
    swrStub.data.set(
      reverts,
      withTotals([ANCHOR], { land_approved_reverts: 0 })
    );
    expect(texts(charts(["approvedReverts"]))).toContain(
      "No counted reverts in this window."
    );
  });

  test("with a counted revert, or no count reported, it shows no such message", () => {
    swrStub.data.set(
      reverts,
      withTotals([revert("counted", "LAND", "yes")], {
        land_approved_reverts: 1,
      })
    );
    expect(charts(["approvedReverts"])).not.toContain("No counted reverts");
    swrStub.data.set(reverts, [revert("counted", "LAND", "yes")]);
    expect(charts(["approvedReverts"])).not.toContain("No counted reverts");
  });

  test("it notes when its bars hold fewer reverts than the tile counts", () => {
    const labels = (landApproved: number) => {
      swrStub.data.set(
        reverts,
        withTotals([revert("counted", "LAND", "yes")], {
          land_approved_reverts: landApproved,
        })
      );
      return ariaLabels(charts(["approvedReverts"])).join("\n");
    };
    expect(labels(3)).toContain(revertTotalsNote(1, 3) as string);
    expect(labels(1)).not.toContain("These bars hold");
  });
});

const PAGE = fs.readFileSync(
  path.join(ROOT, "pages/greenlight_quality.tsx"),
  "utf8"
);

// The page's panel order is JSX in the page itself, so it is read from there.
test("the charts stack in the order the page renders their tiles", () => {
  const page = PAGE;
  const panels: { [_panel: string]: ReactNode } = {
    CoverageTiles: <CoverageTiles coverage={LOADING} {...TOGGLES} />,
    LatencyPanels: <LatencyPanels {...WINDOW_PROPS} {...TOGGLES} />,
    TrustPanels: <TrustPanels {...WINDOW_PROPS} {...TOGGLES} />,
    ReviewRunPanels: <ReviewRunPanels {...WINDOW_PROPS} {...TOGGLES} />,
  };
  const placed = Object.keys(panels).map((panel) => ({
    panel,
    at: page.indexOf(`<${panel}`),
  }));
  expect(placed.filter((p) => p.at === -1)).toEqual([]);
  const idsInTileOrder = placed
    .sort((a, b) => a.at - b.at)
    .flatMap(({ panel }) =>
      tags(renderThemed(panels[panel], "light")).flatMap((tag) => {
        const id = attribute(tag.attributes, "aria-controls");
        return id === undefined ? [] : [id];
      })
    );
  expect(idsInTileOrder).toEqual(QUALITY_CHART_ORDER.map(chartElementId));
});

// The revert chart reads the reverts key without a fetcher, and SWR sends a
// key's error retries and revalidation to its first subscriber, which has to be
// the revert tile's. Matched on the JSX tags: the imports list them the other
// way round.
test("the page renders the revert tile's panel before the charts", () => {
  const tile = PAGE.indexOf("<TrustPanels");
  expect(tile).toBeGreaterThan(-1);
  expect(PAGE.indexOf("<QualityCharts")).toBeGreaterThan(tile);
});
