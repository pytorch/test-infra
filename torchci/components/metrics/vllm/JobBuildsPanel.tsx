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
  TableSortLabel,
  TextField,
  Tooltip,
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

interface JobListData {
  job_name: string;
  total_runs: number;
  passed_count: number;
  failed_count: number;
  last_run_at: string;
}

interface RecentBuildData {
  build_number: number;
  build_id: string;
  build_state: string;
  build_url: string;
  build_started_at: string | null;
  build_finished_at: string | null;
  commit: string;
  commit_message: string;
  job_name: string;
  job_state: string;
  soft_failed: boolean;
  job_started_at: string | null;
  job_finished_at: string | null;
  job_url: string;
  duration_hours: number | null;
}

type JobSortField = "job_name" | "total_runs" | "passed_count" | "failed_count";
type SortOrder = "asc" | "desc";

// Helper function to format duration
function formatDuration(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "-";
  if (hours < 1) {
    return `${(hours * 60).toFixed(0)}m`;
  }
  return `${hours.toFixed(2)}h`;
}

// Helper function to get state color
function getStateColor(
  state: string,
  softFailed: boolean
): { bg: string; text: string } {
  const stateLower = state.toLowerCase();
  if (
    stateLower === "passed" ||
    stateLower === "finished" ||
    stateLower === "success"
  ) {
    return { bg: COLOR_SUCCESS, text: "#fff" };
  }
  if (stateLower === "failed") {
    if (softFailed) {
      return { bg: COLOR_WARNING, text: "#fff" };
    }
    return { bg: COLOR_ERROR, text: "#fff" };
  }
  if (stateLower === "canceled" || stateLower === "cancelled") {
    return { bg: COLOR_GRAY, text: "#fff" };
  }
  return { bg: "#999", text: "#fff" };
}

// Helper function to get state label
function getStateLabel(state: string, softFailed: boolean): string {
  const stateLower = state.toLowerCase();
  if (stateLower === "failed" && softFailed) {
    return "Soft Failed";
  }
  return state.charAt(0).toUpperCase() + state.slice(1).toLowerCase();
}

export default function JobBuildsPanel({
  data,
  timeParams,
  jobGroups,
}: {
  data: JobListData[] | undefined;
  timeParams: { startTime: string; stopTime: string };
  jobGroups: string[];
}) {
  const { darkMode } = useDarkMode();
  const [sortField, setSortField] = useState<JobSortField>("last_run_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [selectedJob, setSelectedJob] = useState<string | null>(null);

  // Fetch recent builds for selected job
  const { data: recentBuildsData } = useClickHouseAPIImmutable(
    "vllm/recent_job_builds",
    selectedJob
      ? {
          ...timeParams,
          repo: VLLM_REPO_URL,
          pipelineName: PIPELINE_NAME,
          jobName: selectedJob,
        }
      : null,
    selectedJob !== null
  );

  // Filter by search query
  const filteredJobs = (data || []).filter((job) =>
    job.job_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Sort the filtered data
  const sortedJobs = [...filteredJobs].sort((a, b) => {
    let aValue: number | string = a[sortField];
    let bValue: number | string = b[sortField];

    if (sortField === "job_name") {
      aValue = (aValue as string).toLowerCase();
      bValue = (bValue as string).toLowerCase();
      return sortOrder === "asc"
        ? aValue < bValue
          ? -1
          : 1
        : aValue > bValue
        ? -1
        : 1;
    }

    return sortOrder === "asc"
      ? (aValue as number) - (bValue as number)
      : (bValue as number) - (aValue as number);
  });

  // Auto-select first job if nothing is selected or if selected job is no longer in the list
  React.useEffect(() => {
    if (sortedJobs.length > 0) {
      if (!selectedJob || !sortedJobs.some((j) => j.job_name === selectedJob)) {
        setSelectedJob(sortedJobs[0].job_name);
      }
    }
  }, [sortedJobs, selectedJob]);

  // Handle sort request
  function handleSort(field: JobSortField) {
    if (sortField === field) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortOrder("desc");
    }
  }

  // Handle row click
  function handleRowClick(jobName: string) {
    setSelectedJob(jobName);
  }

  const recentBuilds = (recentBuildsData || []) as RecentBuildData[];

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
        {/* Jobs table on the left */}
        <Box
          sx={{
            flex: "1 1 40%",
            minWidth: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <TextField
            size="small"
            placeholder="Search jobs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{ mb: 1 }}
            fullWidth
          />
          <TableContainer sx={{ flex: 1, overflow: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>
                    <TableSortLabel
                      active={sortField === "job_name"}
                      direction={sortField === "job_name" ? sortOrder : "asc"}
                      onClick={() => handleSort("job_name")}
                    >
                      Job Name
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={sortField === "total_runs"}
                      direction={
                        sortField === "total_runs" ? sortOrder : "desc"
                      }
                      onClick={() => handleSort("total_runs")}
                    >
                      Runs
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={sortField === "passed_count"}
                      direction={
                        sortField === "passed_count" ? sortOrder : "desc"
                      }
                      onClick={() => handleSort("passed_count")}
                    >
                      ✓
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={sortField === "failed_count"}
                      direction={
                        sortField === "failed_count" ? sortOrder : "desc"
                      }
                      onClick={() => handleSort("failed_count")}
                    >
                      ✗
                    </TableSortLabel>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sortedJobs.map((job) => (
                  <TableRow
                    key={job.job_name}
                    hover
                    onClick={() => handleRowClick(job.job_name)}
                    selected={selectedJob === job.job_name}
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
                    <TableCell sx={{ fontSize: "0.85rem" }}>
                      {job.job_name}
                    </TableCell>
                    <TableCell align="right">{job.total_runs}</TableCell>
                    <TableCell
                      align="right"
                      sx={{ color: COLOR_SUCCESS, fontWeight: "bold" }}
                    >
                      {job.passed_count}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ color: COLOR_ERROR, fontWeight: "bold" }}
                    >
                      {job.failed_count}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>

        {/* Recent builds table on the right */}
        <Box
          sx={{
            flex: "1 1 60%",
            minWidth: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <Box sx={{ mb: 1, minHeight: 32 }}>
            {selectedJob && (
              <Box sx={{ fontWeight: "bold", fontSize: "0.9rem" }}>
                Recent Builds: {selectedJob}
              </Box>
            )}
          </Box>
          <TableContainer sx={{ flex: 1, overflow: "auto" }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Build #</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Finished At</TableCell>
                  <TableCell>Commit</TableCell>
                  <TableCell align="right">Links</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {recentBuilds.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                      {selectedJob
                        ? "No recent builds found"
                        : "Select a job to view builds"}
                    </TableCell>
                  </TableRow>
                )}
                {recentBuilds.map((build) => {
                  const stateColors = getStateColor(
                    build.job_state,
                    build.soft_failed
                  );
                  return (
                    <TableRow
                      key={`${build.build_number}-${build.build_id}`}
                      hover
                    >
                      <TableCell sx={{ fontFamily: "monospace" }}>
                        {build.build_number}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={getStateLabel(
                            build.job_state,
                            build.soft_failed
                          )}
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
                      <TableCell sx={{ fontSize: "0.85rem" }}>
                        {formatDuration(build.duration_hours)}
                      </TableCell>
                      <TableCell sx={{ fontSize: "0.85rem" }}>
                        {build.job_finished_at
                          ? dayjs(build.job_finished_at).format("M/D/YY h:mm A")
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <Tooltip title={build.commit_message} arrow>
                          <Box
                            sx={{
                              fontFamily: "monospace",
                              fontSize: "0.8rem",
                              maxWidth: 120,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {build.commit.slice(0, 7)}
                          </Box>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right">
                        <Box
                          sx={{
                            display: "flex",
                            gap: 0.5,
                            justifyContent: "flex-end",
                          }}
                        >
                          <Link
                            href={build.job_url}
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
                          <Link
                            href={build.build_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            underline="none"
                          >
                            <Chip
                              label="Build"
                              icon={<OpenInNewIcon fontSize="small" />}
                              size="small"
                              clickable
                              sx={{ fontSize: "0.7rem", height: 22 }}
                            />
                          </Link>
                        </Box>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      </Box>
    </Paper>
  );
}
