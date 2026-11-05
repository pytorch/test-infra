import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile from "components/greenlight/quality/QualityTile";
import {
  countedText,
  NEW_TEST_CHECK_FROM,
  NOTHING_TO_MEASURE,
  PENDING_NOTE,
  REVERT_WINDOW_DAYS,
  savedShare,
  withNote,
} from "lib/targetDeterminator";
import { type BreakagesData } from "./BreakagesSection";
import { type SavingsData } from "./SavingsSection";
import { TdSection } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

const KEY_TILE_SPAN = { xs: 12, md: 6 };

// The section counts the breakages range, which is never narrower than the
// savings one; the CI-saved figure states its own range where the two differ.
export default function KeyMetricsSection({
  savings,
  breakages,
  charts,
}: {
  savings: SavingsData;
  breakages: BreakagesData;
  charts: TdChartsState;
}) {
  const { range, stats, pending } = breakages;
  const share = savedShare(savings.savings.total);
  const savingsRangeDiffers =
    savings.range.start !== range.start || savings.range.end !== range.end;

  return (
    <TdSection
      title="Key metrics"
      range={withNote(
        range,
        breakages.upperBound
          ? `Before ${NEW_TEST_CHECK_FROM}, recall is a lower bound.`
          : undefined
      )}
      intro={
        "The two numbers to track: CI time saved should go up; breakage " +
        "recall is its counter-metric and must not go down."
      }
    >
      <Grid size={KEY_TILE_SPAN}>
        <QualityTile
          label="CI time saved (estimated)"
          {...tileToggle(charts, "ciSaved")}
          loading={savings.savings.loading}
          error={savings.savings.tileError}
          value={percentFormatter(share.value)}
          sub={share.sub}
          caveat="How much test machine time pull requests save, across the pull and trunk workflows, by running only the tests most likely to fail instead of every test. Higher is better."
          note={savingsRangeDiffers ? countedText(savings.range) : undefined}
        />
      </Grid>
      <Grid size={KEY_TILE_SPAN}>
        <QualityTile
          label="Breakage recall"
          {...tileToggle(charts, "recall")}
          loading={breakages.breakages.loading}
          error={breakages.breakages.tileError}
          value={pending ? "-" : percentFormatter(stats.recall)}
          sub={
            pending
              ? PENDING_NOTE
              : stats.recallBase === 0
              ? NOTHING_TO_MEASURE
              : undefined
          }
          caveat="Of the reverted changes whose broken test could have run on their pull request, how often it did run. Higher is better."
          note={`Counts changes merged more than ${REVERT_WINDOW_DAYS} days ago.`}
        />
      </Grid>
      <TdCharts
        charts={charts}
        keys={["ciSaved", "recall"]}
        sources={{
          savings: { ...savings.savings, window: savings.range },
          breakages: breakages.chart,
        }}
      />
    </TdSection>
  );
}
