import { Box, Stack, Tooltip, Typography } from "@mui/material";
import CopyLink from "components/common/CopyLink";
import FlakyTrunkControls from "components/flakyTrunk/FlakyTrunkControls";
import FlakyTrunkGraph from "components/flakyTrunk/FlakyTrunkGraph";
import FlakyTrunkHelp from "components/flakyTrunk/FlakyTrunkHelp";
import FlakyTrunkTable from "components/flakyTrunk/FlakyTrunkTable";
import FlakyTrunkTiles from "components/flakyTrunk/FlakyTrunkTiles";
import {
  BucketRange,
  CLICKHOUSE_TIME_FORMAT,
  DEFAULT_TIME_RANGE,
  DenominatorKey,
  LARGE_WINDOW_DAYS,
  parseDate,
  parseDenominator,
  parseGranularity,
  parseMinRuns,
  parseTimeRange,
} from "components/flakyTrunk/common";
import { FLAKY_TRUNK_TABLES } from "components/flakyTrunk/tableConfigs";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useRouter } from "next/router";
import { useCallback, useEffect, useState } from "react";
import { FaInfoCircle } from "react-icons/fa";
dayjs.extend(utc);

const GRAPH_HEIGHT = 420;
const TABLE_HEIGHT = 560;

const PAGE_DESCRIPTION =
  "Trunk (main) only. The graph shows flakiness (infra flake, job flake, " +
  "unclassified); persistent breaks — real regressions and sustained infra " +
  "outages — are summarized in the tiles above the graph. See 'How to read " +
  "this' for definitions.";

export default function Page() {
  const router = useRouter();
  const { query } = router;

  const initialTimeRange = parseTimeRange(
    query.timeRange,
    query.startTime || query.stopTime ? -1 : DEFAULT_TIME_RANGE
  );
  const initialStartTime = parseDate(
    query.startTime,
    dayjs().subtract(
      initialTimeRange === -1 ? DEFAULT_TIME_RANGE : initialTimeRange,
      "day"
    )
  );
  const initialStopTime = parseDate(query.stopTime, dayjs());
  const initialGranularity = parseGranularity(query.granularity);
  const initialDenominator = parseDenominator(query.denominator);
  const initialMinRuns = parseMinRuns(query.minRuns);

  const [startTime, setStartTime] = useState(initialStartTime);
  const [stopTime, setStopTime] = useState(initialStopTime);
  const [timeRange, setTimeRange] = useState(initialTimeRange);
  const [granularity, setGranularity] =
    useState<Granularity>(initialGranularity);
  const [denominator, setDenominator] =
    useState<DenominatorKey>(initialDenominator);
  const [minRuns, setMinRuns] = useState(initialMinRuns);
  const [selectedBucket, setSelectedBucket] = useState<BucketRange | null>(
    null
  );

  const [routerReady, setRouterReady] = useState(false);
  if (!routerReady && router.isReady) {
    setRouterReady(true);
    setTimeRange(initialTimeRange);
    setStartTime(initialStartTime);
    setStopTime(initialStopTime);
    setGranularity(initialGranularity);
    setDenominator(initialDenominator);
    setMinRuns(initialMinRuns);
  }

  useEffect(() => {
    if (!router.isReady) return;

    const params = new URLSearchParams();
    if (timeRange !== -1) {
      params.set("timeRange", timeRange.toString());
    } else {
      params.set("startTime", startTime.utc().format("YYYY-MM-DD"));
      params.set("stopTime", stopTime.utc().format("YYYY-MM-DD"));
    }
    params.set("granularity", granularity);
    params.set("denominator", denominator);
    params.set("minRuns", minRuns.toString());

    router.push(
      { pathname: router.pathname, query: params.toString() },
      undefined,
      { shallow: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, stopTime, timeRange, granularity, denominator, minRuns]);

  // A bucket selection only makes sense for the granularity/window it was made
  // in, so discard it whenever those change. Custom start/stop edits (which only
  // happen while timeRange is -1) count as a window change; the preset
  // auto-refresh reuses the same setters but runs only while timeRange is not -1,
  // so it never clears the selection.
  const changeGranularity = (value: Granularity) => {
    setGranularity(value);
    setSelectedBucket(null);
  };
  const changeTimeRange = (value: number) => {
    setTimeRange(value);
    setSelectedBucket(null);
  };
  const changeStartTime = (value: dayjs.Dayjs) => {
    setStartTime(value);
    if (timeRange === -1) {
      setSelectedBucket(null);
    }
  };
  const changeStopTime = (value: dayjs.Dayjs) => {
    setStopTime(value);
    if (timeRange === -1) {
      setSelectedBucket(null);
    }
  };

  const onBucketClick = useCallback(
    (bucketStart: dayjs.Dayjs) => {
      setSelectedBucket({
        start: bucketStart,
        end: bucketStart.add(1, granularity),
      });
    },
    [granularity]
  );

  const clearBucket = useCallback(() => setSelectedBucket(null), []);

  const windowStart = startTime.utc().format(CLICKHOUSE_TIME_FORMAT);
  const windowStop = stopTime.utc().format(CLICKHOUSE_TIME_FORMAT);
  const tableStart = selectedBucket
    ? selectedBucket.start.utc().format(CLICKHOUSE_TIME_FORMAT)
    : windowStart;
  const tableStop = selectedBucket
    ? selectedBucket.end.utc().format(CLICKHOUSE_TIME_FORMAT)
    : windowStop;

  // Large windows make the per-label table query expensive, so stop polling it
  // on an idle long-range tab.
  const autoRefresh = stopTime.diff(startTime, "day") <= LARGE_WINDOW_DAYS;

  const fullUrl = routerReady
    ? `${window.location.origin}${router.asPath}`
    : "";

  return (
    <div>
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Flaky Trunk Jobs & Runner Labels
        </Typography>
        <Tooltip title={PAGE_DESCRIPTION}>
          <Typography fontSize={"1rem"} fontWeight={"bold"}>
            <FaInfoCircle />
          </Typography>
        </Tooltip>
        <CopyLink
          textToCopy={fullUrl}
          link={true}
          compressed={false}
          style={{ fontSize: "1rem", borderRadius: 10 }}
        />
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {PAGE_DESCRIPTION}
      </Typography>

      <FlakyTrunkHelp />

      <FlakyTrunkControls
        startTime={startTime}
        setStartTime={changeStartTime}
        stopTime={stopTime}
        setStopTime={changeStopTime}
        timeRange={timeRange}
        setTimeRange={changeTimeRange}
        granularity={granularity}
        setGranularity={changeGranularity}
        denominator={denominator}
        setDenominator={setDenominator}
        minRuns={minRuns}
        setMinRuns={setMinRuns}
      />

      <Box sx={{ mt: 3 }}>
        <FlakyTrunkTiles
          startTime={windowStart}
          stopTime={windowStop}
          granularity={granularity}
          autoRefresh={autoRefresh}
        />
      </Box>

      <Box sx={{ height: GRAPH_HEIGHT, mt: 1 }}>
        <FlakyTrunkGraph
          startTime={windowStart}
          stopTime={windowStop}
          granularity={granularity}
          denominator={denominator}
          onBucketClick={onBucketClick}
          autoRefresh={autoRefresh}
        />
      </Box>

      {FLAKY_TRUNK_TABLES.map((config) => (
        <Box key={config.queryName} sx={{ height: TABLE_HEIGHT, mt: 3 }}>
          <FlakyTrunkTable
            config={config}
            startTime={tableStart}
            stopTime={tableStop}
            minRuns={minRuns}
            selectedBucket={selectedBucket}
            onClearFilter={clearBucket}
            autoRefresh={autoRefresh}
          />
        </Box>
      ))}
    </div>
  );
}
