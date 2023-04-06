import { Grid } from "@mui/material";
import { GridRenderCellParams, GridValueFormatterParams } from "@mui/x-data-grid";
import TablePanel from "components/metrics/panels/TablePanel";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import { durationDisplay } from "components/TimeUtils";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import { useState } from "react";

const ROW_HEIGHT = 240;

export default function TestingOverhead() {
    // Looking at data from the past six months
    const [startTime, setStartTime] = useState(dayjs().subtract(1, 'month'));

    const timeParams: RocksetParam[] = [
        {
        name: "startTime",
        type: "string",
        value: startTime,
        }
    ];

function GenerateOncallTestingOverheadLeaderboard({
    workflowName,
  }: {
    workflowName: string
  }) {
    const [startTime, setStartTime] = useState(dayjs().subtract(2, 'day'));
    const [endTime, setEndTime] = useState(dayjs().subtract(1, 'day'));
    const queryParams: RocksetParam[] = [
        {
            name: "oncall",
            type: "string",
            value: "%",
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
        value: workflowName,
    }
    ];
  
    return (
      <Grid item xs={12} height={ROW_HEIGHT}>
        <TablePanel
          title={`Unsharded Testing times for Workflow: ${workflowName} on ${startTime.format("YYYY-MM-DD")}`}
          queryCollection={"commons"}
          queryName={"test_time_per_oncall"}
          queryParams={queryParams}
          columns={[
            {
              field: "time_in_seconds",
              headerName: "Avg duration",
              flex: 1,
              valueFormatter: (params: GridValueFormatterParams<number>) =>
                durationDisplay(params.value),
              filterable: false,
            }, 
            {
                field: "percentage",
                headerName: "% of workflow time",
                flex: 1,
                valueFormatter: (params: GridValueFormatterParams<number>) =>
                  params.value + "%",
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
                  }
            },
          ]}
          dataGridProps={{
            getRowId: (e: any) => e.oncall + e.date + e.workflow_name + e.time_in_seconds,
            initialState: {
            },
          }}
        />
      </Grid>
    );
  }

    return (
        <><><Grid container spacing={1}>
            <Grid item xs={24} lg={12} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                    title={"Average Time for Workflow (excluding unstable and inductor)"}
                    queryName={"test_times_per_workflow_type"}
                    queryCollection={"commons"}
                    queryParams={[
                        {
                            name: "workflow_type",
                            type: "string",
                            value: "pull",
                        },
                        ...timeParams,
                    ]}
                    granularity={"day"}
                    timeFieldName={"granularity_bucket"}
                    yAxisFieldName={"time_in_seconds"}
                    yAxisLabel={"Avg test time (s)"}
                    yAxisRenderer={(unit) => durationDisplay(unit)}
                    groupByFieldName={"workflow_type"}
                    additionalOptions={{ yAxis: { scale: true } }} />
            </Grid>
        </Grid></><GenerateOncallTestingOverheadLeaderboard
                workflowName={"pull"} /><GenerateOncallTestingOverheadLeaderboard
                workflowName={"trunk"} /><GenerateOncallTestingOverheadLeaderboard
                workflowName={"periodic"} /></>
    );
}
