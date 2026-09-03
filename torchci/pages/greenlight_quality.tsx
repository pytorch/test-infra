import { Stack, Typography } from "@mui/material";
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

const PAGE_DESCRIPTION =
  "Quality of the GreenLight auto-land gate on pytorch/pytorch: how much it " +
  "covers, how fast it answers, and how far its verdicts can be trusted. " +
  "Every window is clamped to the span of the GreenLight ledger, so the " +
  "effective window below is the one the rates were computed over.";

export default function Page() {
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
      <Typography fontSize={"2rem"} fontWeight={"bold"} sx={{ mb: 1 }}>
        GreenLight Quality
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {PAGE_DESCRIPTION}
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
      </Stack>

      <Stack spacing={3}>
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
          coverage={coverage}
          autoRefresh={autoRefresh}
        />
        <RevertedTable
          startTime={windowStart}
          stopTime={windowStop}
          autoRefresh={autoRefresh}
        />
      </Stack>
    </div>
  );
}
