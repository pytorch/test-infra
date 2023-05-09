import dayjs from "dayjs";
import { Grid } from "@mui/material";
import {
  GridRenderCellParams,
  GridValueFormatterParams,
} from "@mui/x-data-grid";
import TablePanel from "components/metrics/panels/TablePanel";
import { durationDisplay } from "components/TimeUtils";
import { RocksetParam } from "lib/rockset";
import { useRouter } from "next/router";
import { useState } from "react";

const ROW_HEIGHT = 500;

export default function GenerateIndividualTestsLeaderboard({
  oncallName = "%",
  workflowName,
  thresholdInSecond,
  classname = "%",
}: {
  oncallName?: string;
  workflowName: string;
  thresholdInSecond: number;
  classname?: string;
}) {
  const [queryDate, setQueryDate] = useState(dayjs().subtract(2, "day"));
  const router = useRouter();
  const queryParamsForLongTestTable: RocksetParam[] = [
    {
      name: "oncall",
      type: "string",
      value: oncallName,
    },
    {
      name: "queryDate",
      type: "string",
      value: queryDate,
    },
    {
      name: "workflow_name",
      type: "string",
      value: workflowName,
    },
    {
      name: "thresholdInSecond",
      type: "int",
      value: thresholdInSecond,
    },
    {
      name: "classname",
      type: "string",
      value: classname,
    },
  ];
  return (
    <Grid item xs={12} height={ROW_HEIGHT}>
      <TablePanel
        title={`Longest Tests: ${workflowName} on ${queryDate.format(
          "YYYY-MM-DD"
        )}`}
        queryCollection={"commons"}
        queryName={"individual_test_times_per_oncall_per_workflow"}
        queryParams={queryParamsForLongTestTable}
        columns={[
          {
            field: "oncall",
            headerName: "Oncall",
            flex: 1,
            renderCell: (params: GridRenderCellParams<string>) => {
              const oncall = params.value;
              return (
                <a href={`/testing_overhead/oncall_insights?oncall=${oncall}`}>
                  {oncall}
                </a>
              );
            },
          },
          {
            field: "test_name",
            headerName: "Test Name",
            flex: 1,
            filterable: false,
          },
          {
            field: "test_class",
            headerName: "Test Class",
            flex: 1,
            renderCell: (params: GridRenderCellParams<string>) => {
              const testFile = params.row.test_file;
              const testClass = params.value;
              return (
                <a
                  href={`/testing_overhead/insights?testFile=${testFile}&testClass=${testClass}`}
                >
                  {testClass}
                </a>
              );
            },
          },
          {
            field: "test_file",
            headerName: "Test File",
            flex: 1,
            filterable: false,
          },
          {
            field: "avg_time_in_seconds",
            headerName: "Avg Duration per Runner",
            flex: 1,
            valueFormatter: (params: GridValueFormatterParams<number>) =>
              durationDisplay(params.value),
            filterable: false,
          },
          {
            field: "time_per_wokflow_in_seconds",
            headerName: "Total Duration per Workflow",
            flex: 1,
            valueFormatter: (params: GridValueFormatterParams<number>) =>
              durationDisplay(params.value),
            filterable: false,
          },
        ]}
        dataGridProps={{
          getRowId: (e: any) =>
            e.oncall +
            e.workflow_name +
            e.test_file +
            e.test_class +
            e.test_name,
          initialState: {},
        }}
      />
    </Grid>
  );
}
