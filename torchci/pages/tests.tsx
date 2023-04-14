import dayjs from "dayjs";
import {
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import {
  GridRenderCellParams,
  GridValueFormatterParams,
} from "@mui/x-data-grid";
import { TimeRangePicker } from "./metrics";
import TablePanel from "components/metrics/panels/TablePanel";
import { durationDisplay } from "components/TimeUtils";
import { RocksetParam } from "lib/rockset";

import { useState } from "react";

const ROW_HEIGHT = 500;
const THRESHOLD_IN_SECOND = 60;

function GenerateTestInsightsOverviewTable({
  workflowName,
  startTime,
  stopTime,
}: {
  workflowName: string,
  startTime : dayjs.Dayjs,
  stopTime: dayjs.Dayjs,
}) {
  const queryParams: RocksetParam[] = [
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
      name: "workflowName",
      type: "string",
      value: workflowName,
    },
    {
      name: "thresholdInSecond",
      type: "int",
      value: THRESHOLD_IN_SECOND,
    }
  ];

  return (
    <Grid item xs={12} height={ROW_HEIGHT}>
      <TablePanel
        title={"Workflow: " + workflowName}
        queryCollection={"commons"}
        queryName={"test_insights_overview"}
        queryParams={queryParams}
        columns={[
          {
            field: "avg_duration_in_second",
            headerName: "Avg duration",
            flex: 1,
            valueFormatter: (params: GridValueFormatterParams<number>) =>
              durationDisplay(params.value),
            filterable: false,
          },
          {
            field: "avg_tests",
            headerName: "# Test cases",
            flex: 1,
            filterable: false,
          },
          {
            field: "job_name",
            headerName: "Full job name",
            flex: 1,
          },
          {
            field: "simplified_job_name",
            headerName: "Job name",
            flex: 1,
            valueGetter: (params) => {
              const match = params.row.job_name.match(
                new RegExp("^(.+)\\s\\/\\s.+$")
              );
              return match ? match[1] : params.value;
            },
          },
          {
            field: "shard",
            headerName: "Shard",
            flex: 1,
            valueGetter: (params) => {
              const match = params.row.job_name.match(
                new RegExp("^.+\\s\\/\\s.+\\(([^,]+),\\s([^,]+),.+\\)$")
              );
              return match ? `${match[1]} (${match[2]})`: params.row.job_name;
            },
          },
          {
            field: "runner",
            headerName: "Runner",
            flex: 1,
            valueGetter: (params) => {
              const match = params.row.job_name.match(
                new RegExp("^.+,\\s([^,]+)\\)$")
              );
              return match ? `${match[1]}`: params.row.job_name;
            }
          },
          {
            field: "test_file",
            headerName: "Test file",
            flex: 1,
          },
          {
            field: "test_class",
            headerName: "Test class",
            flex: 1,
            renderCell: (params: GridRenderCellParams<string>) => {
              const jobName = encodeURIComponent(params.row.job_name);
              const testFile = params.row.test_file;
              const testClass = params.value;
              const detailParams = `workflowName=${workflowName}&jobName=${jobName}&testFile=${testFile}&testClass=${testClass}`;

              return (
                <a href={`/test/insights?${detailParams}`}>
                  {testClass}
                </a>
              );
            }
          },
          {
            field: "max_failures",
            headerName: "# Test failures",
            flex: 1,
            filterable: false,
          },
          {
            field: "max_errors",
            headerName: "# Unexpected errors",
            flex: 1,
            filterable: false,
          },
          {
            field: "avg_skipped",
            headerName: "# Test skipped",
            flex: 1,
            filterable: false,
          },
        ]}
        dataGridProps={{
          getRowId: (e: any) => e.job_name + e.test_file + e.test_class,
          initialState: {
            columns: {
              columnVisibilityModel: {
                job_name: false,
              }
            }
          },
        }}
      />
    </Grid>
  );
}

export default function GatherTestsInfo() {
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Test Insights
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Stack>

      <Grid container spacing={4}>
        <GenerateTestInsightsOverviewTable
          workflowName={"pull"}
          startTime={startTime}
          stopTime={stopTime}
        />

        <GenerateTestInsightsOverviewTable
          workflowName={"trunk"}
          startTime={startTime}
          stopTime={stopTime}
        />

        <GenerateTestInsightsOverviewTable
          workflowName={"periodic"}
          startTime={startTime}
          stopTime={stopTime}
        />

        <GenerateTestInsightsOverviewTable
          workflowName={"inductor"}
          startTime={startTime}
          stopTime={stopTime}
        />
      </Grid>
    </div>
  );
}
