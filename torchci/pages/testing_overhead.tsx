import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
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

    return (
        <><Grid container spacing={1}>
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
                    yAxisLabel={"Seconds"}
                    yAxisRenderer={(unit) => unit}
                    groupByFieldName={"workflow_type"}
                    additionalOptions={{ yAxis: { scale: true } }} />
            </Grid>
            </Grid></> 
    );
}
