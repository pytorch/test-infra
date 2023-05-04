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

const ROW_HEIGHT = 500;

export default function GenerateIndividualTestsLeaderboard({
  oncallName = "%",
  workflowName,
  queryDate,
  thresholdInSecond,
  classname = "%",
}: {
  oncallName?: string;
  workflowName: string;
  queryDate: dayjs.Dayjs;
  thresholdInSecond: number;
  classname?: string;
}) {
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
        title={`Longest Tests on Runner: ${workflowName} on ${queryDate.format(
          "YYYY-MM-DD"
        )}`}
        queryCollection={"commons"}
        queryName={"test_time_per_oncall"}
        queryParams={queryParamsForLongTestTable}
        columns={[
          {
            field: "test_name",
            headerName: "Test Name",
            flex: 1,
            filterable: false,
          },
          {
            field: "test_class",
            headerName: "Test class",
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
            headerName: "Avg duration",
            flex: 1,
            valueFormatter: (params: GridValueFormatterParams<number>) =>
              durationDisplay(params.value),
            filterable: false,
          },
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
        ]}
        dataGridProps={{
          getRowId: (e: any) =>
            e.oncall + e.date + e.workflow_name + e.time_in_seconds,
          initialState: {},
        }}
      />
    </Grid>
  );
}
