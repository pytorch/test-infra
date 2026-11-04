import { Stack, Typography } from "@mui/material";
import {
  CLICKHOUSE_TIME_FORMAT,
  DEFAULT_TIME_RANGE,
  snapStopToGranularity,
  snapToGranularity,
} from "components/common/timeWindow";
import BreakagesSection from "components/targetDeterminator/BreakagesSection";
import RankingSection from "components/targetDeterminator/RankingSection";
import SavingsSection from "components/targetDeterminator/SavingsSection";
import StabilitySection from "components/targetDeterminator/StabilitySection";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { TdParams, windowDays } from "lib/targetDeterminator";
import { useMemo, useState } from "react";
import { TimeRangePicker } from "./metrics";

dayjs.extend(utc);

export default function Page() {
  const [timeRange, setTimeRange] = useState(DEFAULT_TIME_RANGE);
  const [startTime, setStartTime] = useState(
    dayjs().subtract(DEFAULT_TIME_RANGE, "day")
  );
  const [stopTime, setStopTime] = useState(dayjs());

  // Whole UTC days keep the query parameters, and so the SWR keys, fixed while
  // TimeRangePicker re-derives "now" every 5 minutes.
  const windowStart = snapToGranularity(startTime, "day").format(
    CLICKHOUSE_TIME_FORMAT
  );
  const windowStop = snapStopToGranularity(stopTime, "day").format(
    CLICKHOUSE_TIME_FORMAT
  );
  const validWindow = windowStart < windowStop;
  const params: TdParams = useMemo(
    () => ({ startTime: windowStart, stopTime: windowStop }),
    [windowStart, windowStop]
  );
  // The queries stop at the current time, so the part of the window after it
  // holds no data and does not count against a section's horizon.
  const nowText = dayjs.utc().format(CLICKHOUSE_TIME_FORMAT);
  const days = windowDays(
    windowStart,
    windowStop < nowText ? windowStop : nowText
  );

  return (
    <div>
      <Typography fontSize="2rem" fontWeight="bold" component="h1">
        Target Determinator
      </Typography>
      <Typography variant="body1" sx={{ mt: 1, mb: 2, maxWidth: 1000 }}>
        On pull requests, the Target Determinator (TD) runs about a quarter of
        each test job&apos;s tests: the ones most likely to fail for the change.
        Main runs every test. This page shows what that means for contributors:
        how much time and CI it saves, which breakages it lets through, whether
        it picks the right tests, and how stable its picks are from one push to
        the next. Times are in UTC, counted in whole days.
      </Typography>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }}>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Stack>
      {validWindow ? (
        <Stack spacing={5}>
          <SavingsSection params={params} windowDays={days} />
          <BreakagesSection params={params} windowDays={days} />
          <RankingSection params={params} windowDays={days} />
          <StabilitySection params={params} windowDays={days} />
        </Stack>
      ) : (
        <Typography variant="body1" role="status" color="text.primary">
          The picked window starts after it ends. Pick a start time before the
          stop time.
        </Typography>
      )}
    </div>
  );
}
