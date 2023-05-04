import dayjs from "dayjs";
import { Grid } from "@mui/material";
import {
  GridRenderCellParams,
  GridValueFormatterParams,
} from "@mui/x-data-grid";
import TablePanel from "components/metrics/panels/TablePanel";
import { durationDisplay } from "components/TimeUtils";
import { RocksetParam } from "lib/rockset";

const ROW_HEIGHT = 500;

export default function GenerateTestInsightsOverviewTable({
  workflowName,
  startTime,
  stopTime,
  thresholdInSeconds,
  testFile = "%",
  testClass = "%",
}: {
  workflowName: string;
  startTime: dayjs.Dayjs;
  stopTime: dayjs.Dayjs;
  thresholdInSeconds: number;
  testFile?: string;
  testClass?: string;
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
      value: thresholdInSeconds,
    },
    {
      name: "testFile",
      type: "string",
      value: testFile,
    },
    {
      name: "testClass",
      type: "string",
      value: testClass,
    },
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
              return match ? `${match[1]} (${match[2]})` : params.row.job_name;
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
              return match ? `${match[1]}` : params.row.job_name;
            },
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
              const testFile_param = params.row.test_file;
              const testClass_param = params.value;
              const detailParams = `workflowName=${workflowName}&jobName=${jobName}&testFile=${testFile_param}&testClass=${testClass_param}`;

              return (
                <a href={`/test/insights?${detailParams}`}>{testClass_param}</a>
              );
            },
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
              },
            },
          },
        }}
      />
    </Grid>
  );
}
