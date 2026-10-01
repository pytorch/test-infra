// The chart each GreenLight Quality tile toggles open beneath the tiles.
//
// A chart reads the columns its tile's config names, and the counts its tile's
// helpers compute, through those rather than restating them. The merge-authority
// tile has no config, so its chart names its columns here.

import { intFormatter } from "components/common/numberFormat";
import {
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
} from "lib/greenlight/greenlightRender";
import { ChartSource, ChartValue } from "lib/greenlight/qualityCharts";
import { secondsFormatter } from "lib/greenlight/qualityFigures";
import type { TileToggleProps } from "./QualityTile";
import type { QualityColors } from "./tileColors";
import {
  COVERAGE_TILES,
  LATENCY_TILES,
  LatencyTileConfig,
  MERGE_AUTHORITY_LABEL,
  mergeAuthorityShares,
  noVerdictCount,
  REVERT_RATE_LABEL,
  REVIEW_RUN_TILES,
  reviewRunFraction,
  ReviewRunTileConfig,
  StatTileConfig,
} from "./tileConfigs";

// The page's tile order: CoverageTiles, LatencyPanels, TrustPanels, then
// ReviewRunPanels. Open charts stack in this order, whatever order they were
// opened in.
export const QUALITY_CHART_ORDER = [
  "prsEvaluated",
  "verdicts",
  "endToEnd",
  "firstFeedback",
  "mergedGlAlone",
  "approvedReverts",
  "runsFailed",
  "runsOverRuntime",
] as const;

export type QualityChartKey = (typeof QUALITY_CHART_ORDER)[number];

type SeriesColor = keyof QualityColors | "neutral";

export interface ChartSeriesConfig {
  name: string;
  value: ChartValue;
  color: SeriesColor;
  pattern?: "stripes" | "dots";
  dashed?: boolean;
  // Takes a hue of its own in light mode, where its tile colour and the other
  // line's are two dark greens too close to tell apart.
  lightHue?: boolean;
}

export interface QualityChartConfig {
  title: string;
  tileKey?: string;
  source: ChartSource;
  countAxisName?: string;
  // Pins the share axis, which otherwise fits the data.
  shareMax?: number;
  series: ChartSeriesConfig[];
  // The tooltip's lines beyond the series' own values: the bucket's n and the
  // denominators its shares were taken over.
  details: (_row: any) => (string | undefined)[];
  caveat?: string;
  shadowCaveat?: string;
}

const COVERAGE: ChartSource = {
  query: "coverage",
  bucketField: "coverage_bucket",
};
const LATENCY: ChartSource = {
  query: "latency",
  bucketField: "latency_bucket",
};
const MERGE_AUTHORITY: ChartSource = {
  query: "mergeAuthority",
  bucketField: "merge_bucket",
};

function tileKeyed<T extends { key: string }>(tiles: T[], key: string): T {
  const tile = tiles.find((candidate) => candidate.key === key);
  if (tile === undefined) {
    throw new Error(`No GreenLight Quality tile is keyed ${key}.`);
  }
  return tile;
}

function counted(n: number | undefined, noun: string): string {
  return `${intFormatter(n)} ${noun}${n === 1 ? "" : "s"}`;
}

const PRS_TILE = tileKeyed(COVERAGE_TILES, "prs_evaluated");
const VERDICTS_TILE = tileKeyed(COVERAGE_TILES, "verdicts_total");

function splitSeries(tile: StatTileConfig): ChartSeriesConfig[] {
  return [
    {
      name: GREENLIGHT_STATUS_LAND,
      color: "land",
      value: { kind: "count", countField: tile.landField },
    },
    {
      name: GREENLIGHT_STATUS_NO_LAND,
      color: "fault",
      pattern: "stripes",
      value: { kind: "count", countField: tile.noLandField },
    },
  ];
}

const LATENCY_CAVEAT =
  "Each point is the median and the share within the cutoff over that " +
  "bucket's own measurements. A bucket with only a few of them can sit far " +
  "from the tile, which is why the median uses a log scale.";

function latencyChart(tile: LatencyTileConfig): QualityChartConfig {
  return {
    title: tile.label,
    tileKey: tile.key,
    source: LATENCY,
    shareMax: 100,
    series: [
      {
        name: "% within cutoff",
        color: "secondFigure",
        value: {
          kind: "share",
          countField: tile.withinField,
          denominatorField: tile.nField,
        },
      },
      {
        name: "p50",
        color: "firstFigure",
        dashed: true,
        lightHue: true,
        value: {
          kind: "p50Minutes",
          secondsField: tile.p50Field,
          nField: tile.nField,
        },
      },
    ],
    details: (row) => [
      `${intFormatter(row?.[tile.withinField])} of ${intFormatter(
        row?.[tile.nField]
      )} within ${secondsFormatter(row?.[tile.cutoffField])}`,
      tile.subNote?.(row),
    ],
    caveat: LATENCY_CAVEAT,
  };
}

function reviewRunChart(
  tile: ReviewRunTileConfig,
  countName: string
): QualityChartConfig {
  return {
    title: tile.label,
    tileKey: tile.key,
    source: LATENCY,
    countAxisName: "Runs",
    series: [
      {
        name: countName,
        color: "fault",
        value: { kind: "count", countField: tile.countField },
      },
      {
        name: "% of runs",
        color: "neutral",
        value: {
          kind: "share",
          countField: tile.countField,
          denominatorField: tile.nField,
        },
      },
    ],
    details: (row) => {
      const fraction = reviewRunFraction(tile, row);
      return [`${fraction.count}${fraction.rest}`, tile.subNote?.(row)];
    },
  };
}

export const QUALITY_CHARTS: Record<QualityChartKey, QualityChartConfig> = {
  prsEvaluated: {
    title: PRS_TILE.label,
    tileKey: PRS_TILE.key,
    source: COVERAGE,
    countAxisName: "PRs",
    series: [
      ...splitSeries(PRS_TILE),
      {
        name: "No verdict",
        color: "neutral",
        pattern: "dots",
        value: { kind: "rowCount", countOf: noVerdictCount },
      },
    ],
    details: (row) => [counted(row?.[PRS_TILE.totalField], "PR")],
    caveat:
      "Distinct PRs active in each bucket, split by their latest verdict in " +
      "that bucket. A PR active in several buckets counts in each, so the " +
      "bars need not sum to the tile.",
  },
  verdicts: {
    title: VERDICTS_TILE.label,
    tileKey: VERDICTS_TILE.key,
    source: COVERAGE,
    countAxisName: "Verdicts",
    series: splitSeries(VERDICTS_TILE),
    details: (row) => [counted(row?.[VERDICTS_TILE.totalField], "verdict")],
  },
  endToEnd: latencyChart(tileKeyed(LATENCY_TILES, "end_to_end")),
  firstFeedback: latencyChart(tileKeyed(LATENCY_TILES, "first_feedback")),
  mergedGlAlone: {
    title: MERGE_AUTHORITY_LABEL,
    source: MERGE_AUTHORITY,
    countAxisName: "Merges",
    series: [
      {
        name: "GreenLight alone",
        color: "neutral",
        value: { kind: "count", countField: "gl_only" },
      },
      {
        name: "% of evaluated merges",
        color: "firstFigure",
        dashed: true,
        value: { kind: "queryShare", pctField: "pct_gl_only" },
      },
      {
        name: "% of all merges",
        color: "secondFigure",
        lightHue: true,
        value: { kind: "queryShare", pctField: "pct_of_all_merges" },
      },
    ],
    details: (row) => {
      const shares = mergeAuthorityShares(row);
      return [shares.evaluated.fraction, shares.allMerges.fraction];
    },
    caveat:
      "Each bucket counts what the tile would over that bucket alone, so a PR " +
      "that merged, was reverted and merged again in a later bucket counts in " +
      "each. The evaluated and all-merge totals behind the shares can sum past " +
      "the tile's.",
    shadowCaveat:
      "In shadow mode the chart starts where the shadow ledger does, so it " +
      "does not reconcile with the tile, and its first bucket can hold that " +
      "whole day's or week's merges.",
  },
  approvedReverts: {
    title: REVERT_RATE_LABEL,
    source: { query: "reverts" },
    countAxisName: "Reverts",
    series: [
      {
        name: "Counted reverts",
        color: "fault",
        value: { kind: "revertCount" },
      },
    ],
    details: () => [],
    caveat:
      "The reverts the tile counts, by the UTC day or week they landed. A " +
      "count, not a rate: a revert can land long after the evaluation it " +
      "follows.",
  },
  runsFailed: reviewRunChart(
    tileKeyed(REVIEW_RUN_TILES, "runs_failed"),
    "Failed runs"
  ),
  runsOverRuntime: reviewRunChart(
    tileKeyed(REVIEW_RUN_TILES, "runs_over_runtime"),
    "Runs over cutoff"
  ),
};

// The rows behind the chart come back capped, newest first, while the tile
// reads a pre-cap window count, so the two can part on a wide window.
export function revertTotalsNote(
  charted: number,
  counted: number | undefined
): string | undefined {
  if (counted === undefined || charted === counted) {
    return undefined;
  }
  return `These bars hold ${intFormatter(charted)} of the ${intFormatter(
    counted
  )} reverts the tile counts.`;
}

// Shown over an empty reverts chart, naming what the tile's own exclusion lines
// removed, so a blank grid above a table of listed reverts does not read as a
// fault.
export function countedRevertsMessage(exclusions: string[]): string {
  return exclusions.length === 0
    ? "No counted reverts in this window."
    : `No counted reverts in this window: ${exclusions.join(", ")}.`;
}

export function chartElementId(key: QualityChartKey): string {
  return `greenlight-quality-chart-${key}`;
}

export function chartKeyOfTile(tileKey: string): QualityChartKey | undefined {
  return QUALITY_CHART_ORDER.find(
    (key) => QUALITY_CHARTS[key].tileKey === tileKey
  );
}

export interface ChartToggleProps {
  openCharts: ReadonlySet<QualityChartKey>;
  onToggleChart: (_key: QualityChartKey) => void;
}

export function chartToggle(
  key: QualityChartKey | undefined,
  { openCharts, onToggleChart }: ChartToggleProps
): TileToggleProps {
  if (key === undefined) {
    return {};
  }
  return {
    selected: openCharts.has(key),
    onToggle: () => onToggleChart(key),
    controlsId: chartElementId(key),
  };
}
