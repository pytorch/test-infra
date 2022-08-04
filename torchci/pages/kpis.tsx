import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import { useState } from "react";

const ROW_HEIGHT = 340;

export default function Kpis() {
    const [startTime, setStartTime] = useState(dayjs().startOf("year").add(1, 'month'));
    const [stopTime, setStopTime] = useState(dayjs());
        
    const timeParams: RocksetParam[] = [
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
    ];
    
    return (
        <Grid container spacing={2}>
            <Grid item xs={true} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                title={"Percent Jobs Red Over Time"}
                queryName={"master_jobs_red"}
                queryParams={[
                    ...timeParams,
                ]}
                granularity={"week"}
                timeFieldName={"granularity_bucket"}
                yAxisFieldName={"red"}
                yAxisRenderer={(unit) => {
                    return `${unit * 100} %`;
                }}
                />
            </Grid>
        </Grid>
    );
}