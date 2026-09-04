import { Grid, useTheme } from "@mui/material";
import {
  hasCount,
  revertStats,
  staleVerdictNote,
} from "lib/greenlight/qualityFigures";
import { QUALITY_QUERIES, useQualityQuery } from "lib/greenlight/qualityQuery";
import { useMemo } from "react";
import QualityTile, { TILE_SPAN } from "./QualityTile";
import { qualityColors, tinted } from "./tileColors";
import {
  MERGE_AUTHORITY_CAVEAT,
  mergeAuthorityShares,
  REVERT_RATE_CAVEAT,
  REVERT_RATE_LABEL,
  revertRateSub,
  revertRateValue,
} from "./tileConfigs";

// Two rates, two different shapes of "small n".
export default function TrustPanels({
  startTime,
  stopTime,
  autoRefresh,
}: {
  startTime: string;
  stopTime: string;
  autoRefresh: boolean;
}) {
  const authority = useQualityQuery(
    QUALITY_QUERIES.mergeAuthority,
    startTime,
    stopTime,
    autoRefresh
  );
  // Same SWR key as RevertedTable — the revert list is fetched once for the page.
  const reverts = useQualityQuery(
    QUALITY_QUERIES.reverts,
    startTime,
    stopTime,
    autoRefresh
  );

  // Both walk every revert row, and a wide window returns them in the
  // thousands once the ledger outgrows the picker's clamp.
  const stats = useMemo(() => revertStats(reverts.rows), [reverts.rows]);
  const staleness = useMemo(
    () => staleVerdictNote(reverts.rows),
    [reverts.rows]
  );

  const colors = qualityColors(useTheme());
  const shares = mergeAuthorityShares(authority.row);
  const revertSub = revertRateSub(stats);

  return (
    <>
      <Grid size={TILE_SPAN}>
        <QualityTile
          label="Merged on GreenLight alone"
          // Each share and the fraction it was taken over carry one colour, so
          // which denominator produced which percentage can be read off the
          // tile without counting positions.
          value={
            <>
              {tinted(shares.evaluated.pct, colors.firstFigure)}
              {" · "}
              {tinted(shares.allMerges.pct, colors.secondFigure)}
            </>
          }
          sub={
            <>
              <div>{tinted(shares.evaluated.fraction, colors.firstFigure)}</div>
              <div>
                {tinted(shares.allMerges.fraction, colors.secondFigure)}
              </div>
            </>
          }
          caveat={MERGE_AUTHORITY_CAVEAT}
          loading={authority.loading}
          // The two rates have different denominators, and only the wider one
          // being zero means nothing was measured. When merges exist but none
          // were evaluated, pct_of_all_merges is a fact and pct_gl_only's own
          // NULL renders as "-" on its own.
          empty={!hasCount(authority.row?.merged_prs_total)}
          error={authority.error}
        />
      </Grid>

      <Grid size={TILE_SPAN}>
        <QualityTile
          label={REVERT_RATE_LABEL}
          value={tinted(revertRateValue(stats), colors.fault)}
          sub={
            <>
              <div>
                {tinted(revertSub.count, colors.fault)}
                {revertSub.rest}
              </div>
              {revertSub.exclusion !== "" && <div>{revertSub.exclusion}</div>}
            </>
          }
          caveat={REVERT_RATE_CAVEAT}
          note={staleness}
          loading={reverts.loading}
          // Keyed on the denominator being absent, not on the row set. The query
          // anchors a revert-free window with a row of its own, so rows exist even
          // when nothing was reverted — and a window where nothing was reverted is
          // this metric's best outcome, not missing data. Only a result carrying no
          // evaluated-PR count at all means there was nothing to measure.
          empty={stats.evaluatedPrs === undefined}
          error={reverts.error}
        />
      </Grid>
    </>
  );
}
