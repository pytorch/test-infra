import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import {
  breakageStats,
  CHUNK_MERGES,
  CLAMP_DAYS,
  countedRange,
  DAY_MS,
  dayStart,
  NEW_TEST_CHECK_FROM,
  NOTHING_TO_MEASURE,
  PENDING_NOTE,
  REVERT_WINDOW_DAYS,
  sectionLimits,
  TD_QUERIES,
  TD_SCOPE,
  TdParams,
} from "lib/targetDeterminator";
import {
  mergeChunks,
  rangeChunks,
  useChunkedTdQuery,
} from "lib/targetDeterminatorChunks";
import { type BreakageRow } from "lib/targetDeterminatorRows";
import { TdSection } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

const UPPER_BOUND_TEXT = `Before ${NEW_TEST_CHECK_FROM} new tests cannot be told apart from tests TD skipped, so false greens there are an upper bound`;

export default function BreakagesSection({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const now = Date.now();
  const { chunks, range } = rangeChunks(
    countedRange(params, sectionLimits(now).breakages, now),
    CLAMP_DAYS.breakages,
    now
  );
  const states = useChunkedTdQuery<BreakageRow>(TD_QUERIES.breakages, chunks, {
    tdWorkflows: TD_SCOPE.tdWorkflows,
  });
  const breakages = mergeChunks(
    TD_QUERIES.breakages,
    chunks,
    states,
    CHUNK_MERGES.breakages
  );
  const error = breakages.tileError;
  const stats = breakageStats(breakages.total);
  const events = breakages.total?.events ?? 0;
  const countedUntil = now - REVERT_WINDOW_DAYS * DAY_MS;
  const upperBound =
    !range.empty && range.start < dayStart(NEW_TEST_CHECK_FROM);
  const noEvents =
    range.start >= countedUntil ? PENDING_NOTE : NO_DATA_IN_WINDOW;

  return (
    <TdSection
      title="Breakages TD let through"
      range={
        upperBound
          ? {
              ...range,
              note: [range.note, `${UPPER_BOUND_TEXT}.`]
                .filter((note) => note !== undefined)
                .join(" "),
            }
          : range
      }
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
          value={events === 0 ? "-" : stats.falseGreens.toLocaleString()}
          sub={events === 0 ? noEvents : undefined}
          caveat="Changes that broke main and were reverted, where the test that broke had been skipped on their pull request. Lower is better."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Breakage recall"
          {...tileToggle(charts, "recall")}
          loading={breakages.loading}
          error={error}
          value={events === 0 ? "-" : percentFormatter(stats.recall)}
          sub={
            events === 0
              ? noEvents
              : stats.recallBase === 0
              ? NOTHING_TO_MEASURE
              : undefined
          }
          caveat="Of the reverted changes whose broken test could have run on their pull request, how often it did run. Higher is better."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Reverted landings traced"
          {...tileToggle(charts, "traced")}
          loading={breakages.loading}
          error={error}
          value={events === 0 ? "-" : events.toLocaleString()}
          sub={events === 0 ? noEvents : undefined}
          caveat="Changes that broke tests on main and were reverted. False greens and breakage recall are counted from these."
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["falseGreens", "recall", "traced"]}
        sources={{
          breakages: {
            ...breakages,
            window: {
              ...range,
              countedUntil,
              upperBoundBefore: dayStart(NEW_TEST_CHECK_FROM),
            },
          },
        }}
      />
    </TdSection>
  );
}
