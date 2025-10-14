import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import {
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import dayjs from "dayjs";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import { COLOR_ERROR, COLOR_HELP_ICON, COLOR_WARNING } from "./constants";

export default function UnreliableJobsTable({
  data,
}: {
  data: any[] | undefined;
}) {
  // Filter to jobs with failures and sort by failure rate
  const unreliableJobs = (data || [])
    .filter((job) => {
      const failureRate =
        (job.failed_count + job.soft_failed_count) /
        (job.non_canceled_count || 1);
      return failureRate > 0; // Only show jobs with some failures
    })
    .sort((a, b) => {
      const rateA =
        (a.failed_count + a.soft_failed_count) / (a.non_canceled_count || 1);
      const rateB =
        (b.failed_count + b.soft_failed_count) / (b.non_canceled_count || 1);
      return rateB - rateA; // Descending
    })
    .slice(0, 100); // Top 100 most unreliable

  // Fetch first failure data for these jobs (must be before any early returns)
  const jobNames = unreliableJobs.map((j) => j.job_name);
  const { data: firstFailureData } = useClickHouseAPIImmutable(
    "vllm/job_first_failure",
    {
      repo: "https://github.com/vllm-project/vllm.git",
      pipelineName: "CI",
      jobNames: jobNames,
      lookbackDays: 60, // Look back 60 days to find historical break points
    },
    jobNames.length > 0 // Only fetch if we have jobs
  );

  // Create a map of job name to first failure info
  const firstFailureMap = new Map();
  (firstFailureData || []).forEach((f: any) => {
    firstFailureMap.set(f.job_name, f);
  });

  // Early return if no unreliable jobs (after hooks are called)
  if (unreliableJobs.length === 0) {
    return (
      <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
        <Typography>No unreliable jobs found</Typography>
      </Paper>
    );
  }

  return (
    <Paper sx={{ p: 2, height: "100%", overflow: "auto" }} elevation={3}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 16,
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: "bold" }}>
          Most Unreliable Jobs
        </Typography>
        <Tooltip
          title="Top 100 jobs with highest failure rates. Success Rate = clean passes only (soft failures don't count). Recent Fail = most recent failure (hard or soft, last 60 days). First Break = where job transitioned from passing to failing (last 60 days). Click build numbers to investigate in Buildkite."
          arrow
          placement="top"
        >
          <HelpOutlineIcon
            sx={{ fontSize: "1.2rem", color: COLOR_HELP_ICON, cursor: "help" }}
          />
        </Tooltip>
      </div>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: "bold" }}>Job Name</TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                Success Rate
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                Hard Fails
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                Soft Fails
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                Recent Fail
              </TableCell>
              <TableCell align="center" sx={{ fontWeight: "bold" }}>
                First Break
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {unreliableJobs.map((job, index) => {
              const successRate =
                job.success_rate !== null && job.success_rate !== undefined
                  ? (job.success_rate * 100).toFixed(1) + "%"
                  : "0.0%";
              const hardFails = job.failed_count || 0;
              const softFails = job.soft_failed_count || 0;

              // Color code success rate
              const rate = job.success_rate || 0;
              let rateColor = COLOR_ERROR;
              if (rate >= 0.9) rateColor = "inherit";
              else if (rate >= 0.7) rateColor = COLOR_WARNING;

              // Get failure info for this job
              const failureInfo = firstFailureMap.get(job.job_name);

              // Helper to construct Buildkite URL from build number
              const buildUrl = (buildNum: number | null | undefined) =>
                buildNum
                  ? `https://buildkite.com/vllm/ci/builds/${buildNum}`
                  : null;

              // Recent failure (any type)
              const recentFailedBuild = failureInfo?.recent_failed_build;
              const recentFailedUrl = buildUrl(recentFailedBuild);

              // First break (success -> failure transition)
              const firstBreakBuild = failureInfo?.first_break_build;
              const firstBreakUrl = buildUrl(firstBreakBuild);
              const firstBreakAt = failureInfo?.first_break_at
                ? dayjs(failureInfo.first_break_at).format("M/D h:mm A")
                : null;

              return (
                <TableRow key={index} hover>
                  <TableCell sx={{ maxWidth: 300 }}>
                    <Typography
                      sx={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={job.job_name}
                    >
                      {job.job_name}
                    </Typography>
                  </TableCell>
                  <TableCell
                    align="center"
                    sx={{ color: rateColor, fontWeight: "bold" }}
                  >
                    {successRate}
                  </TableCell>
                  <TableCell
                    align="center"
                    sx={{ color: hardFails > 0 ? COLOR_ERROR : "inherit" }}
                  >
                    {hardFails}
                  </TableCell>
                  <TableCell
                    align="center"
                    sx={{ color: softFails > 0 ? COLOR_WARNING : "inherit" }}
                  >
                    {softFails}
                  </TableCell>
                  <TableCell align="center">
                    {recentFailedBuild && recentFailedUrl ? (
                      <Link
                        href={recentFailedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={{ fontSize: "0.85rem" }}
                      >
                        #{recentFailedBuild}
                      </Link>
                    ) : (
                      <Typography
                        sx={{ fontSize: "0.85rem", color: "text.secondary" }}
                      >
                        -
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="center">
                    {firstBreakBuild && firstBreakUrl ? (
                      <Link
                        href={firstBreakUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        sx={{ fontSize: "0.85rem" }}
                      >
                        #{firstBreakBuild}
                        {firstBreakAt && (
                          <Typography
                            component="span"
                            sx={{
                              fontSize: "0.7rem",
                              color: "text.secondary",
                              ml: 0.5,
                            }}
                          >
                            ({firstBreakAt})
                          </Typography>
                        )}
                      </Link>
                    ) : (
                      <Typography
                        sx={{ fontSize: "0.85rem", color: "text.secondary" }}
                      >
                        -
                      </Typography>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}
