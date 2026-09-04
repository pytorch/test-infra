import { Grid, Stack, Typography, useTheme } from "@mui/material";
import { deepOrange } from "@mui/material/colors";
import { Theme } from "@mui/material/styles";
import {
  CLICKHOUSE_TIME_FORMAT,
  DEFAULT_TIME_RANGE,
  snapStopToGranularity,
  snapToGranularity,
} from "components/common/timeWindow";
import CoverageTiles from "components/greenlight/quality/CoverageTiles";
import LatencyPanels from "components/greenlight/quality/LatencyPanels";
import RevertedTable from "components/greenlight/quality/RevertedTable";
import ReviewRunPanels from "components/greenlight/quality/ReviewRunPanels";
import TrustPanels from "components/greenlight/quality/TrustPanels";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { isEmptyWindow } from "lib/greenlight/qualityFigures";
import {
  QUALITY_QUERIES,
  shouldAutoRefresh,
  useQualityQuery,
} from "lib/greenlight/qualityQuery";
import { useState } from "react";
import { TimeRangePicker } from "./metrics";

dayjs.extend(utc);

// TimeRangePicker re-derives "now" every 5 minutes. Snapping the window to a
// fixed bucket keeps the query timestamps — and so every SWR key on the page —
// stable within the bucket instead of re-running five queries on a timer. The
// bucket is deliberately not user-selectable: it is the analysis window every
// statistic on the page is computed over, and exposing it as a control invites
// it being read as a display setting.
const WINDOW_BUCKET = "hour";

// Lives beside the picker and not in a tile caveat: the caveats render only
// through QualityTile's showProse gate, which an empty window closes on every
// coverage tile at once — the explanation would be unreachable in exactly the
// case it exists for.
//
// States the condition rather than a cause. An empty window is any clamped end
// at or before its clamped start, and the picker has no stop-after-start guard,
// so an inverted range wholly inside the ledger reaches this too.
const EMPTY_WINDOW_NOTE =
  "The selected range resolves to an empty window, so there is nothing to " +
  "measure: it ends before it starts, or it ends before the GreenLight ledger " +
  "begins and the clamp closes it. Check that the end is after the start, and " +
  "move the range forward into the ledger's span.";

// No single colour clears AA here: 4.5:1 at body2's 14px needs relative
// luminance at most 0.183 on the light page background and at least 0.233 on the
// dark one, and those do not meet. warning.main is 8.58:1 on #1e1e1e but 3.11:1
// on #ffffff, where warning.dark reaches only 3.79:1 and deepOrange[900] 5.60:1.
// This is the one message explaining why every tile is blank, so it is the worst
// thing on the page to leave hard to read.
function emptyWindowColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? theme.palette.warning.main
    : deepOrange[900];
}

export default function Page() {
  const theme = useTheme();
  const [timeRange, setTimeRange] = useState(DEFAULT_TIME_RANGE);
  const [startTime, setStartTime] = useState(
    dayjs().subtract(DEFAULT_TIME_RANGE, "day")
  );
  const [stopTime, setStopTime] = useState(dayjs());

  const windowStart = snapToGranularity(startTime, WINDOW_BUCKET).format(
    CLICKHOUSE_TIME_FORMAT
  );
  const windowStop = snapStopToGranularity(stopTime, WINDOW_BUCKET).format(
    CLICKHOUSE_TIME_FORMAT
  );

  // Coverage is the page's cheapest query and the only one that reports the
  // clamped window, so it is fetched here and always polls: its answer is what
  // decides whether the four expensive queries below poll at all.
  const coverage = useQualityQuery(
    QUALITY_QUERIES.coverage,
    windowStart,
    windowStop
  );
  const autoRefresh = shouldAutoRefresh(coverage.row);

  return (
    <div>
      <Typography fontSize={"2rem"} fontWeight={"bold"} sx={{ mb: 2 }}>
        GreenLight Quality
      </Typography>

      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ mb: 3 }}
      >
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
        {isEmptyWindow(coverage.row) && (
          <Typography
            variant="body2"
            role="status"
            color={emptyWindowColor(theme)}
          >
            {EMPTY_WINDOW_NOTE}
          </Typography>
        )}
      </Stack>

      <Stack spacing={3}>
        {/* One container for every tile, so they reflow as a single run and
            pack as many per row as the viewport allows. */}
        <Grid container spacing={2}>
          <CoverageTiles coverage={coverage} />
          <LatencyPanels
            startTime={windowStart}
            stopTime={windowStop}
            autoRefresh={autoRefresh}
          />
          <ReviewRunPanels
            startTime={windowStart}
            stopTime={windowStop}
            autoRefresh={autoRefresh}
          />
          <TrustPanels
            startTime={windowStart}
            stopTime={windowStop}
            autoRefresh={autoRefresh}
          />
        </Grid>
        <RevertedTable
          startTime={windowStart}
          stopTime={windowStop}
          autoRefresh={autoRefresh}
        />
      </Stack>
    </div>
  );
}
