import {
  Button as _Button,
  Stack as _Stack,
  Box,
  Grid2,
  Typography,
} from "@mui/material";
import { BarChart } from "@mui/x-charts";
import CheckBoxList from "components/common/CheckBoxList";
import LoadingPage from "components/LoadingPage";
import { TimeSeriesPanelWithData } from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay, formatTimeForCharts } from "components/TimeUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import _ from "lodash";
import { useEffect, useMemo, useState } from "react";
import { TimeRangePicker } from "./metrics";
dayjs.extend(utc);

// Some common styles for components
const Button = (props: any) => <_Button variant="contained" {...props} />;
const Stack = (props: any) => <_Stack spacing={2} {...props} />;

function convertToSeries(
  stepsData: any[],
  selectedJobs: { [key: string]: boolean }
) {
  // Convert stepsData to a series and axis for the bar chart.  Only include
  // data for jobs that is selected
  const jobNames = _(selectedJobs)
    .keys()
    .filter((jobName) => selectedJobs[jobName])
    .sortBy()
    .value();
  const steps = ["Checkout PyTorch", "Pull docker image", "Build"];
  const xAxis = [
    {
      data: jobNames,
      scaleType: "band",
    },
  ];
  const groupByJobName = _.groupBy(stepsData, "job_name");

  const series = steps.map((step) => {
    return {
      label: step,
      stack: "total",
      data: jobNames.map((jobName) => {
        const jobData = groupByJobName[jobName] ?? [];
        const stepData = jobData.find((d) => d.step_name === step);
        return stepData?.duration_min ?? 0;
      }),
    };
  });

  return { xAxis, series };
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);
  const [selectedBuild, setSelectedBuild] = useState<string | null>(null);
  const [openSccacheStats, setOpenSccacheStats] = useState<boolean>(false);
  const [selectedJobs, setSelectedJobs] = useState<{
    [key: string]: boolean;
  }>({});

  const timeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };
  const { data: stepsData, isLoading: stepsDataIsLoading } =
    useClickHouseAPIImmutable("build_time_metrics/steps", timeParams);

  const { data: buildData, isLoading: buildDataIsLoading } =
    useClickHouseAPIImmutable("build_time_metrics/overall", {
      ...timeParams,
      granularity: "day",
    });

  const {
    data: selectedBuildSccacheStats,
    isLoading: selectedBuildSccacheStatsIsLoading,
  } = useClickHouseAPIImmutable(
    "build_time_metrics/sccache_stats",
    { jobName: selectedBuild as string, ...timeParams },
    selectedBuild != null && openSccacheStats
  );

  // jobNames: ["job_name1", "job_name2", ...] (sorted)
  const jobNames = _(buildData)
    .map("job_name")
    .concat(_.map(stepsData, "job_name"))
    .uniq()
    .sortBy()
    .value();

  const { series: stepsDataSeries, xAxis: stepsDataxAxis } = convertToSeries(
    stepsData ?? [],
    selectedJobs
  );

  useEffect(() => {
    setSelectedJobs(
      jobNames.reduce((acc, jobName) => {
        acc[jobName] = true;
        return acc;
      }, {} as any)
    );
  }, [buildDataIsLoading, buildData, stepsData]);

  const BuildTimesChart = useMemo(() => {
    // groupedData: {bucket: <bucket>, job_name1: <duration>, job_name2: <duration>, ...}[]
    const groupedData = _(buildData)
      .groupBy("bucket")
      .map((value, key) => {
        return {
          bucket: key,
          ..._(jobNames)
            .map((jobName) => {
              const jobData = value.find((d) => d.job_name === jobName);
              return [jobName, jobData?.duration_sec ?? null];
            })
            .fromPairs()
            .value(),
        };
      })
      .sortBy("bucket")
      .value();

    return (
      <TimeSeriesPanelWithData
        onEvents={{
          legendselectchanged: (e: any) => {
            setSelectedBuild(e.name);
            setSelectedJobs(e.selected);
          },
          legendselectall: (e: any) => {
            setSelectedJobs(e.selected);
          },
          legendinverseselect: (e: any) => {
            setSelectedJobs(e.selected);
          },
        }}
        data={groupedData}
        series={jobNames.map((jobName) => ({
          name: jobName,
          type: "line",
          encode: {
            x: "bucket",
            y: jobName,
          },
          smooth: true,
          connectNulls: true,
        }))}
        groupByFieldName={"job_name"}
        title={"Avg Build Times"}
        yAxisRenderer={(value: any) => durationDisplay(value)}
        additionalOptions={{
          tooltip: {
            trigger: "item",
            formatter: function (params: any) {
              return `${formatTimeForCharts(params.data.bucket)}<br>${
                params.seriesName
              }: ${durationDisplay(params.data[params.seriesName])}`;
            },
          },
          legend: {
            selected: selectedJobs,
          },
          animation: false,
        }}
      />
    );
  }, [buildData, selectedJobs]);

  const SccacheStats = useMemo(() => {
    if (selectedBuild == null) {
      return <Typography>Select a build to view sccache stats</Typography>;
    }
    if (
      selectedBuildSccacheStats == null ||
      selectedBuildSccacheStats.length === 0
    ) {
      return <Typography>No data for {selectedBuild}</Typography>;
    }
    const fields = Object.keys(selectedBuildSccacheStats[0].avgStats).filter(
      (field) => !field.endsWith("_nanos")
    );

    // Group the fields into categories since a lot of them are related
    interface DisplayGroup {
      name: string;
      displayOrder: number;
      conditionOrder: number;
      condition: (field: string) => boolean;
    }

    const groups: DisplayGroup[] = [
      {
        name: "General",
        displayOrder: 0,
        conditionOrder: 10,
        condition: (_f: string) => true,
      },
      {
        name: "Not cached",
        displayOrder: 1,
        conditionOrder: 3,
        condition: (field: string) => field.startsWith("not_cached"),
      },
      {
        name: "Cache misses",
        displayOrder: 2,
        conditionOrder: 2,
        condition: (field: string) => field.startsWith("cache_misses"),
      },
      {
        name: "Cache hits",
        displayOrder: 3,
        conditionOrder: 1,
        condition: (field: string) => field.startsWith("cache_hits"),
      },
      {
        name: "Cache errors",
        displayOrder: 4,
        conditionOrder: 0,
        condition: (field: string) => field.startsWith("cache_errors"),
      },
    ];

    // Put each field into a group based on the conditionOrder and the condition
    const groupedFields = _(fields)
      .groupBy((field) => {
        const group = _(groups)
          .sortBy("conditionOrder")
          .find((group) => group.condition(field));
        return group?.name ?? "Other";
      })
      .value();

    const suffixes = ["avg", "max", "min", "med"];
    // Flatten the data for easier consumption by the TimeSeriesPanel
    selectedBuildSccacheStats.map((d: any) => {
      suffixes.forEach((suffix) => {
        _(d[`${suffix}Stats`]).forEach((value, key) => {
          d[`${key}_${suffix}`] = value;
        });
      });
      return d;
    });

    function Panel({ field }: { field: string }) {
      return (
        <Grid2 size={{ xs: 4 }} key={field} height={200}>
          <TimeSeriesPanelWithData
            data={_.sortBy(selectedBuildSccacheStats, "bucket")}
            series={suffixes.map((suffix) => ({
              name: `${suffix}`,
              type: "line",
              encode: {
                x: "bucket",
                y: `${field}_${suffix}`,
              },
              smooth: true,
            }))}
            title={field}
            yAxisRenderer={(value: any) => value} // not relevantß
            additionalOptions={{
              tooltip: {
                trigger: "axis",
                formatter: function (params: any) {
                  const data = params[0].value;
                  const suffixInfo = ["avg", "max", "min", "med"]
                    .map(
                      (suffix) =>
                        `${field}_${suffix}: ${data[`${field}_${suffix}`]}`
                    )
                    .join("<br>");

                  return `${formatTimeForCharts(data.bucket)}<br>${suffixInfo}`;
                },
              },
            }}
          />
        </Grid2>
      );
    }

    return (
      <Stack>
        <Typography variant="h5">Sccache Stats for {selectedBuild}</Typography>
        {_(groups)
          .sortBy("displayOrder")
          .map((group) => (
            <Grid2 size={{ xs: 12 }} key={group.name}>
              <Typography variant="h6">{group.name}</Typography>
              <Grid2 container spacing={2}>
                {groupedFields[group.name]?.map((field: string) => (
                  <Panel field={field} key={field} />
                ))}
              </Grid2>
            </Grid2>
          ))
          .value()}
      </Stack>
    );
  }, [selectedBuildSccacheStats]);

  return (
    <Stack>
      <Typography variant="h4">Build Time Metrics</Typography>
      <Typography>This page shows various stats for builds in CI</Typography>
      <Stack direction="row">
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Stack>
      <Grid2 container spacing={2}>
        <Grid2 size={{ xs: 10 }}>
          {stepsDataIsLoading ? (
            <LoadingPage height={400} />
          ) : (
            <BarChart
              height={400}
              series={stepsDataSeries}
              xAxis={stepsDataxAxis as any}
              onAxisClick={(_e, d) => setSelectedBuild(d?.axisValue as string)}
              skipAnimation={true}
            />
          )}
          <Box height={400}>
            {buildDataIsLoading ? (
              <LoadingPage height={400} />
            ) : (
              BuildTimesChart
            )}
          </Box>
        </Grid2>
        <Grid2 size={{ xs: 2 }} style={{ overflowY: "scroll", maxHeight: 800 }}>
          <CheckBoxList
            items={selectedJobs}
            onChange={setSelectedJobs}
            onClick={setSelectedBuild}
          />
        </Grid2>
        <Grid2 size={{ xs: 12 }}>
          <Stack>
            <Box>
              <Button onClick={() => setOpenSccacheStats(!openSccacheStats)}>
                {openSccacheStats ? "Hide" : "Show"} Sccache Stats
              </Button>
            </Box>
            {openSccacheStats &&
              (selectedBuildSccacheStatsIsLoading ? (
                <LoadingPage />
              ) : (
                SccacheStats
              ))}
          </Stack>
        </Grid2>
      </Grid2>
    </Stack>
  );
}
