import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Box,
  Chip,
  Link,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import dayjs from "dayjs";
import { useDarkMode } from "lib/DarkModeContext";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import React, { useState } from "react";
import {
  COLOR_ERROR,
  COLOR_GRAY,
  COLOR_SUCCESS,
  COLOR_WARNING,
  PIPELINE_NAME,
  VLLM_REPO_URL,
} from "./constants";

interface ContinuousBuildData {
  build_number: number;
  build_id: string;
  build_state: string;
  build_url: string;
  build_started_at: string | null;
  build_finished_at: string | null;
  build_message: string;
  commit: string;
  build_type: string;
  total_jobs: number;
  failed_jobs_count: number;
}

interface FailedJobData {
  job_name: string;
  job_state: string;
  soft_failed: boolean;
  job_started_at: string | null;
  job_finished_at: string | null;
  job_url: string;
  exit_status: number | null;
  duration_hours: number | null;
  build_number: number;
  build_url: string;
}

// Helper function to format duration
function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "-";
  if (hours < 1) {
    return `${(hours * 60).toFixed(0)}m`;
  }
  return `${hours.toFixed(2)}h`;
}

// Helper function to get state color
function getStateColor(state: string): { bg: string; text: string } {
  const stateLower = state.toLowerCase();
  if (
    stateLower === "passed" ||
    stateLower === "finished" ||
    stateLower === "success"
  ) {
    return { bg: COLOR_SUCCESS, text: "#fff" };
  }
  if (stateLower === "failed" || stateLower === "failing") {
    return { bg: COLOR_ERROR, text: "#fff" };
  }
  if (stateLower === "canceled" || stateLower === "cancelled") {
    return { bg: COLOR_GRAY, text: "#fff" };
  }
  if (stateLower === "running") {
    return { bg: COLOR_WARNING, text: "#fff" };
  }
  return { bg: "#999", text: "#fff" };
}

// Helper function to get build type chip color
function getBuildTypeColor(buildType: string): string {
  if (buildType === "Daily") {
    return COLOR_SUCCESS;
  }
  if (buildType === "Nightly") {
    return COLOR_WARNING;
  }
  return COLOR_GRAY;
}

export default function ContinuousBuildTracker({
  data,
  timeParams,
}: {
  data: ContinuousBuildData[] | undefined;
  timeParams: { startTime: string; stopTime: string };
}) {
  const { darkMode } = useDarkMode();
  const [selectedBuildNumber, setSelectedBuildNumber] = useState<number | null>(
    null
  );

  // Fetch failed jobs for selected build
  const { data: failedJobsData } = useClickHouseAPIImmutable(
    "vllm/build_failed_jobs",
    {
      repo: VLLM_REPO_URL,
      pipelineName: PIPELINE_NAME,
      buildNumber: selectedBuildNumber || 0,
    },
    selectedBuildNumber !== null
  );

  const builds = (data || []) as ContinuousBuildData[];

  // Auto-select first build if nothing is selected or if selected build is no longer in the list
  React.useEffect(() => {
    if (builds.length > 0) {
      if (
        selectedBuildNumber === null ||
        !builds.some((b) => b.build_number === selectedBuildNumber)
      ) {
        setSelectedBuildNumber(builds[0].build_number);
      }
    }
  }, [builds, selectedBuildNumber]);

  // Handle row click
  function handleRowClick(buildNumber: number) {
    setSelectedBuildNumber(buildNumber);
  }

  const failedJobs = (failedJobsData || []) as FailedJobData[];
  const selectedBuild = builds.find(
    (b) => b.build_number === selectedBuildNumber
  );

  return (
    <Paper sx={{ p: 2, height: "100%", overflow: "hidden" }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "row",
          gap: 2,
          height: "100%",
        }}
      >
        {/* Builds table on the left */}
        <Box
          sx={{
            flex: "1 1 45%",
            minWidth: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: "bold" }}>
            Continuous Builds
          </Typography>
          <TableContainer sx={{ flex: 1, overflow: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Build #</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Failed Jobs</TableCell>
                  <TableCell>Finished At</TableCell>
                  <TableCell align="right">Link</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {builds.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                      No continuous builds found in selected time range
                    </TableCell>
                  </TableRow>
                )}
                {builds.map((build) => {
                  const stateColors = getStateColor(build.build_state);
                  return (
                    <TableRow
                      key={build.build_number}
                      hover
                      onClick={() => handleRowClick(build.build_number)}
                      selected={selectedBuildNumber === build.build_number}
                      sx={{
                        cursor: "pointer",
                        "&.Mui-selected": {
                          backgroundColor: darkMode
                            ? "rgba(144, 202, 249, 0.16)"
                            : "rgba(25, 118, 210, 0.12)",
                        },
                        "&.Mui-selected:hover": {
                          backgroundColor: darkMode
                            ? "rgba(144, 202, 249, 0.24)"
                            : "rgba(25, 118, 210, 0.18)",
                        },
                      }}
                    >
                      <TableCell sx={{ fontFamily: "monospace" }}>
                        {build.build_number}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={build.build_type}
                          size="small"
                          sx={{
                            backgroundColor: getBuildTypeColor(
                              build.build_type
                            ),
                            color: "#fff",
                            fontSize: "0.7rem",
                            height: 20,
                            "& .MuiChip-label": {
                              px: 1,
                            },
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={
                            build.build_state.charAt(0).toUpperCase() +
                            build.build_state.slice(1).toLowerCase()
                          }
                          size="small"
                          sx={{
                            backgroundColor: stateColors.bg,
                            color: stateColors.text,
                            fontSize: "0.7rem",
                            height: 20,
                            "& .MuiChip-label": {
                              px: 1,
                            },
                          }}
                        />
                      </TableCell>
                      <TableCell
                        align="center"
                        sx={{
                          color:
                            build.failed_jobs_count > 0
                              ? COLOR_ERROR
                              : COLOR_SUCCESS,
                          fontWeight: "bold",
                        }}
                      >
                        {build.failed_jobs_count} / {build.total_jobs}
                      </TableCell>
                      <TableCell sx={{ fontSize: "0.85rem" }}>
                        {build.build_finished_at
                          ? dayjs(build.build_finished_at).format(
                              "M/D/YY h:mm A"
                            )
                          : "-"}
                      </TableCell>
                      <TableCell align="right">
                        <Link
                          href={build.build_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          underline="none"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Chip
                            label="View"
                            icon={<OpenInNewIcon fontSize="small" />}
                            size="small"
                            clickable
                            sx={{ fontSize: "0.7rem", height: 22 }}
                          />
                        </Link>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>

        {/* Failed jobs table on the right */}
        <Box
          sx={{
            flex: "1 1 55%",
            minWidth: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Box sx={{ mb: 1, minHeight: 32 }}>
            {selectedBuild && (
              <Box>
                <Typography variant="subtitle2" sx={{ fontWeight: "bold" }}>
                  Failed Jobs - Build #{selectedBuild.build_number}
                </Typography>
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {selectedBuild.build_type} build from{" "}
                  {dayjs(selectedBuild.build_finished_at).format(
                    "M/D/YY h:mm A"
                  )}
                </Typography>
              </Box>
            )}
          </Box>
          <TableContainer sx={{ flex: 1, overflow: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Job Name</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Exit Code</TableCell>
                  <TableCell>Finished At</TableCell>
                  <TableCell align="right">Link</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {failedJobs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                      {selectedBuild
                        ? selectedBuild.failed_jobs_count === 0
                          ? "No failed jobs - build passed! ✓"
                          : "Loading failed jobs..."
                        : "Select a build to view failed jobs"}
                    </TableCell>
                  </TableRow>
                )}
                {failedJobs.map((job, idx) => (
                  <TableRow key={`${job.job_name}-${idx}`} hover>
                    <TableCell sx={{ fontSize: "0.85rem" }}>
                      {job.job_name}
                    </TableCell>
                    <TableCell sx={{ fontSize: "0.85rem" }}>
                      {formatDuration(job.duration_hours)}
                    </TableCell>
                    <TableCell
                      sx={{
                        fontFamily: "monospace",
                        fontSize: "0.85rem",
                        color: COLOR_ERROR,
                      }}
                    >
                      {job.exit_status ?? "-"}
                    </TableCell>
                    <TableCell sx={{ fontSize: "0.85rem" }}>
                      {job.job_finished_at
                        ? dayjs(job.job_finished_at).format("M/D/YY h:mm A")
                        : "-"}
                    </TableCell>
                    <TableCell align="right">
                      <Link
                        href={job.job_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        underline="none"
                      >
                        <Chip
                          label="Job"
                          icon={<OpenInNewIcon fontSize="small" />}
                          size="small"
                          clickable
                          sx={{ fontSize: "0.7rem", height: 22 }}
                        />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      </Box>
    </Paper>
  );
}
