import { Stack, Typography } from "@mui/material";
import {
  CLICKHOUSE_TIME_FORMAT,
  DEFAULT_TIME_RANGE,
  snapStopToGranularity,
  snapToGranularity,
} from "components/common/timeWindow";
import BreakagesSection, {
  useBreakagesData,
} from "components/targetDeterminator/BreakagesSection";
import KeyMetricsSection from "components/targetDeterminator/KeyMetricsSection";
import RankingSection from "components/targetDeterminator/RankingSection";
import SavingsSection, {
  useSavingsData,
} from "components/targetDeterminator/SavingsSection";
import StabilitySection from "components/targetDeterminator/StabilitySection";
import {
  TdChartsState,
  TdGranularityControl,
} from "components/targetDeterminator/TdTrends";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import {
  ChartGranularity,
  clearsGranularityOverride,
  defaultGranularity,
  pickedRangeDays,
  PickerChange,
} from "lib/greenlight/qualityCharts";
import { TdParams } from "lib/targetDeterminator";
import { TdChartKey } from "lib/targetDeterminatorTrends";
import _ from "lodash";
import { useEffect, useMemo, useState } from "react";
import { TimeRangePicker } from "./metrics";

dayjs.extend(utc);

// Typing a custom date fires a change per valid intermediate value; each would
// otherwise start every query on the page.
const PICKER_DEBOUNCE_MS = 500;

type PickerTime = dayjs.Dayjs | null;

function initialWindow() {
  const stop = dayjs();
  return { start: stop.subtract(DEFAULT_TIME_RANGE, "day"), stop };
}

// Savings and breakages are read once, with one now, for the key metrics and
// their own sections, so both places always share the same queries.
export function TdSections({
  params,
  charts,
}: {
  params: TdParams;
  charts: TdChartsState;
}) {
  const now = Date.now();
  const savings = useSavingsData(params, now);
  const breakages = useBreakagesData(params, now);
  return (
    <Stack spacing={5}>
      <KeyMetricsSection
        savings={savings}
        breakages={breakages}
        charts={charts}
      />
      <SavingsSection data={savings} charts={charts} />
      <BreakagesSection data={breakages} charts={charts} />
      <RankingSection params={params} charts={charts} />
      <StabilitySection params={params} charts={charts} />
    </Stack>
  );
}

export default function Page() {
  const [initial] = useState(initialWindow);
  const [timeRange, setTimeRange] = useState(DEFAULT_TIME_RANGE);
  const [startTime, setStartTime] = useState<PickerTime>(initial.start);
  const [stopTime, setStopTime] = useState<PickerTime>(initial.stop);
  const [picked, setPicked] = useState(initial);
  const [openCharts, setOpenCharts] = useState<ReadonlySet<TdChartKey>>(
    () => new Set()
  );
  const [granularityOverride, setGranularityOverride] =
    useState<ChartGranularity>();

  const commitWindow = useMemo(
    () =>
      _.debounce(
        (start: dayjs.Dayjs, stop: dayjs.Dayjs) => setPicked({ start, stop }),
        PICKER_DEBOUNCE_MS
      ),
    []
  );
  useEffect(() => () => commitWindow.cancel(), [commitWindow]);
  // A cleared date section sends null and a half-typed one an invalid date;
  // the queries keep the last complete window meanwhile.
  useEffect(() => {
    if (startTime?.isValid() && stopTime?.isValid()) {
      commitWindow(startTime, stopTime);
    }
  }, [startTime, stopTime, commitWindow]);

  const pickerChanged = (change: PickerChange) => {
    if (clearsGranularityOverride(change, timeRange)) {
      setGranularityOverride(undefined);
    }
  };
  const charts: TdChartsState = {
    open: openCharts,
    onToggle: (key) =>
      setOpenCharts((open) => {
        const next = new Set(open);
        if (!next.delete(key)) {
          next.add(key);
        }
        return next;
      }),
    granularity:
      granularityOverride ??
      defaultGranularity(pickedRangeDays(timeRange, startTime, stopTime)),
  };

  // Whole UTC days keep the query parameters, and so the SWR keys, fixed while
  // TimeRangePicker re-derives "now" every 5 minutes.
  const windowStart = snapToGranularity(picked.start, "day").format(
    CLICKHOUSE_TIME_FORMAT
  );
  const windowStop = snapStopToGranularity(picked.stop, "day").format(
    CLICKHOUSE_TIME_FORMAT
  );
  const validWindow = windowStart < windowStop;
  const params: TdParams = useMemo(
    () => ({ startTime: windowStart, stopTime: windowStop }),
    [windowStart, windowStop]
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
        the next. Times are in UTC, counted in whole days. Each section counts
        the part of the picked window its data covers. Click a figure to open
        its chart.
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
          // MUI's date fields take null for a cleared section.
          startTime={startTime as dayjs.Dayjs}
          setStartTime={(value: PickerTime) => {
            setStartTime(value);
            pickerChanged("bound");
          }}
          stopTime={stopTime as dayjs.Dayjs}
          setStopTime={(value: PickerTime) => {
            setStopTime(value);
            pickerChanged("bound");
          }}
          timeRange={timeRange}
          setTimeRange={(value: number) => {
            setTimeRange(value);
            pickerChanged("range");
          }}
        />
        <TdGranularityControl
          value={charts.granularity}
          onChange={setGranularityOverride}
        />
      </Stack>
      {validWindow ? (
        <TdSections params={params} charts={charts} />
      ) : (
        <Typography variant="body1" role="status" color="text.primary">
          The picked window starts after it ends. Pick a start time before the
          stop time.
        </Typography>
      )}
    </div>
  );
}
