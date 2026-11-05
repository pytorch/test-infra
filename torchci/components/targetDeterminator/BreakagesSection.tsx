import { Grid } from "@mui/material";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import {
  breakageStats,
  DAY_MS,
  dayStart,
  NEW_TEST_CHECK_FROM,
  PENDING_NOTE,
  REVERT_WINDOW_DAYS,
  TD_SCOPE,
  TdParams,
  withNote,
} from "lib/targetDeterminator";
import {
  mergeChunks,
  sectionChunks,
  useChunkedTdQuery,
} from "lib/targetDeterminatorChunks";
import { type BreakageRow } from "lib/targetDeterminatorRows";
import { TdSection } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

const UPPER_BOUND_NOTE = `Before ${NEW_TEST_CHECK_FROM} new tests cannot be told apart from tests TD skipped, so false greens there are an upper bound.`;

export function useBreakagesData(params: TdParams, now: number) {
  const { spec, chunks, range } = sectionChunks("breakages", params, now);
  const states = useChunkedTdQuery<BreakageRow>(spec.query, chunks, {
    tdWorkflows: TD_SCOPE.tdWorkflows,
  });
  const breakages = mergeChunks(spec.query, chunks, states, spec);
  const countedUntil = now - REVERT_WINDOW_DAYS * DAY_MS;
  return {
    range,
    breakages,
    stats: breakageStats(breakages.total),
    // The picker's Last 7 Days starts at the UTC day start before now - 7
    // days; figures from that sliver of closed landings would stand for the
    // whole range.
    pending: countedUntil - range.start < DAY_MS,
    upperBound: !range.empty && range.start < dayStart(NEW_TEST_CHECK_FROM),
    chart: {
      ...breakages,
      window: {
        ...range,
        countedUntil,
        upperBoundBefore: dayStart(NEW_TEST_CHECK_FROM),
      },
    },
  };
}

export type BreakagesData = ReturnType<typeof useBreakagesData>;

export default function BreakagesSection({
  data,
  charts,
}: {
  data: BreakagesData;
  charts: TdChartsState;
}) {
  const { range, breakages, stats, pending, upperBound } = data;
  const error = breakages.tileError;
  const events = breakages.total?.events ?? 0;

  return (
    <TdSection
      title="Breakages TD let through"
      range={withNote(range, upperBound ? UPPER_BOUND_NOTE : undefined)}
      intro={
        "When TD skips a test that would have failed, the PR shows green, " +
        "lands and breaks main, and is reverted: a false green. These are " +
        "landings reverted by the merge bot within " +
        `${REVERT_WINDOW_DAYS} days, traced to the tests that broke. Landings ` +
        `from the last ${REVERT_WINDOW_DAYS} days are not yet counted.`
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="False greens"
          {...tileToggle(charts, "falseGreens")}
          loading={breakages.loading}
          error={error}
          value={pending ? "-" : stats.falseGreens.toLocaleString()}
          sub={pending ? PENDING_NOTE : undefined}
          caveat="Changes that broke main and were reverted, where the test that broke had been skipped on their pull request. Lower is better."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Reverted landings traced"
          {...tileToggle(charts, "traced")}
          loading={breakages.loading}
          error={error}
          value={pending ? "-" : events.toLocaleString()}
          sub={pending ? PENDING_NOTE : undefined}
          caveat="Changes that broke tests on main and were reverted. False greens and breakage recall are counted from these."
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["falseGreens", "traced"]}
        sources={{ breakages: data.chart }}
      />
    </TdSection>
  );
}
