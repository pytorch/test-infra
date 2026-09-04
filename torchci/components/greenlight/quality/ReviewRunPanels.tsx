import { Grid, useTheme } from "@mui/material";
import { intFormatter } from "components/common/numberFormat";
import {
  hasCount,
  pctOf,
  percentUnitsFormatter,
} from "lib/greenlight/qualityFigures";
import { QUALITY_QUERIES, useQualityQuery } from "lib/greenlight/qualityQuery";
import QualityTile, { TILE_SPAN } from "./QualityTile";
import { qualityColors, tinted } from "./tileColors";
import { REVIEW_RUN_TILES, ReviewRunTileConfig } from "./tileConfigs";

export default function ReviewRunPanels({
  startTime,
  stopTime,
  autoRefresh,
}: {
  startTime: string;
  stopTime: string;
  autoRefresh: boolean;
}) {
  // Same query, and so the same SWR key, as LatencyPanels: these counts ride on
  // the latency row rather than costing a second read of the ledger.
  const latency = useQualityQuery(
    QUALITY_QUERIES.latency,
    startTime,
    stopTime,
    autoRefresh
  );
  const row = latency.row;
  const colors = qualityColors(useTheme());

  return (
    <>
      {REVIEW_RUN_TILES.map((tile: ReviewRunTileConfig) => (
        <Grid key={tile.key} size={TILE_SPAN}>
          <QualityTile
            label={tile.label}
            value={tinted(
              percentUnitsFormatter(
                pctOf(row?.[tile.countField], row?.[tile.nField])
              ),
              colors.fault
            )}
            // Only the numerator is coloured: the denominator is the
            // population, not part of the figure the share reports.
            sub={
              <>
                {tinted(intFormatter(row?.[tile.countField]), colors.fault)}
                {` / ${intFormatter(row?.[tile.nField])} runs`}
              </>
            }
            caveat={tile.caveat(row)}
            loading={latency.loading}
            empty={!hasCount(row?.[tile.nField])}
            error={latency.error}
          />
        </Grid>
      ))}
    </>
  );
}
