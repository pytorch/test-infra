import { Box, Stack, Tooltip, Typography } from "@mui/material";
import CopyLink from "components/common/CopyLink";
import FlakyTrunkControls from "components/flakyTrunk/FlakyTrunkControls";
import FlakyTrunkGraph from "components/flakyTrunk/FlakyTrunkGraph";
import FlakyTrunkTable, {
  BucketRange,
} from "components/flakyTrunk/FlakyTrunkTable";
import {
  CLICKHOUSE_TIME_FORMAT,
  DEFAULT_ENTITY,
  DEFAULT_GRANULARITY,
  DEFAULT_METRIC,
  DEFAULT_MIN_RUNS,
  DEFAULT_TIME_RANGE,
  EntityKey,
  MetricKey,
} from "components/flakyTrunk/common";
import { Granularity } from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { FaInfoCircle } from "react-icons/fa";
dayjs.extend(utc);

const GRAPH_HEIGHT = 420;
const TABLE_HEIGHT = 720;

const PAGE_DESCRIPTION =
  "Trunk (main) only. 'Flaky' = a red confirmed by retry-green, " +
  "green→red→green, or the autorevert advisor; reds that are neither " +
  "confirmed-flaky nor a confirmed regression are shown as 'unknown'.";

export default function Page() {
  const router = useRouter();
  const { query } = router;

  const initialTimeRange = query.timeRange
    ? parseInt(query.timeRange as string)
    : query.startTime || query.stopTime
    ? -1
    : DEFAULT_TIME_RANGE;
  const initialStartTime = query.startTime
    ? dayjs(query.startTime as string)
    : dayjs().subtract(
        initialTimeRange === -1 ? DEFAULT_TIME_RANGE : initialTimeRange,
        "day"
      );
  const initialStopTime = query.stopTime
    ? dayjs(query.stopTime as string)
    : dayjs();
  const initialGranularity = (query.granularity ||
    DEFAULT_GRANULARITY) as Granularity;
  const initialMetric = (query.metric || DEFAULT_METRIC) as MetricKey;
  const initialEntity = (query.entity || DEFAULT_ENTITY) as EntityKey;
  const initialMinRuns = query.minRuns
    ? parseInt(query.minRuns as string)
    : DEFAULT_MIN_RUNS;

  const [startTime, setStartTime] = useState(initialStartTime);
  const [stopTime, setStopTime] = useState(initialStopTime);
  const [timeRange, setTimeRange] = useState(initialTimeRange);
  const [granularity, setGranularity] =
    useState<Granularity>(initialGranularity);
  const [metric, setMetric] = useState<MetricKey>(initialMetric);
  const [entity, setEntity] = useState<EntityKey>(initialEntity);
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
    setMetric(initialMetric);
    setEntity(initialEntity);
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
    params.set("metric", metric);
    params.set("entity", entity);
    params.set("minRuns", minRuns.toString());

    router.push(
      { pathname: router.pathname, query: params.toString() },
      undefined,
      { shallow: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, stopTime, timeRange, granularity, metric, entity, minRuns]);

  // A bucket selection only makes sense for the granularity/window it was made
  // in, so discard it whenever those change.
  const changeGranularity = (value: Granularity) => {
    setGranularity(value);
    setSelectedBucket(null);
  };
  const changeTimeRange = (value: number) => {
    setTimeRange(value);
    setSelectedBucket(null);
  };

  const onBucketClick = (bucketStart: dayjs.Dayjs) => {
    setSelectedBucket({
      start: bucketStart,
      end: bucketStart.add(1, granularity),
    });
  };

  const windowStart = startTime.utc().format(CLICKHOUSE_TIME_FORMAT);
  const windowStop = stopTime.utc().format(CLICKHOUSE_TIME_FORMAT);
  const tableStart = selectedBucket
    ? selectedBucket.start.utc().format(CLICKHOUSE_TIME_FORMAT)
    : windowStart;
  const tableStop = selectedBucket
    ? selectedBucket.end.utc().format(CLICKHOUSE_TIME_FORMAT)
    : windowStop;

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

      <FlakyTrunkControls
        startTime={startTime}
        setStartTime={setStartTime}
        stopTime={stopTime}
        setStopTime={setStopTime}
        timeRange={timeRange}
        setTimeRange={changeTimeRange}
        granularity={granularity}
        setGranularity={changeGranularity}
        metric={metric}
        setMetric={setMetric}
        entity={entity}
        setEntity={setEntity}
        minRuns={minRuns}
        setMinRuns={setMinRuns}
      />

      <Box sx={{ height: GRAPH_HEIGHT, mt: 3 }}>
        <FlakyTrunkGraph
          startTime={windowStart}
          stopTime={windowStop}
          granularity={granularity}
          metric={metric}
          onBucketClick={onBucketClick}
        />
      </Box>

      <Box sx={{ height: TABLE_HEIGHT, mt: 3 }}>
        <FlakyTrunkTable
          entity={entity}
          startTime={tableStart}
          stopTime={tableStop}
          minRuns={minRuns}
          selectedBucket={selectedBucket}
          onClearFilter={() => setSelectedBucket(null)}
        />
      </Box>
    </div>
  );
}
