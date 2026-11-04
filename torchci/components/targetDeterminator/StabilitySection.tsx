import { Grid } from "@mui/material";
import { percentFormatter } from "components/flakyTrunk/common";
import QualityTile, {
  TILE_SPAN,
} from "components/greenlight/quality/QualityTile";
import { percentUnitsFormatter } from "lib/greenlight/qualityFigures";
import {
  dataExpiry,
  HORIZON_DAYS,
  num,
  ratio,
  RETENTION_DAYS,
  TD_QUERIES,
  TdParams,
} from "lib/targetDeterminator";
import type { ChurnRow } from "lib/targetDeterminatorRows";
import { useMemo } from "react";
import {
  CHART_HEIGHT,
  DailyChart,
  DailyPoint,
  TdPanel,
  TdSection,
  useTdTotalQuery,
} from "./TdPanel";

function dailyShare(rows: ChurnRow[]): DailyPoint[] {
  return rows.flatMap((row) => {
    const share =
      row.grain === "day" ? ratio(row.identical_pairs, row.pairs) : null;
    return share === null
      ? []
      : [{ bucket: row.bucket, series: "Same picks", value: share * 100 }];
  });
}

export default function StabilitySection({
  params,
  windowDays,
}: {
  params: TdParams;
  windowDays: number;
}) {
  const churn = useTdTotalQuery<ChurnRow>(TD_QUERIES.churn, params);
  const total = churn.total;
  const pairs = num(total?.pairs) ?? 0;
  const identical = num(total?.identical_pairs) ?? 0;
  const changed = pairs - identical;
  const points = useMemo(() => dailyShare(churn.rows), [churn.rows]);
  const expiry = dataExpiry(
    params,
    HORIZON_DAYS.stability,
    RETENTION_DAYS.stability
  );
  const noPairs = expiry?.whole
    ? expiry.text
    : "No pairs of consecutive green PR pushes in this window.";

  return (
    <TdSection
      title="Run-to-run stability"
      windowDays={windowDays}
      horizonDays={HORIZON_DAYS.stability}
      expiry={expiry}
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
            startTime={params.startTime}
            stopTime={params.stopTime}
            yAxisLabel="% of pairs"
            yAxisRenderer={(value) => `${Number(value).toFixed(0)}%`}
          />
        </TdPanel>
      </Grid>
    </TdSection>
  );
}
