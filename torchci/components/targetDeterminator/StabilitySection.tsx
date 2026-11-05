import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import {
  NO_DATA_IN_WINDOW,
  percentUnitsFormatter,
} from "lib/greenlight/qualityFigures";
import {
  CHUNK_MERGES,
  CLAMP_DAYS,
  countedRange,
  histMedian,
  NOTHING_TO_MEASURE,
  sectionLimits,
  TD_QUERIES,
  TdParams,
} from "lib/targetDeterminator";
import {
  mergeChunks,
  rangeChunks,
  useChunkedTdQuery,
} from "lib/targetDeterminatorChunks";
import { type ChurnRow, ratio } from "lib/targetDeterminatorRows";
import { TdSection } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

export default function StabilitySection({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const now = Date.now();
  const { chunks, range } = rangeChunks(
    countedRange(params, sectionLimits(now).stability, now),
    CLAMP_DAYS.stability,
    now
  );
  const states = useChunkedTdQuery<ChurnRow>(TD_QUERIES.churn, chunks);
  const churn = mergeChunks(
    TD_QUERIES.churn,
    chunks,
    states,
    CHUNK_MERGES.stability
  );
  const pairs = churn.total?.pairs ?? 0;
  const identical = churn.total?.identical_pairs ?? 0;
  const changed = pairs - identical;
  const median = histMedian(churn.rows, "bucket_pct", "pairs");

  return (
    <TdSection
      title="Run-to-run stability"
      range={range}
      intro={
        "When a contributor pushes again to the same PR, does TD run the same " +
        "tests? A changed diff is expected to change the picks; large swings " +
        "on small updates make CI results harder to compare between pushes. " +
        "Measured on the pull workflow."
      }
    >
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Same picks on the next push"
          {...tileToggle(charts, "samePicks")}
          loading={churn.loading}
          error={churn.tileError}
          value={pairs === 0 ? "-" : percentFormatter(ratio(identical, pairs))}
          sub={pairs === 0 ? NO_DATA_IN_WINDOW : undefined}
          caveat="How often a new push to a pull request runs exactly the same tests as the push before."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Typical change when picks change"
          {...tileToggle(charts, "typicalChange")}
          loading={churn.loading}
          error={churn.tileError}
          value={
            changed === 0 || median === null
              ? "-"
              : percentUnitsFormatter(median)
          }
          sub={
            pairs === 0
              ? NO_DATA_IN_WINDOW
              : changed === 0
              ? "Picks never changed"
              : median === null
              ? NOTHING_TO_MEASURE
              : undefined
          }
          caveat="When a new push runs different tests, how much of the test list typically changes."
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["samePicks", "typicalChange"]}
        sources={{ churn: { ...churn, window: range } }}
      />
    </TdSection>
  );
}
