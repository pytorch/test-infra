import { Grid } from "@mui/material";
import {
  hasCount,
  revertStats,
  staleVerdictNote,
} from "lib/greenlight/qualityFigures";
import {
  QUALITY_QUERIES,
  QualityQueryState,
  useQualityQuery,
} from "lib/greenlight/qualityQuery";
import { useMemo } from "react";
import QualityTile, { TILE_SPAN_HALF } from "./QualityTile";
import {
  mergeAuthorityCaveat,
  mergeAuthoritySub,
  mergeAuthorityValue,
  REVERT_RATE_LABEL,
  revertRateCaveat,
  revertRateSub,
  revertRateValue,
} from "./tileConfigs";

// Two rates, two different shapes of "small n". Each caveat is built from the
// query's own fields so the numbers in the prose cannot drift from the number on
// the face.
//
// coverage arrives as a prop and supplies only a window string inside the
// revert caveat, so neither its failure nor its loading state is wired into
// that tile: the revert figure is computable without it.
export default function TrustPanels({
  startTime,
  stopTime,
  coverage,
  autoRefresh,
}: {
  startTime: string;
  stopTime: string;
  coverage: QualityQueryState;
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

  return (
    <Grid container spacing={2}>
      <Grid size={TILE_SPAN_HALF}>
        <QualityTile
          label="Merged on GreenLight alone"
          value={mergeAuthorityValue(authority.row)}
          sub={mergeAuthoritySub(authority.row)}
          caveat={mergeAuthorityCaveat(authority.row)}
          loading={authority.loading}
          // The two rates have different denominators, and only the wider one
          // being zero means nothing was measured. When merges exist but none
          // were evaluated, pct_of_all_merges is a fact and pct_gl_only's own
          // NULL renders as "-" on its own.
          empty={!hasCount(authority.row?.merged_prs_total)}
          error={authority.error}
        />
      </Grid>

      <Grid size={TILE_SPAN_HALF}>
        <QualityTile
          label={REVERT_RATE_LABEL}
          value={revertRateValue(stats)}
          sub={revertRateSub(stats)}
          caveat={revertRateCaveat(stats, coverage.row)}
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
    </Grid>
  );
}
