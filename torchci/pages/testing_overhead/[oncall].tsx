import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import { useState } from "react";
import { useRouter } from "next/router";
const ROW_HEIGHT = 240;
export default function TestingOverhead() {
    const router = useRouter();
    const { oncall } = router.query;
    // Looking at data from the past six months
    const [startTime, setStartTime] = useState(dayjs().subtract(1, 'month'));

    const timeParams: RocksetParam[] = [
        {
        name: "startDate",
        type: "string",
        value: startTime,
        }
    ];

    return (
        <><Grid container spacing={1}>
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
                        ...timeParams,
                    ]}
                    granularity={"day"}
                    timeFieldName={"granularity_bucket"}
                    yAxisFieldName={"time_in_seconds"}
                    yAxisLabel={"Avg test time (s)"}
                    yAxisRenderer={(unit) => unit}
                    groupByFieldName={"workflow_type"}
                    additionalOptions={{ yAxis: { scale: true } }} />
            </Grid>
            </Grid></> 
    );
}
