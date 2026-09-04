import { Grid, useTheme } from "@mui/material";
import {
  hasCount,
  pctOf,
  percentUnitsFormatter,
  secondsFormatter,
} from "lib/greenlight/qualityFigures";
import { QUALITY_QUERIES, useQualityQuery } from "lib/greenlight/qualityQuery";
import QualityTile, { TILE_SPAN } from "./QualityTile";
import { QualityColors, qualityColors, tinted } from "./tileColors";
import { LATENCY_TILES, LatencyTileConfig } from "./tileConfigs";

// The duration and the percentage are two different measurements sharing one
// face. Each takes the colour of the word naming it on the sub-line below.
function figure(tile: LatencyTileConfig, row: any, colors: QualityColors) {
  const within = pctOf(row?.[tile.withinField], row?.[tile.nField]);
  return (
    <>
      {tinted(secondsFormatter(row?.[tile.p50Field]), colors.firstFigure)}
      {" · "}
      {tinted(percentUnitsFormatter(within), colors.secondFigure)}
    </>
  );
}

function figureLegend(
  tile: LatencyTileConfig,
  row: any,
  colors: QualityColors
) {
  return (
    <div>
      {tinted("p50", colors.firstFigure)}
      {" · "}
      {tinted(
        `within ${secondsFormatter(row?.[tile.cutoffField])}`,
        colors.secondFigure
      )}
    </div>
  );
}

export default function LatencyPanels({
  startTime,
  stopTime,
  autoRefresh,
}: {
  startTime: string;
  stopTime: string;
  autoRefresh: boolean;
}) {
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
      {LATENCY_TILES.map((tile) => (
        <Grid key={tile.key} size={TILE_SPAN}>
          <QualityTile
            label={tile.label}
            value={figure(tile, row, colors)}
            sub={figureLegend(tile, row, colors)}
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
