import { Paper, Skeleton, Stack, Typography } from "@mui/material";
import { intFormatter } from "components/common/numberFormat";
import { fetcher } from "lib/GeneralUtils";
import { useMemo } from "react";
import useSWR from "swr";
import {
  flakyTrunkTimeseriesUrl,
  percentFormatter,
  TILE_CONFIGS,
} from "./common";

const TILE_HEIGHT = 88;

// Whole-window persistent-break count (real regressions), with its share of all
// reds. Summed client-side from the same timeseries the graph fetches (shared
// SWR key), so this adds no extra query.
export default function FlakyTrunkTiles({
  startTime,
  stopTime,
  granularity,
  viableStrictOnly,
  autoRefresh,
}: {
  startTime: string;
  stopTime: string;
  granularity: string;
  viableStrictOnly: boolean;
  autoRefresh: boolean;
}) {
  const { data } = useSWR(
    flakyTrunkTimeseriesUrl(startTime, stopTime, granularity, viableStrictOnly),
    fetcher,
    { refreshInterval: autoRefresh ? 5 * 60 * 1000 : 0 }
  );

  const totals = useMemo(() => {
    if (!data) {
      return null;
    }
    let red = 0;
    const sums: { [key: string]: number } = {};
    for (const tile of TILE_CONFIGS) {
      sums[tile.key] = 0;
    }
    for (const row of data) {
      red += Number(row.red) || 0;
      for (const tile of TILE_CONFIGS) {
        sums[tile.key] += Number(row[tile.key]) || 0;
      }
    }
    return { red, sums };
  }, [data]);

  return (
    <Stack
      direction="row"
      spacing={2}
      flexWrap="wrap"
      useFlexGap
      sx={{ mb: 1 }}
    >
      {TILE_CONFIGS.map((tile) => (
        <Paper
          key={tile.key}
          elevation={2}
          sx={{ p: 2, minWidth: 220, flex: "1 1 220px" }}
        >
          {totals === null ? (
            <Skeleton variant="rectangular" height={TILE_HEIGHT} />
          ) : (
            <>
              <Typography variant="subtitle2" color="text.secondary">
                {tile.label}
              </Typography>
              <Typography variant="h4" color="text.primary">
                {intFormatter(totals.sums[tile.key])}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {totals.red === 0
                  ? "(— of reds)"
                  : `(${percentFormatter(
                      totals.sums[tile.key] / totals.red
                    )} of reds)`}
              </Typography>
            </>
          )}
        </Paper>
      ))}
    </Stack>
  );
}
