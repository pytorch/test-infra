import { Grid } from "@mui/material";
import TimeSeriesPanel from "components/metrics/panels/TimeSeriesPanel";
import dayjs from "dayjs";
import { RocksetParam } from "lib/rockset";
import { useState } from "react";

const ROW_HEIGHT = 240;

export default function Kpis() {
    // Start looking at data from 6 weeks in to avoid outlier data from the start of the year
    const [startTime, setStartTime] = useState(dayjs().startOf("year").add(6, 'week'));
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
            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                title={"Avg Time To Signal - E2E (Weekly)"}
                queryName={"time_to_signal"}
                queryCollection={"pytorch_dev_infra_kpis"}
                queryParams={[
                    {
                        name: "buildOrAll",
                        type: "string",
                        value: "all",
                    },
                    ...timeParams,
                ]}
                granularity={"week"}
                timeFieldName={"week_bucket"}
                yAxisFieldName={"avg_tts"}
                yAxisLabel={"Hours"}
                yAxisRenderer={(unit) => `${unit}`}
                />
            </Grid>

            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                title={"Avg Time To Signal - Builds only (Weekly)"}
                queryName={"time_to_signal"}
                queryCollection={"pytorch_dev_infra_kpis"}
                queryParams={[
                    {
                        name: "buildOrAll",
                        type: "string",
                        value: "build",
                    },
                    ...timeParams,
                ]}
                granularity={"week"}
                timeFieldName={"week_bucket"}
                yAxisFieldName={"avg_tts"}
                yAxisLabel={"Hours"}
                yAxisRenderer={(unit) => `${unit}`}
                />
            </Grid>

            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                title={"# of Commits Red on Trunk (Weekly)"}
                queryName={"num_reverts"}
                queryCollection={"pytorch_dev_infra_kpis"}
                queryParams={[
                    ...timeParams,
                ]}
                granularity={"week"}
                timeFieldName={"bucket"}
                yAxisFieldName={"num"}
                yAxisRenderer={(unit) => `${unit}`}
                />
            </Grid>

            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                title={"% of Commits Red on Trunk (Weekly)"}
                queryName={"master_commit_red_percent"}
                queryCollection={"metrics"}
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

            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                title={"% Jobs Red (Weekly)"}
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

            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
                <TimeSeriesPanel
                title={"# of Force Merges (Weekly)"}
                queryName={"number_of_force_pushes_historical"}
                queryCollection={"pytorch_dev_infra_kpis"}
                queryParams={[
                    ...timeParams,
                ]}
                granularity={"week"}
                timeFieldName={"bucket"}
                yAxisFieldName={"count"}
                yAxisRenderer={(unit) => `${unit}`}
                />
            </Grid>
            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
              <TimeSeriesPanel
                title={"viable/strict Lag (Daily)"}
                queryName={"strict_lag_historical"}
                queryCollection={"pytorch_dev_infra_kpis"}
                queryParams={[...timeParams]}
                granularity={"day"}
                timeFieldName={"push_time"}
                yAxisFieldName={"diff_hr"}
                yAxisLabel={"Hours"}
                yAxisRenderer={(unit) => `${unit}`}
                // some outliers make this graph hard to read, so set a maximum yaxis˚
                ymax={7}
              />
            </Grid>
            <Grid item xs={12} lg={6} height={ROW_HEIGHT}>
              <TimeSeriesPanel
                title={"viable/strict Lag (Per Commit)"}
                queryName={"strict_lag_historical"}
                queryCollection={"pytorch_dev_infra_kpis"}
                queryParams={[...timeParams]}
                granularity={"milliseconds"}
                timeFieldName={"push_time"}
                yAxisFieldName={"diff_hr"}
                yAxisLabel={"Hours"}
                yAxisRenderer={(unit) => `${unit}`}
                // some outliers make this graph hard to read, so set a maximum yaxis˚
                ymax={7}
              />
            </Grid>
        </Grid>
    );
}
