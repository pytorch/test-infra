import { RocksetParam } from "lib/rockset";
import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import {
  Granularity,
  TimeSeriesPanelWithData,
  seriesWithInterpolatedTimes,
} from "components/metrics/panels/TimeSeriesPanel";
import { augmentData } from "lib/benchmark/compilerUtils";
import { Grid, Skeleton } from "@mui/material";
import dayjs from "dayjs";
import {
  COMMIT_TO_WORKFLOW_ID,
  WORKFLOW_ID_TO_COMMIT,
} from "components/benchmark/BranchAndCommitPicker";
import { TIME_FIELD_NAME } from "components/benchmark/common";
import { CompilerPerformanceData } from "lib/types";

const GRAPH_ROW_HEIGHT = 245;
// The number of digit after decimal to display on the detail page
const SCALE = 4;

export function GraphPanel({
  queryParams,
  granularity,
  compiler,
  model,
  branch,
  lCommit,
  rCommit,
}: {
  queryParams: RocksetParam[];
  granularity: Granularity;
  compiler: string;
  model: string;
  branch: string;
  lCommit: string;
  rCommit: string;
}) {
  const queryCollection = "inductor";
  const queryName = "compilers_benchmark_performance";

  const queryParamsWithBranch: RocksetParam[] = [
    {
      name: "branches",
      type: "string",
      value: branch,
    },
    ...queryParams,
  ];
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParamsWithBranch)
  )}`;

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });
  data = augmentData(data);

  if (data === undefined || data.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  if (model === undefined) {
    return <></>;
  }

  // Clamp to the nearest granularity (e.g. nearest hour) so that the times will
  // align with the data we get from Rockset
  const startTime = dayjs(
    queryParams.find((p) => p.name === "startTime")?.value
  ).startOf(granularity);
  const stopTime = dayjs(
    queryParams.find((p) => p.name === "stopTime")?.value
  ).startOf(granularity);

  // Only show records between these twos
  const lWorkflowId = COMMIT_TO_WORKFLOW_ID[lCommit];
  const rWorkflowId = COMMIT_TO_WORKFLOW_ID[rCommit];

  const groupByFieldName = "name";
  const chartData = data
    .filter((record: CompilerPerformanceData) => record.name == model)
    .filter((record: CompilerPerformanceData) => {
      const id = record.workflow_id;
      return (
        (id >= lWorkflowId && id <= rWorkflowId) ||
        (id <= lWorkflowId && id >= rWorkflowId)
      );
    })
    .map((record: CompilerPerformanceData) => {
      record.speedup = Number(record.speedup.toFixed(SCALE));
      record.compilation_latency = Number(
        record.compilation_latency.toFixed(0)
      );
      record.compression_ratio = Number(
        record.compression_ratio.toFixed(SCALE)
      );
      record.abs_latency = Number(record.abs_latency.toFixed(SCALE));
      // Truncate the data to make it consistent with the display value
      return record;
    });

  const geomeanSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "speedup",
    false
  );
  const compTimeSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compilation_latency",
    false
  );
  const memorySeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "compression_ratio",
    false
  );
  const absTimeSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "abs_latency",
    false
  );
  const peakMemoryUsageTimeSeries = seriesWithInterpolatedTimes(
    chartData,
    startTime,
    stopTime,
    granularity,
    groupByFieldName,
    TIME_FIELD_NAME,
    "dynamo_peak_mem",
    false
  );

  return (
    <>
      <div>
        <h2>Details for {model}</h2>
        <Grid container spacing={2}>
          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={geomeanSeries}
              title={`Speedup`}
              groupByFieldName={groupByFieldName}
              yAxisRenderer={(unit) => {
                return `${unit.toFixed(SCALE)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(SCALE);
                  },
                },
              }}
            />
          </Grid>

          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={compTimeSeries}
              title={`Mean compilation time`}
              groupByFieldName={groupByFieldName}
              yAxisLabel={"second"}
              yAxisRenderer={(unit) => {
                return `${unit.toFixed(0)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(0);
                  },
                },
              }}
            />
          </Grid>

          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={memorySeries}
              title={`Peak memory footprint compression ratio`}
              groupByFieldName={groupByFieldName}
              yAxisRenderer={(unit) => {
                return `${unit.toFixed(SCALE)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(SCALE);
                  },
                },
              }}
            />
          </Grid>

          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={absTimeSeries}
              title={`Absolute execution time`}
              groupByFieldName={groupByFieldName}
              yAxisLabel={"millisecond"}
              yAxisRenderer={(unit) => {
                return `${unit.toFixed(SCALE)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(SCALE);
                  },
                },
              }}
            />
          </Grid>

          <Grid item xs={12} lg={4} height={GRAPH_ROW_HEIGHT}>
            <TimeSeriesPanelWithData
              data={chartData}
              series={peakMemoryUsageTimeSeries}
              title={"Dynamo peak mem usage"}
              groupByFieldName={groupByFieldName}
              yAxisLabel={"GB"}
              yAxisRenderer={(unit) => {
                return `${unit.toFixed(SCALE)}`;
              }}
              additionalOptions={{
                yAxis: {
                  scale: true,
                },
                label: {
                  show: true,
                  align: "left",
                  formatter: (r: any) => {
                    return Number(r.value[1]).toFixed(SCALE);
                  },
                },
              }}
            />
          </Grid>
        </Grid>
      </div>
      <div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Commit</th>
              <th>Accuracy</th>
              <th>Speedup</th>
              <th>Comptime</th>
              <th>MemoryCompression</th>
              <th>AbsLatency</th>
              <th>DynamoPeakMemory</th>
            </tr>
          </thead>
          <tbody>
            {chartData.map((entry: any, index: number) => {
              let commit = WORKFLOW_ID_TO_COMMIT[entry.workflow_id];
              return (
                <tr key={index}>
                  <td>{entry.granularity_bucket}</td>
                  <td>
                    <code>
                      <a
                        onClick={() => navigator.clipboard.writeText(commit)}
                        className="animate-on-click"
                      >
                        {commit}
                      </a>
                    </code>
                  </td>
                  <td>{entry.accuracy}</td>
                  <td>{entry.speedup}</td>
                  <td>{entry.compilation_latency}</td>
                  <td>{entry.compression_ratio}</td>
                  <td>{entry.abs_latency}</td>
                  <td>{entry.dynamo_peak_mem}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div>
          Tip: to view all commits between two commits, run{" "}
          <code>git log --oneline START..END</code> (NB: this will exclude the
          START commit itself, which is typically what you want.)
        </div>
      </div>
    </>
  );
}
