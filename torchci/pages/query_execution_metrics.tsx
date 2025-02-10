import {
  Checkbox,
  FormControlLabel,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { GridEventListener } from "@mui/x-data-grid";
import GranularityPicker from "components/GranularityPicker";
import TablePanel from "components/metrics/panels/TablePanel";
import {
  Granularity,
  TimeSeriesPanelWithData,
} from "components/metrics/panels/TimeSeriesPanel";
import { formatTimeForCharts } from "components/TimeUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useEffect, useState } from "react";
import { TimeRangePicker } from "./metrics";
dayjs.extend(utc);

function bytesRenderCell(val: number, useReadableMemory: boolean) {
  if (useReadableMemory) {
    if (val > 1024 * 1024 * 1024) {
      return `${(val / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
    }
    if (val > 1024 * 1024) {
      return `${(val / (1024 * 1024)).toFixed(2)} MiB`;
    }
    if (val > 1024) {
      return `${(val / 1024).toFixed(2)} KiB`;
    }
  }
  return `${val} B`;
}

export default function Page() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);
  const [expandedQuery, setExpandedQuery] = useState<string | null>(null);
  const [useReadableMemory, setUseReadableMemory] = useState<boolean>(true);
  const [granularity, setGranularity] = useState<Granularity>("hour");
  const [individualQueryData, setIndividualQueryData] = useState<any>(null);
  const timeParams = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  const onRowClick: GridEventListener<"rowClick"> = (
    params,
    _event,
    _details
  ) => {
    setExpandedQuery(params.id as string);
  };

  useEffect(() => {
    // Don't use swr since we don't need to refresh
    if (expandedQuery === null) {
      return;
    }
    fetch(
      `/api/clickhouse/query_execution_metrics_individual?parameters=${JSON.stringify(
        {
          query: expandedQuery,
          ...timeParams,
          granularity,
        }
      )}`
    )
      .then((response) => response.json())
      .then((data) => setIndividualQueryData(data))
      .catch((error) => console.error("Error:", error));
  }, [expandedQuery, stopTime, startTime, granularity]);

  const fields = [
    { field: "realTimeMSTotal", headerName: "Total Duration (ms)" },
    { field: "realTimeMSAvg", headerName: "Avg Duration (ms)" },
    { field: "realTimeMSP50", headerName: "p50 Duration (ms)" },
    { field: "memoryBytesTotal", headerName: "Total Memory (B)" },
    { field: "memoryBytesAvg", headerName: "Avg Memory (B)" },
    { field: "memoryBytesP50", headerName: "p50 Memory (B)" },
  ];

  const series = fields.map((field, index) => ({
    name: field.headerName,
    type: "line",
    yAxisIndex: index % 3 == 0 ? 0 : 1,
    encode: {
      x: "timestamp",
      y: field.field,
    },
    smooth: true,
  }));

  function IndividualQueryPanel({ type }: { type: "duration" | "memory" }) {
    // Graphs for memory or duration of a single named query
    const yAxisFormatter = (value: any) =>
      type === "memory"
        ? bytesRenderCell(value, useReadableMemory)
        : `${value} ms`;

    return (
      <Paper sx={{ height: 400 }} elevation={0}>
        <TimeSeriesPanelWithData
          data={individualQueryData}
          series={series.filter((s: any) =>
            s.name.toLowerCase().includes(type)
          )}
          title={type === "duration" ? "Duration" : "Memory"}
          groupByFieldName={"name"}
          yAxisLabel={"not relevant"}
          yAxisRenderer={(value: any) => value} // not relevantß
          additionalOptions={{
            tooltip: {
              trigger: "axis",
              formatter: function (params: any) {
                const data = params[0].value;
                const fieldInfo = fields
                  .filter((field) =>
                    field.headerName.toLowerCase().includes(type)
                  )
                  .map((field) =>
                    field.headerName.toLowerCase().includes("memory")
                      ? `${field.headerName}: ${bytesRenderCell(
                          data[field.field],
                          useReadableMemory
                        )}`
                      : `${field.headerName}: ${data[field.field]}`
                  )
                  .join("<br>");
                return `${formatTimeForCharts(data.time)}<br>${fieldInfo}`;
              },
            },
            yAxis: [
              {
                type: "value",
                name: "Total",
                alignTicks: true,
                position: "left",
                axisLabel: {
                  formatter: yAxisFormatter,
                },
              },
              {
                type: "value",
                name: "Individual",
                alignTicks: true,
                position: "right",
                axisLabel: {
                  formatter: yAxisFormatter,
                },
              },
            ],
          }}
        />
      </Paper>
    );
  }

  return (
    <Stack spacing={2}>
      <Typography variant="h4">
        ClickHouse Database Query Execution Time and Memory
      </Typography>
      <Typography>
        This page shows the execution time and memory usage of queries to the
        ClickHouse database. The data is collected from the system.query_log
        table in ClickHouse. Data prior to Jan 3, 2025 is invalid. Click on a
        row in the table to see information about a specific query.
      </Typography>
      <Stack direction="row" spacing={2}>
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
        <FormControlLabel
          label="Use human-readable memory units"
          control={
            <Checkbox
              checked={useReadableMemory}
              onClick={() => setUseReadableMemory(!useReadableMemory)}
            />
          }
        />
      </Stack>
      <div style={{ height: 400 }}>
        <TablePanel
          title="Time and Memory"
          queryName="query_execution_metrics"
          queryParams={timeParams}
          columns={[
            { field: "name", headerName: "Query", flex: 2 },
            { field: "num", headerName: "Count", flex: 1 },
            ...fields.map((field) => ({
              field: field.field,
              headerName: field.headerName,
              flex: 1,
              ...(field.field.includes("memory")
                ? {
                    renderCell: (param: any) =>
                      bytesRenderCell(param.value, useReadableMemory),
                  }
                : {}),
            })),
          ]}
          dataGridProps={{
            getRowId: (el: any) => el.name,
            onRowClick: onRowClick,
          }}
        />
      </div>
      {expandedQuery !== null && individualQueryData !== null && (
        <Stack spacing={2}>
          <Typography variant="h5">{expandedQuery}</Typography>
          <IndividualQueryPanel type="duration" />
          <IndividualQueryPanel type="memory" />
        </Stack>
      )}
    </Stack>
  );
}
