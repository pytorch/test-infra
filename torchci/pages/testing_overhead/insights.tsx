import dayjs from "dayjs";
import {
  Grid,
  Stack,
  Typography,
} from "@mui/material";
import { TimeRangePicker } from "pages/metrics";

import { useState } from "react";
import GenerateTestInsightsOverviewTable  from "../../components/metrics/panels/GenerateTestInsightsOverviewTable";
import { useRouter } from "next/router";
const THRESHOLD_IN_SECOND = 60;

export default function IndividualTestInsights() {
    const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
    const [stopTime, setStopTime] = useState(dayjs());
    const [timeRange, setTimeRange] = useState<number>(7);

    const router = useRouter();
    const testFile = router.query.testFile as string;
    const testClass = router.query.testClass as string;
    return (
      <div>
        <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
          <Typography fontSize={"2rem"} fontWeight={"bold"}>
            Test Insights for {testFile}.{testClass}
          </Typography>
          <TimeRangePicker
            startTime={startTime}
            setStartTime={setStartTime}
            stopTime={stopTime}
            setStopTime={setStopTime}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
          />
        </Stack>

        <Grid container spacing={4}>
          <GenerateTestInsightsOverviewTable
            workflowName={"pull"}
            startTime={startTime}
            stopTime={stopTime}
            thresholdInSeconds={THRESHOLD_IN_SECOND}
            testFile={testFile}
            testClass={testClass}
          />

          <GenerateTestInsightsOverviewTable
            workflowName={"trunk"}
            startTime={startTime}
            stopTime={stopTime}
            thresholdInSeconds={THRESHOLD_IN_SECOND}
            testFile={testFile}
            testClass={testClass}
          />

          <GenerateTestInsightsOverviewTable
            workflowName={"periodic"}
            startTime={startTime}
            stopTime={stopTime}
            thresholdInSeconds={THRESHOLD_IN_SECOND}
            testFile={testFile}
            testClass={testClass}
          />

          <GenerateTestInsightsOverviewTable
            workflowName={"inductor"}
            startTime={startTime}
            stopTime={stopTime}
            thresholdInSeconds={THRESHOLD_IN_SECOND}
            testFile={testFile}
            testClass={testClass}
          />
        </Grid>
      </div>
    );
  }
