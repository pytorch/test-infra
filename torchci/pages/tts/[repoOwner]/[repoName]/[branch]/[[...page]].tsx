import { Grid2, Paper, Stack, Typography } from "@mui/material";
import CheckBoxList from "components/common/CheckBoxList";
import CopyLink from "components/CopyLink";
import GranularityPicker from "components/GranularityPicker";
import LoadingPage from "components/LoadingPage";
import {
  getTooltipMarker,
  Granularity,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay, formatTimeForCharts } from "components/TimeUtils";
import dayjs from "dayjs";
import { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { encodeParams, fetcher } from "lib/GeneralUtils";
import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import useSWRImmutable from "swr/immutable";
import { TimeRangePicker, TtsPercentilePicker } from "../../../../metrics";

const INGORED_WORKFLOWS = [
  "Upload test stats",
  "Upload torch dynamo performance stats",
  "Validate and merge PR",
  "Revert merged PR",
];

function Panel({
  series,
  title,
}: {
  series: Array<any>;
  title: string;
}): JSX.Element {
  const options: EChartsOption = {
    title: { text: title },
    grid: { top: 48, right: 200, bottom: 24, left: 48 },
    xAxis: { type: "time" },
    yAxis: {
      type: "value",
      axisLabel: {
        formatter: durationDisplay,
      },
    },
    series,
    legend: {
      orient: "vertical",
      right: 10,
      top: "center",
      type: "scroll",
      textStyle: {
        overflow: "breakAll",
        width: "150",
      },
    },
    tooltip: {
      trigger: "item",
      formatter: (params: any) =>
        `${params.seriesName}` +
        `<br/>${formatTimeForCharts(params.value[0])}<br/>` +
        `${getTooltipMarker(params.color)}` +
        `<b>${durationDisplay(params.value[1])}</b>`,
    },
  };

  return (
    <ReactECharts
      style={{ height: "100%", width: "100%" }}
      option={options}
      notMerge={true}
    />
  );
}

export default function Page() {
  const router = useRouter();
  const repoOwner: string = (router.query.repoOwner as string) ?? "pytorch";
  const repoName: string = (router.query.repoName as string) ?? "pytorch";
  const branch: string = (router.query.branch as string) ?? "main";
  const jobNamesCompressed: string =
    (router.query.jobNamesCompressed as string) ?? "";
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [timeRange, setTimeRange] = useState<number>(7);
  const [ttsPercentile, setTtsPercentile] = useState<number>(0.5);
  const [selectedJobs, setSelectedJobs] = useState<{
    [key: string]: boolean;
  }>({});

  const GRAPHS_HEIGHT = 800;

  const queryParams: { [key: string]: any } = {
    branch: branch,
    granularity: granularity,
    percentile: ttsPercentile,
    repo: `${repoOwner}/${repoName}`,
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    ignoredWorkflows: INGORED_WORKFLOWS,
  };

  let queryName = "tts_duration_historical_percentile";
  let ttsFieldName = "tts_percentile_sec";
  let durationFieldName = "duration_percentile_sec";

  // -1 is the special case in which we will use avg instead
  if (ttsPercentile === -1) {
    queryName = "tts_duration_historical";
    ttsFieldName = "tts_avg_sec";
    durationFieldName = "duration_avg_sec";
  }

  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data, error } = useSWRImmutable<{ [key: string]: any }[]>(
    url,
    fetcher
  );

  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "full_name";
  const tts_true_series = seriesWithInterpolatedTimes(
    data ?? [],
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    ttsFieldName
  );
  const duration_true_series = seriesWithInterpolatedTimes(
    data ?? [],
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    durationFieldName
  );

  var tts_series = tts_true_series.filter(
    (item: any) => selectedJobs[item["name"]]
  );
  var duration_series = duration_true_series.filter(
    (item: any) => selectedJobs[item["name"]]
  );

  useEffect(() => {
    const jobNamesFromLink = JSON.parse(
      jobNamesCompressed != ""
        ? decompressFromEncodedURIComponent(jobNamesCompressed)
        : "[]"
    );

    if (router.query.jobName) {
      jobNamesFromLink.push(router.query.jobName as string);
    }

    if (tts_true_series.length > 0) {
      setSelectedJobs(
        tts_true_series.reduce((acc: any, item: any) => {
          acc[item.name] = jobNamesFromLink.includes(item.name);
          return acc;
        }, {} as any)
      );
    } else {
      setSelectedJobs(
        jobNamesFromLink.reduce((acc: any, item: any) => {
          acc[item] = true;
          return acc;
        }, {} as any)
      );
    }
  }, [data, jobNamesCompressed, router.query.jobName]);

  const permalink =
    typeof window !== "undefined" &&
    `${window.location.protocol}/${window.location.host}${router.asPath.replace(
      /\?.+/,
      ""
    )}?${encodeParams({
      jobNamesCompressed: compressToEncodedURIComponent(
        JSON.stringify(
          Object.keys(selectedJobs).filter((key) => selectedJobs[key])
        )
      ),
    })}`;

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Job TTS and Duration
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
        <TtsPercentilePicker
          ttsPercentile={ttsPercentile}
          setTtsPercentile={setTtsPercentile}
        />
        <CopyLink textToCopy={permalink || ""} />
      </Stack>
      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 9 }} height={GRAPHS_HEIGHT}>
          {error !== undefined ? (
            <Typography>
              error occured while fetching data, perhaps there are too many
              results with your choice of time range and granularity?
            </Typography>
          ) : data === undefined ? (
            <LoadingPage height={GRAPHS_HEIGHT} />
          ) : (
            <Stack spacing={2} height={GRAPHS_HEIGHT}>
              <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
                <Panel title={"tts"} series={tts_series} />
              </Paper>
              <Paper sx={{ p: 2, height: "50%" }} elevation={3}>
                <Panel title={"duration"} series={duration_series} />
              </Paper>
            </Stack>
          )}
        </Grid2>
        <Grid2 size={{ xs: 3 }} height={GRAPHS_HEIGHT} overflow={"auto"}>
          <CheckBoxList
            items={selectedJobs}
            onChange={setSelectedJobs}
            onClick={(_val) => {}}
          />
        </Grid2>
      </Grid2>
    </div>
  );
}
