import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  SelectChangeEvent,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { durationDisplay, LocalTimeHuman } from "components/common/TimeUtils";
import { fetcherHandleError } from "lib/GeneralUtils";
import {
  DEFAULT_TEST_HISTORY_DAYS,
  TEST_HISTORY_DAY_OPTIONS,
  TestHistoryDays,
} from "lib/testHistory";
import { decodeTestIdentity } from "lib/testIdentity";
import Head from "next/head";
import { useRouter } from "next/router";
import type { TestMetricsResponse } from "pages/api/tests/[id]/metrics";
import type {
  TestRunsResponse,
  TestRunStatus,
} from "pages/api/tests/[id]/runs";
import { useEffect, useState } from "react";
import useSWR from "swr";

function MetricCard({
  label,
  value,
  percentage,
}: {
  label: string;
  value: string;
  percentage?: string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2, textAlign: "center" }}>
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h4" sx={{ fontWeight: 600 }}>
        {value}
      </Typography>
      {percentage && (
        <Typography variant="body2" color="text.secondary">
          {percentage}
        </Typography>
      )}
    </Paper>
  );
}

function HeaderField({ label, value }: { label: string; value: string }) {
  return (
    <Box component="span" sx={{ display: "block", minWidth: 0 }}>
      <Typography variant="overline" component="span" color="text.secondary">
        {label}
      </Typography>
      <Typography
        component="span"
        sx={{
          display: "block",
          fontFamily: "monospace",
          fontSize: "1.1rem",
          fontWeight: 600,
          fontStyle: value ? "normal" : "italic",
          lineHeight: 1.4,
          overflowWrap: "anywhere",
        }}
      >
        {value || "Not reported"}
      </Typography>
    </Box>
  );
}

const RUN_STATUS: Record<
  TestRunStatus,
  {
    label: string;
    color: "success" | "error" | "default" | "warning";
  }
> = {
  success: { label: "Success", color: "success" },
  failure: { label: "Failure", color: "error" },
  skipped: { label: "Skipped", color: "default" },
  flaky: { label: "Flaky", color: "warning" },
};

function RunStatusChip({ status }: { status: TestRunStatus }) {
  const config = RUN_STATUS[status];
  return <Chip label={config.label} color={config.color} size="small" />;
}

export default function TestDetailsPage() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;
  const test = id ? decodeTestIdentity(id) : null;
  const [runsCursor, setRunsCursor] = useState<string | null>(null);
  const [hideSkippedRuns, setHideSkippedRuns] = useState(true);
  const [historyDays, setHistoryDays] = useState<TestHistoryDays>(
    DEFAULT_TEST_HISTORY_DAYS
  );

  useEffect(() => {
    setRunsCursor(null);
  }, [id]);

  const metricsUrl =
    router.isReady && test && id
      ? `/api/tests/${encodeURIComponent(id)}/metrics?days=${historyDays}`
      : null;
  const runsParams = new URLSearchParams();
  runsParams.set("days", String(historyDays));
  if (runsCursor) runsParams.set("cursor", runsCursor);
  if (hideSkippedRuns) runsParams.set("exclude_skipped", "true");
  const runsQuery = runsParams.toString();
  const runsUrl =
    router.isReady && test && id
      ? `/api/tests/${encodeURIComponent(id)}/runs${
          runsQuery ? `?${runsQuery}` : ""
        }`
      : null;
  const {
    data: metrics,
    error: metricsError,
    isLoading: metricsLoading,
    mutate: refreshMetrics,
  } = useSWR<TestMetricsResponse>(metricsUrl, fetcherHandleError, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  const {
    data: runsData,
    error: runsError,
    isLoading: runsLoading,
    isValidating: runsValidating,
    mutate: refreshRuns,
  } = useSWR<TestRunsResponse>(runsUrl, fetcherHandleError, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
  });
  if (!router.isReady) {
    return (
      <Stack
        alignItems="center"
        justifyContent="center"
        sx={{ minHeight: 320 }}
      >
        <CircularProgress />
      </Stack>
    );
  }

  if (!test) {
    return (
      <Box component="main" sx={{ maxWidth: 900, mx: "auto", p: 2 }}>
        <Alert severity="error">Invalid test identifier.</Alert>
      </Box>
    );
  }

  const totalRuns = metrics?.totalRuns.toLocaleString("en-US") ?? "0";
  const runCount = (count: number) =>
    `${count.toLocaleString("en-US")} / ${totalRuns}`;
  const runPercentage = (count: number) =>
    metrics && metrics.totalRuns > 0
      ? `${((count / metrics.totalRuns) * 100).toFixed(1)}% of total`
      : "N/A";
  const metricCards = metrics
    ? [
        {
          label: "Avg successful duration",
          value:
            metrics.averageDurationSeconds === null
              ? "N/A"
              : durationDisplay(metrics.averageDurationSeconds),
        },
        {
          label: "Successful runs",
          value: runCount(metrics.successfulRuns),
          percentage: runPercentage(metrics.successfulRuns),
        },
        {
          label: "Failures",
          value: runCount(metrics.failureRuns),
          percentage: runPercentage(metrics.failureRuns),
        },
        {
          label: "Skips",
          value: runCount(metrics.skippedRuns),
          percentage: runPercentage(metrics.skippedRuns),
        },
      ]
    : [];
  const historyRangeLabel = `${historyDays} ${
    historyDays === 1 ? "day" : "days"
  }`;

  return (
    <>
      <Head>
        <title>{test.name || "Test"} | PyTorch CI</title>
      </Head>
      <Box component="main" sx={{ maxWidth: 1100, mx: "auto", p: 2 }}>
        <Box
          component="header"
          sx={{ mb: 3, pb: 3, borderBottom: 1, borderColor: "divider" }}
        >
          <Box
            component="h1"
            sx={{
              display: "grid",
              gridTemplateColumns: {
                xs: "minmax(0, 1fr)",
                md: "repeat(3, minmax(0, 1fr))",
              },
              gap: { xs: 1.5, md: 3 },
              m: 0,
            }}
          >
            <HeaderField label="File" value={test.file} />
            <HeaderField label="Classname" value={test.classname} />
            <HeaderField label="Name" value={test.name} />
          </Box>
        </Box>

        <Box component="section">
          <Stack
            direction={{ xs: "column", sm: "row" }}
            alignItems={{ xs: "flex-start", sm: "center" }}
            justifyContent="space-between"
            spacing={2}
            sx={{ mb: 1.5 }}
          >
            <Typography variant="h6" component="h2">
              Last {historyRangeLabel}
            </Typography>
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel id="test-history-range-label">Time range</InputLabel>
              <Select
                labelId="test-history-range-label"
                value={historyDays}
                label="Time range"
                onChange={(event: SelectChangeEvent<number>) => {
                  setHistoryDays(Number(event.target.value) as TestHistoryDays);
                  setRunsCursor(null);
                }}
              >
                {TEST_HISTORY_DAY_OPTIONS.map((days) => (
                  <MenuItem key={days} value={days}>
                    {days} {days === 1 ? "day" : "days"}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
          {metricsError ? (
            <Alert
              severity="error"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => void refreshMetrics()}
                >
                  Retry
                </Button>
              }
            >
              Unable to load test metrics. Please try again.
            </Alert>
          ) : (
            <>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "1fr",
                    sm: "repeat(2, minmax(0, 1fr))",
                    md: "repeat(4, minmax(0, 1fr))",
                  },
                  gap: 2,
                }}
              >
                {metricsLoading || !metrics
                  ? Array.from({ length: 4 }, (_, index) => (
                      <Skeleton key={index} variant="rounded" height={104} />
                    ))
                  : metricCards.map((metric) => (
                      <MetricCard key={metric.label} {...metric} />
                    ))}
              </Box>
              {!metricsLoading && metrics?.totalRuns === 0 && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ mt: 1.5 }}
                >
                  No runs recorded in the past {historyRangeLabel}.
                </Typography>
              )}
            </>
          )}

          <Box sx={{ mt: 4 }}>
            <Typography id="recent-runs-heading" variant="h6" component="h2">
              Recent runs
            </Typography>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              alignItems={{ xs: "flex-start", sm: "center" }}
              justifyContent="space-between"
              spacing={1}
              sx={{ mb: 1.5 }}
            >
              <Typography variant="body2" color="text.secondary">
                Flaky runs retried before passing count toward total runs but
                are excluded from successful runs and the average duration.
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={hideSkippedRuns}
                    onChange={(event) => {
                      setHideSkippedRuns(event.target.checked);
                      setRunsCursor(null);
                    }}
                  />
                }
                label="Hide skipped runs"
                sx={{ flexShrink: 0, m: 0 }}
              />
            </Stack>

            {runsError ? (
              <Alert
                severity="error"
                action={
                  <Stack direction="row" spacing={0.5}>
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => void refreshRuns()}
                    >
                      Retry
                    </Button>
                    {runsCursor && (
                      <Button
                        color="inherit"
                        size="small"
                        onClick={() => setRunsCursor(null)}
                      >
                        Latest
                      </Button>
                    )}
                  </Stack>
                }
              >
                Unable to load recent runs. Please try again.
              </Alert>
            ) : runsLoading || !runsData ? (
              <Skeleton variant="rounded" height={260} />
            ) : (
              <>
                <TableContainer
                  component={Paper}
                  variant="outlined"
                  sx={{ maxHeight: 36 + 6 * 52, overflow: "auto" }}
                >
                  <Table
                    stickyHeader
                    size="small"
                    aria-labelledby="recent-runs-heading"
                  >
                    <TableHead>
                      <TableRow sx={{ height: 36 }}>
                        <TableCell>Result</TableCell>
                        <TableCell>Workflow / job</TableCell>
                        <TableCell align="right">Duration</TableCell>
                        <TableCell>Recorded</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {runsData.runs.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={4}
                            align="center"
                            sx={{ py: 4, color: "text.secondary" }}
                          >
                            {hideSkippedRuns
                              ? `No non-skipped runs recorded in the past ${historyRangeLabel}.`
                              : `No runs recorded in the past ${historyRangeLabel}.`}
                          </TableCell>
                        </TableRow>
                      ) : (
                        runsData.runs.map((run, index) => {
                          const jobLabel = run.jobName || `Job ${run.jobId}`;
                          const workflowLabel =
                            run.workflowName || `Workflow ${run.workflowId}`;
                          const attempt =
                            run.workflowRunAttempt > 1
                              ? ` · Attempt ${run.workflowRunAttempt}`
                              : "";

                          return (
                            <TableRow
                              key={`${run.recordedAt}-${run.jobId}-${index}`}
                              hover
                              sx={{ height: 52 }}
                            >
                              <TableCell>
                                <RunStatusChip status={run.status} />
                              </TableCell>
                              <TableCell sx={{ minWidth: 280 }}>
                                {run.jobUrl ? (
                                  <Link
                                    href={run.jobUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    sx={{
                                      display: "block",
                                      fontSize: "0.875rem",
                                      lineHeight: 1.4,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {jobLabel}
                                  </Link>
                                ) : (
                                  <Typography
                                    component="span"
                                    sx={{
                                      display: "block",
                                      fontSize: "0.875rem",
                                      lineHeight: 1.4,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {jobLabel}
                                  </Typography>
                                )}
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{
                                    display: "block",
                                    lineHeight: 1.4,
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {workflowLabel}
                                  {attempt}
                                </Typography>
                              </TableCell>
                              <TableCell
                                align="right"
                                sx={{ whiteSpace: "nowrap" }}
                              >
                                {durationDisplay(run.durationSeconds)}
                              </TableCell>
                              <TableCell sx={{ whiteSpace: "nowrap" }}>
                                <LocalTimeHuman timestamp={run.recordedAt} />
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>

                <Stack
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  spacing={2}
                  sx={{ mt: 1.5 }}
                >
                  <Typography variant="body2" color="text.secondary">
                    Page {runsData.pageInfo.page}
                  </Typography>
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="outlined"
                      disabled={
                        runsValidating ||
                        !runsData.pageInfo.hasPreviousPage ||
                        !runsData.pageInfo.previousCursor
                      }
                      onClick={() =>
                        setRunsCursor(runsData.pageInfo.previousCursor)
                      }
                    >
                      Previous
                    </Button>
                    <Button
                      variant="contained"
                      disabled={
                        runsValidating ||
                        !runsData.pageInfo.hasNextPage ||
                        !runsData.pageInfo.nextCursor
                      }
                      onClick={() =>
                        setRunsCursor(runsData.pageInfo.nextCursor)
                      }
                    >
                      Next
                    </Button>
                  </Stack>
                </Stack>
              </>
            )}
          </Box>
        </Box>
      </Box>
    </>
  );
}
