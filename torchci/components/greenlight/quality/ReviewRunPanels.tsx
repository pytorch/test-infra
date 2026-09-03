import { Grid, Stack, Typography } from "@mui/material";
import { intFormatter } from "components/common/numberFormat";
import {
  hasCount,
  pctOf,
  percentUnitsFormatter,
} from "lib/greenlight/qualityFigures";
import { QUALITY_QUERIES, useQualityQuery } from "lib/greenlight/qualityQuery";
import InfoTooltip from "./InfoTooltip";
import QualityTile, { TILE_SPAN_HALF } from "./QualityTile";
import { REVIEW_RUN_TILES, ReviewRunTileConfig } from "./tileConfigs";

const HEADING = "How review runs end";

// Names the population before either share is read, because "review run" is not
// the grain anything above uses: the clocks are per (PR, head SHA) and per
// verdict, and a reader carrying either of those over would take these
// denominators for a count they have already seen.
const HEADING_NOTE =
  "A review run is one review cycle that reached a terminal status. Cycles " +
  "still in flight are counted in neither share, and the two do not share a " +
  "denominator: only runs carrying a start can be timed.";

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

  return (
    <Stack spacing={1}>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="subtitle1" fontWeight="bold">
          {HEADING}
        </Typography>
        <InfoTooltip label={HEADING} paragraphs={[HEADING_NOTE]} />
      </Stack>

      <Grid container spacing={2}>
        {REVIEW_RUN_TILES.map((tile: ReviewRunTileConfig) => {
          const note = tile.subNote?.(row);
          return (
            <Grid key={tile.key} size={TILE_SPAN_HALF}>
              <QualityTile
                label={tile.label}
                value={percentUnitsFormatter(
                  pctOf(row?.[tile.countField], row?.[tile.nField])
                )}
                sub={`${intFormatter(row?.[tile.countField])} / ${intFormatter(
                  row?.[tile.nField]
                )} review runs${note === undefined ? "" : ` · ${note}`}`}
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
