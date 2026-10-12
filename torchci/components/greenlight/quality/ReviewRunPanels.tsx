import { Grid, useTheme } from "@mui/material";
import {
  hasCount,
  pctOf,
  percentUnitsFormatter,
} from "lib/greenlight/qualityFigures";
import {
  QUALITY_QUERIES,
  ShadowMode,
  useQualityQuery,
} from "lib/greenlight/qualityQuery";
import { chartKeyOfTile, chartToggle, ChartToggleProps } from "./chartConfigs";
import QualityTile, { TILE_SPAN } from "./QualityTile";
import { qualityColors, tinted } from "./tileColors";
import {
  REVIEW_RUN_TILES,
  reviewRunFraction,
  ReviewRunTileConfig,
} from "./tileConfigs";

export default function ReviewRunPanels({
  startTime,
  stopTime,
  shadowMode,
  autoRefresh,
  ...toggles
}: {
  startTime: string;
  stopTime: string;
  shadowMode: ShadowMode;
  autoRefresh: boolean;
} & ChartToggleProps) {
  // Same query and same arguments, and so the same SWR key, as LatencyPanels:
  // these counts ride on the latency row rather than costing a second read of
  // the ledger.
  const latency = useQualityQuery(
    QUALITY_QUERIES.latency,
    startTime,
    stopTime,
    shadowMode,
    autoRefresh
  );
  const row = latency.row;
  const colors = qualityColors(useTheme());

  return (
    <>
      {REVIEW_RUN_TILES.map((tile: ReviewRunTileConfig) => {
        const note = tile.subNote?.(row);
        const fraction = reviewRunFraction(tile, row);
        return (
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
                  {tinted(fraction.count, colors.fault)}
                  {fraction.rest}
                  {note === undefined ? "" : ` · ${note}`}
                </>
              }
              caveat={tile.caveat(row)}
              loading={latency.loading}
              empty={!hasCount(row?.[tile.nField])}
              error={latency.error}
              {...chartToggle(chartKeyOfTile(tile.key), toggles)}
            />
          </Grid>
        );
      })}
    </>
  );
}
