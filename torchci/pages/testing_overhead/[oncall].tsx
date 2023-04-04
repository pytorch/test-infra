import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import { useState } from "react";
import { useRouter } from "next/router";
import TablePanel from "components/metrics/panels/TablePanel";
import { durationDisplay } from "components/TimeUtils";
import { GridRenderCellParams, GridValueFormatterParams } from "@mui/x-data-grid";

const ROW_HEIGHT = 500;
const THRESHOLD_IN_SECOND = 60;
function GenerateTestInsightsOverviewTable({
    workflowName,
  }: {
    workflowName: string
  }) {
    const router = useRouter();
    const { oncall } = router.query;
    const [startTime, setStartTime] = useState(dayjs().subtract(1, 'day'));
    const queryParams: RocksetParam[] = [
      {
        name: "queryDate",
        type: "string",
        value:  startTime,
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
          title={`Workflow: ${workflowName}`}
          queryCollection={"commons"}
          queryName={"individual_test_stats_per_workflow_per_oncall"}
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
              field: "test_file",
              headerName: "Test file",
              flex: 1,
            },
            {
              field: "test_class",
              headerName: "Test class",
              flex: 1,
              filterable: false,
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
            getRowId: (e: any) => e.test_file + e.test_class,
            initialState: {
            },
          }}
        />
      </Grid>
    );
  }

export default function TestingOverhead() {
    const router = useRouter();
    const { oncall } = router.query;
    // Looking at data from the past six months
    const [startTime, setStartTime] = useState(dayjs().subtract(1, 'month'));

    return (
        <><><Grid container spacing={1}>
            <Grid item xs={24} lg={12} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                    title={`Average Time for Workflow for ${oncall} jobs`}
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
                        }
                    ]}
                    granularity={"day"}
                    timeFieldName={"granularity_bucket"}
                    yAxisFieldName={"time_in_seconds"}
                    yAxisLabel={"Avg test time (s)"}
                    yAxisRenderer={(unit) => durationDisplay(unit)}
                    groupByFieldName={"workflow_type"}
                    additionalOptions={{ yAxis: { scale: true } }} />
            </Grid>
        </Grid></><Grid container spacing={4}>
                <GenerateTestInsightsOverviewTable
                    workflowName={"pull"} />

                <GenerateTestInsightsOverviewTable
                    workflowName={"trunk"} />

                <GenerateTestInsightsOverviewTable
                    workflowName={"periodic"} />
            </Grid></>
    );
}
