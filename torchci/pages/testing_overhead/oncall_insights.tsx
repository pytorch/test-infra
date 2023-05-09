import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import { useState } from "react";
import { useRouter } from "next/router";
import TablePanel from "components/metrics/panels/TablePanel";
import { durationDisplay } from "components/TimeUtils";
import {
  GridRenderCellParams,
  GridValueFormatterParams,
} from "@mui/x-data-grid";
import GenerateIndividualTestsLeaderboard from "components/metrics/panels/GenerateIndividualTestsLeaderboard";
import WorkflowPicker, {
  WORKFLOWS,
} from "components/metrics/panels/WorkflowPicker";

const ROW_HEIGHT = 500;
const THRESHOLD_IN_SECOND = 60;

function GenerateOncallTestInsightsOverviewTable({
  workflowName,
}: {
  workflowName: string;
}) {
  const router = useRouter();
  const oncall = router.query.oncall as string;
  const [startTime, setStartTime] = useState(dayjs().subtract(2, "day"));
  const queryParams: RocksetParam[] = [
    {
      name: "queryDate",
      type: "string",
      value: startTime,
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
    },
    {
      name: "oncall",
      type: "string",
      value: `${oncall}`,
    },
  ];

  return (
    <Grid item xs={12} height={ROW_HEIGHT}>
      <TablePanel
        title={`Total Testing Times per Workflow on all Runners: ${workflowName} on ${startTime.format(
          "YYYY-MM-DD"
        )}`}
        queryCollection={"commons"}
        queryName={"individual_test_stats_per_workflow_per_oncall"}
        queryParams={queryParams}
        columns={[
          {
            field: "avg_duration_in_second",
            headerName: "avg_duration_in_second",
            flex: 1,
            valueFormatter: (params: GridValueFormatterParams<number>) =>
              durationDisplay(params.value),
            filterable: false,
          },
          {
            field: "est_cost_per_run",
            headerName: "Estimated cost per workflow run on all runners",
            flex: 1,
            valueFormatter: (params: GridValueFormatterParams<number>) =>
              `$${params.value.toFixed(2)}`,
            filterable: false,
          },
          {
            field: "est_cost_per_day",
            headerName: "Estimated cost per day on all runners",
            flex: 1,
            valueFormatter: (params: GridValueFormatterParams<number>) =>
              `$${params.value.toFixed(2)}`,
            filterable: false,
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
        ]}
        dataGridProps={{
          getRowId: (e: any) => e.test_file + e.test_class,
          initialState: {},
        }}
      />
    </Grid>
  );
}

export default function TestingOverhead() {
  const router = useRouter();
  const oncall = router.query.oncall as string;
  // Looking at data from the past six months
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "month"));
  const [endTime, setEndTime] = useState(dayjs());
  const [workflow, setWorkFlow] = useState<string>(Object.keys(WORKFLOWS)[0]);
  return (
    <>
      <>
        <Grid container spacing={1}>
          <WorkflowPicker workflow={workflow} setWorkFlow={setWorkFlow} />
          <Grid item xs={24} lg={12} height={ROW_HEIGHT}>
            <TimeSeriesPanel
              title={`Total Time per Workflow for ${oncall} jobs on all runners`}
              queryName={"test_time_per_oncall"}
              queryCollection={"commons"}
              queryParams={[
                {
                  name: "oncall",
                  type: "string",
                  value: `${oncall}`,
                },
                {
                  name: "startDate",
                  type: "string",
                  value: startTime,
                },
                {
                  name: "endDate",
                  type: "string",
                  value: endTime,
                },
                {
                  name: "workflow_type",
                  type: "string",
                  value: "%",
                },
              ]}
              granularity={"day"}
              timeFieldName={"granularity_bucket"}
              yAxisFieldName={"time_in_seconds"}
              yAxisLabel={"Avg test time (s)"}
              yAxisRenderer={(unit) => durationDisplay(unit)}
              groupByFieldName={"workflow_type"}
              additionalOptions={{ yAxis: { scale: true } }}
            />
          </Grid>
        </Grid>
      </>

      <Grid container spacing={4}>
        <GenerateOncallTestInsightsOverviewTable workflowName={workflow} />
        <GenerateIndividualTestsLeaderboard
          workflowName={workflow}
          thresholdInSecond={THRESHOLD_IN_SECOND}
          oncallName={oncall}
        />
      </Grid>
    </>
  );
}
