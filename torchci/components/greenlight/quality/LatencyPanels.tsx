import { Grid, Stack, Typography } from "@mui/material";
import { intFormatter } from "components/common/numberFormat";
import {
  hasCount,
  pctOf,
  percentUnitsFormatter,
  secondsFormatter,
} from "lib/greenlight/qualityFigures";
import { QUALITY_QUERIES, useQualityQuery } from "lib/greenlight/qualityQuery";
import InfoTooltip from "./InfoTooltip";
import QualityTile, { TILE_SPAN_HALF } from "./QualityTile";
import { LATENCY_TILES, LatencyTileConfig } from "./tileConfigs";

const HEADING = "Two independent clocks";

// Quantiles do not add and the two are measured over different populations, one
// per (PR, head SHA) and one per review cycle. Nothing here sums to anything, so
// the tiles are given equal weight rather than a lead-plus-parts layout that
// would invite a waterfall reading.
//
// The sparse push-anchored clocks have an empty band immediately above the p90
// index, so one further observation moves a high percentile by hundreds of
// percent. A fixed cutoff answers the same question and does not move.
const HEADING_NOTE =
  "Each is measured over its own population and carries its own n. They are " +
  "not parts of one another and do not add up. No high percentile is shown: " +
  "the tail is too sparse at this volume for one to hold still.";

function figure(tile: LatencyTileConfig, row: any): string {
  const within = pctOf(row?.[tile.withinField], row?.[tile.nField]);
  return `${secondsFormatter(row?.[tile.p50Field])} · ${percentUnitsFormatter(
    within
  )}`;
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

  return (
    <Stack spacing={1}>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="subtitle1" fontWeight="bold">
          {HEADING}
        </Typography>
        <InfoTooltip label={HEADING} paragraphs={[HEADING_NOTE]} />
      </Stack>

      <Grid container spacing={2}>
        {LATENCY_TILES.map((tile) => {
          const note = tile.subNote?.(row);
          return (
            <Grid key={tile.key} size={TILE_SPAN_HALF}>
              <QualityTile
                label={tile.label}
                value={figure(tile, row)}
                sub={
                  <>
                    <div>{`p50 · within ${secondsFormatter(
                      row?.[tile.cutoffField]
                    )}`}</div>
                    <div>{`n=${intFormatter(row?.[tile.nField])}${
                      note === undefined ? "" : ` · ${note}`
                    }`}</div>
                  </>
                }
                caveat={tile.caveat(row)}
                loading={latency.loading}
                empty={!hasCount(row?.[tile.nField])}
                error={latency.error}
              />
            </Grid>
          );
        })}
      </Grid>
    </Stack>
  );
}
