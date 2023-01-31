import dayjs from "dayjs";
import ReactECharts from "echarts-for-react";
import { EChartsOption } from "echarts";
import useSWR from "swr";
import _ from "lodash";
import {
  FormControl,
  Grid,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { useRouter } from "next/router";
import { useCallback, useRef, useState } from "react";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import {
  Granularity,
  getTooltipMarker,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import React from "react";
import { TimeRangePicker } from "../../../metrics";
import TablePanel from "components/metrics/panels/TablePanel";
import {
  GridRenderCellParams,
} from "@mui/x-data-grid";

const PRIMARY_WORKFLOWS = [
  "lint",
  "pull",
  "trunk",
];
const SECONDARY_WORKFLOWS = [
  "periodic",
  "inductor",
];
const UNSTABLE_WORKFLOWS = [
  "unstable",
];
const ROW_HEIGHT = 340;
const ROW_GAP = 30;
const URL_PREFIX = `/reliability/pytorch/pytorch?jobName=`;

// Specialized version of TablePanel for reliability metrics
function GroupReliabilityPanel({
  title,
  queryName,
  queryParams,
  metricHeaderName,
  metricName,
}: {
  title: string;
  queryName: string;
  queryParams: RocksetParam[];
  metricHeaderName: string;
  metricName: string;
}) {
  return (
    <TablePanel
      title={title}
      queryName={queryName}
      queryParams={queryParams}
      columns={[
        {
          field: metricName,
          headerName: metricHeaderName,
          flex: 1,
        },
        {
          field: "name",
          headerName: "Name",
          flex: 5,
          // valueFormatter only treat the return value as string, so we need
          // to use renderCell here to get the JSX
          renderCell: (params: GridRenderCellParams<string>) => {
            const jobName = params.value;
            if (jobName === undefined) {
              return `Invalid job name ${jobName}`;
            }

            const encodedJobName = encodeURIComponent(jobName);
            return (
              <a href={URL_PREFIX + encodedJobName}>
                {jobName}
              </a>
            );
          }
        },
      ]}
      dataGridProps={{ getRowId: (el: any) => el.name }}
    />
  );
}

function GraphPanel({
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
      min: 0,
      max: 100,
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
        `<br/>${dayjs(params.value[0]).local().format("M/D h:mm:ss A")}<br/>` +
        `${getTooltipMarker(params.color)}` +
        `<b>${params.value[1]}</b>`,
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

function Graphs({
  queryParams,
  granularity,
  checkboxRef,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  checkboxRef: any;
}) {
  const [filter, setFilter] = useState(new Set());

  const queryName = "master_commit_red_percent_groups";
  const url = `/api/query/metrics/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;
  const { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }
  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  function toggleFilter(e: any) {
    var jobName = e.target.id;
    const next = new Set(filter);
    if (filter.has(jobName)) {
      next.delete(jobName);
    } else {
      next.add(jobName);
    }
    setFilter(next);
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  const redFieldName = "red";
  const timeFieldName = "granularity_bucket";
  const groupByFieldName = "name";

  const redPercentages = seriesWithInterpolatedTimes(
    data,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    timeFieldName,
    redFieldName
  );
  const displayRedPercentages = redPercentages.filter((item: any) =>
    filter.has(item["name"])
  );

  return (
    <Grid container spacing={2}>
      <Grid item xs={9} height={ROW_HEIGHT}>
        <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
          <GraphPanel title={"%"} series={displayRedPercentages} />
        </Paper>
      </Grid>
      <Grid item xs={3} height={ROW_HEIGHT}>
        <div
          style={{ overflow: "auto", height: ROW_HEIGHT, fontSize: "15px" }}
          ref={checkboxRef}
        >
          {redPercentages.map((job) => (
            <div key={job["name"]}>
              <input
                type="checkbox"
                id={job[groupByFieldName]}
                onChange={toggleFilter}
                checked={filter.has(job[groupByFieldName])}
              />
              <label htmlFor={job[groupByFieldName]}>
                <a
                  href={
                    URL_PREFIX + encodeURIComponent(job[groupByFieldName])
                  }
                >
                  {job[groupByFieldName]}
                </a>
              </label>
            </div>
          ))}
        </div>
      </Grid>
    </Grid>
  );
}

function GranularityPicker({
  granularity,
  setGranularity,
}: {
  granularity: string;
  setGranularity: any;
}) {
  function handleChange(e: SelectChangeEvent<string>) {
    setGranularity(e.target.value);
  }
  return (
    <FormControl>
      <InputLabel id="granularity-select-label">Granularity</InputLabel>
      <Select
        value={granularity}
        label="Granularity"
        labelId="granularity-select-label"
        onChange={handleChange}
      >
        <MenuItem value={"month"}>month</MenuItem>
        <MenuItem value={"week"}>week</MenuItem>
        <MenuItem value={"day"}>day</MenuItem>
      </Select>
    </FormControl>
  );
}

export default function Page() {
  const router = useRouter();
  const jobName: string = (router.query.jobName as string) ?? "none";

  const [startTime, setStartTime] = useState(dayjs().subtract(1, "month"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [granularity, setGranularity] = useState<Granularity>("day");

  const queryParams: RocksetParam[] = [
    {
      name: "timezone",
      type: "string",
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
    {
      name: "granularity",
      type: "string",
      value: granularity,
    },
  ];

  const allWorkflows = PRIMARY_WORKFLOWS.concat(SECONDARY_WORKFLOWS).concat(UNSTABLE_WORKFLOWS);

  const checkboxRef = useCallback(() => {
    const selectedJob = document.getElementById(jobName);
    if (selectedJob != undefined) {
      selectedJob.click();
    }
  }, [jobName]);

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Failures
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
        />
        <GranularityPicker
          granularity={granularity}
          setGranularity={setGranularity}
        />
      </Stack>

      <Grid item xs={6} height={ROW_HEIGHT + ROW_GAP}>
        <Graphs
          queryParams={queryParams.concat([
            {
              name: "workflowNames",
              type: "string",
              value: allWorkflows.join(","),
            }
          ])}
          granularity={granularity}
          checkboxRef={checkboxRef}
        />
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={6} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={`Primary jobs (${PRIMARY_WORKFLOWS.join(", ")})`}
            queryName={"top_reds"}
            queryParams={queryParams.concat([
              {
                name: "workflowNames",
                type: "string",
                value: PRIMARY_WORKFLOWS.join(","),
              }
            ])}
            metricName={"red"}
            metricHeaderName={"Failures %"}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={`Secondary jobs (${SECONDARY_WORKFLOWS.join(", ")})`}
            queryName={"top_reds"}
            queryParams={queryParams.concat([
              {
                name: "workflowNames",
                type: "string",
                value: SECONDARY_WORKFLOWS.join(","),
              }
            ])}
            metricName={"red"}
            metricHeaderName={"Failures %"}
          />
        </Grid>

        <Grid item xs={6} height={ROW_HEIGHT}>
          <GroupReliabilityPanel
            title={"Unstable jobs"}
            queryName={"top_reds"}
            queryParams={queryParams.concat([
              {
                name: "workflowNames",
                type: "string",
                value: UNSTABLE_WORKFLOWS.join(","),
              }
            ])}
            metricName={"red"}
            metricHeaderName={"Failures %"}
          />
        </Grid>
      </Grid>
    </div>
  );
}
