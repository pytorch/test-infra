import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { percentUnitsFormatter } from "lib/greenlight/qualityFigures";
import {
  countedRange,
  sectionLimits,
  TD_QUERIES,
  TdParams,
} from "lib/targetDeterminator";
import { type ChurnRow, num, ratio } from "lib/targetDeterminatorRows";
import { TdSection, useTdTotalQuery } from "./TdPanel";
import { TdCharts, TdChartsState, tileToggle } from "./TdTrends";

export default function StabilitySection({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const range = countedRange(params, sectionLimits().stability);
  const churn = useTdTotalQuery<ChurnRow>(TD_QUERIES.churn, range.params);
  const total = churn.total;
  const pairs = num(total?.pairs) ?? 0;
  const identical = num(total?.identical_pairs) ?? 0;
  const changed = pairs - identical;
  const noPairs = "No pairs of consecutive green PR pushes in this window.";

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
          value={percentFormatter(ratio(identical, pairs))}
          sub={
            pairs === 0
              ? noPairs
              : `${identical.toLocaleString()} of ${pairs.toLocaleString()} consecutive push pairs ran the same test files, over ${(
                  num(total?.prs) ?? 0
                ).toLocaleString()} PRs.`
          }
          caveat="Consecutive pushes of the same PR, per job config, both with every shard green and TD on. Every consecutive pair counts, so PRs with many pushes weigh more."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Typical change when picks change"
          {...tileToggle(charts, "typicalChange")}
          loading={churn.loading}
          error={churn.tileError}
          value={
            changed === 0
              ? "-"
              : percentUnitsFormatter(num(total?.changed_median_pct))
          }
          sub={
            pairs === 0
              ? noPairs
              : changed === 0
              ? "Every pair ran the same test files."
              : `Median share of test files that differ between the two pushes, over ${changed.toLocaleString()} pairs that changed.`
          }
          caveat="1 - Jaccard similarity of the two pushes' test file sets: 0% means the same files, 100% means none in common."
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
