import { Grid } from "@mui/material";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import {
  ChurnRow,
  fractionText,
  HORIZON_DAYS,
  num,
  shareIdentical,
  TD_QUERIES,
  totalError,
  totalRow,
  useTdQuery,
} from "lib/targetDeterminator";
import { useMemo } from "react";
import {
  CHART_HEIGHT,
  DailyChart,
  DailyPoint,
  TdPanel,
  TdSection,
} from "./TdPanel";

function dailyShare(rows: ChurnRow[]): DailyPoint[] {
  return rows.flatMap((row) => {
    const share = row.grain === "day" ? shareIdentical(row) : null;
    return share === null
      ? []
      : [{ bucket: row.bucket, series: "Same picks", value: share * 100 }];
  });
}

export default function StabilitySection({
  params,
  windowDays,
}: {
  params: Record<string, unknown>;
  windowDays: number;
}) {
  const churn = useTdQuery<ChurnRow>(TD_QUERIES.churn, {
    startTime: params.startTime,
    stopTime: params.stopTime,
    noTdBuildMarkers: params.noTdBuildMarkers,
  });
  const total = totalRow(churn.rows);
  const error = totalError(TD_QUERIES.churn, churn, total);
  const pairs = num(total?.pairs) ?? 0;
  const identical = num(total?.identical_pairs) ?? 0;
  const changedMedian = num(total?.changed_median_pct);
  const points = useMemo(() => dailyShare(churn.rows), [churn.rows]);
  const noPairs = "No pairs of consecutive green PR pushes in this window.";

  return (
    <TdSection
      title="Run-to-run stability"
      windowDays={windowDays}
      horizonDays={HORIZON_DAYS.stability}
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
          loading={churn.loading}
          error={error}
          value={fractionText(shareIdentical(total))}
          sub={
            pairs === 0
              ? noPairs
              : `${identical.toLocaleString()} of ${pairs.toLocaleString()} consecutive push pairs ran the same test files, over ${(
                  num(total?.prs) ?? 0
                ).toLocaleString()} PRs.`
          }
          caveat="Consecutive pushes of the same PR, per job config, both with every shard green and TD on. Each PR and config pair counts once."
        />
      </Grid>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Typical change when picks change"
          loading={churn.loading}
          error={error}
          value={
            pairs - identical === 0 || changedMedian === null
              ? "-"
              : `${changedMedian.toFixed(1)}%`
          }
          sub={
            pairs === 0
              ? noPairs
              : pairs - identical === 0
              ? "Every pair ran the same test files."
              : `Median share of test files that differ between the two pushes, over ${(
                  pairs - identical
                ).toLocaleString()} pairs that changed.`
          }
          caveat="1 - Jaccard similarity of the two pushes' test file sets: 0% means the same files, 100% means none in common."
        />
      </Grid>
      <Grid size={{ xs: 12 }} height={CHART_HEIGHT}>
        <TdPanel
          title="Same picks on the next push, per day"
          height={CHART_HEIGHT}
          loading={churn.loading}
          error={churn.error}
          emptyText={points.length === 0 ? noPairs : undefined}
        >
          <DailyChart
            title="Share of push pairs with the same picks, per day"
            points={points}
            startTime={params.startTime as string}
            stopTime={params.stopTime as string}
            yAxisLabel="% of pairs"
            yAxisRenderer={(value) => `${Number(value).toFixed(0)}%`}
          />
        </TdPanel>
      </Grid>
    </TdSection>
  );
}
