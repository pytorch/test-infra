import { Box, Stack, Typography } from "@mui/material";
import MergeAttemptFlow from "components/metrics/MergeAttemptFlow";
import dayjs from "dayjs";
import { TimeRangePicker } from "pages/metrics";
import { useState } from "react";

export default function MergeAnalysisPage() {
  const [startTime, setStartTime] = useState(dayjs().subtract(7, "day"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);

  const queryTimes = {
    startTime: startTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: stopTime.utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

  return (
    <Stack spacing={3} sx={{ p: 3 }}>
      <Box
        sx={{ display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap" }}
      >
        <Typography variant="h4" fontWeight="bold">
          Merge Analysis
        </Typography>
      </Box>

      <Typography variant="body2" color="text.secondary">
        Shows how PRs created in the selected range move from their initial
        merge command through successful landing or up to three retries.
        Default, <code>-i</code>, and <code>-f</code> attempts come directly
        from structured trymerge records; comment text is not parsed.
      </Typography>

      <Typography variant="body2" color="text.secondary">
        <strong>The range filters PR creation date, not attempt date.</strong>{" "}
        Counts are PRs, not attempts. A PR is in the cohort if it was created in
        the range and has at least one trymerge record; all of its attempts then
        count, including any made after the range ends. PRs created in the range
        with no attempt yet are absent.
      </Typography>

      <Typography variant="body2" color="text.secondary">
        <strong>
          <code>-f</code> and <code>-i</code> are raw flag usage
        </strong>{" "}
        (trymerge&apos;s <code>skip_mandatory_checks</code> and{" "}
        <code>ignore_current</code>), not the HUD force-merge KPI, which also
        requires the flag to have actually skipped or ignored something, so
        these lanes run wider.
      </Typography>

      <Typography variant="body2" color="text.secondary">
        <strong>&ldquo;No further attempt&rdquo;</strong> means no later
        trymerge record exists, not that the PR was abandoned. The bucket also
        holds PRs still in flight and PRs that landed by another route, such as
        an internal diff import or a stack member merged from its top PR.
      </Typography>

      <Box>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Box>

      <Box sx={{ width: "100%", overflowX: "auto" }}>
        <MergeAttemptFlow {...queryTimes} />
      </Box>
    </Stack>
  );
}
