import {
  Box,
  FormControl,
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
  Tooltip,
  Typography,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import { getConclusionChar } from "lib/JobClassifierUtil";
import Head from "next/head";
import NextLink from "next/link";
import { useRouter } from "next/router";
import { useMemo } from "react";
import useSWR from "swr";

import { fetcher } from "lib/GeneralUtils";

// ---- Types ----

interface CrcrJobRow {
  upstream_repo: string;
  pr_number: number;
  pytorch_head_sha: string;
  workflow_name: string;
  job_name: string;
  check_run_id: string;
  run_id: string;
  run_attempt: number;
  status: string;
  conclusion: string;
  started_at: string;
  completed_at: string;
  duration_seconds: number;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  skipped_tests: number;
  workflow_run_url: string;
  artifact_url: string;
  queue_time: number | null;
  execution_time: number | null;
}

interface SummaryStats {
  successes: number;
  failures: number;
  timed_out: number;
  total_jobs: number;
  pass_rate: number;
  total_prs: number;
  avg_queue_time_s: number | null;
  avg_exec_time_s: number | null;
  flaky_jobs: number;
}

// ---- Summary Stat Cards ----

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <Paper
      elevation={1}
      sx={{
        p: 2,
        minWidth: 140,
        flex: 1,
        textAlign: "center",
        borderTop: color ? `3px solid ${color}` : undefined,
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 600, color: color }}>
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary">
          {sub}
        </Typography>
      )}
    </Paper>
  );
}

function SummaryCards({ stats }: { stats: SummaryStats }) {
  const passColor =
    stats.pass_rate >= 0.95
      ? "#2e7d32"
      : stats.pass_rate >= 0.8
      ? "#ed6c02"
      : "#d32f2f";

  return (
    <Stack spacing={2}>
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        <StatCard
          label="Pass Rate"
          value={`${(stats.pass_rate * 100).toFixed(1)}%`}
          sub={`${stats.successes}/${stats.total_jobs} jobs`}
          color={passColor}
        />
        <StatCard
          label="Total PRs"
          value={stats.total_prs}
          sub="unique PRs tested"
        />
        <StatCard
          label="Failures"
          value={stats.failures}
          sub={stats.timed_out > 0 ? `+ ${stats.timed_out} timed out` : ""}
          color={stats.failures > 0 ? "#d32f2f" : undefined}
        />
      </Box>
      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        <StatCard
          label="Avg Queue Time"
          value={
            stats.avg_queue_time_s != null
              ? durationDisplay(Math.round(stats.avg_queue_time_s))
              : "–"
          }
          sub="dispatch to start"
        />
        <StatCard
          label="Avg Execution Time"
          value={
            stats.avg_exec_time_s != null
              ? durationDisplay(Math.round(stats.avg_exec_time_s))
              : "–"
          }
          sub="start to completion"
        />
        <StatCard
          label="Flaky Jobs"
          value={stats.flaky_jobs}
          sub="same job: pass + fail across attempts"
          color={stats.flaky_jobs > 0 ? "#ed6c02" : undefined}
        />
      </Box>
    </Stack>
  );
}

// ---- Job Cell (colored character, matching main HUD style) ----

const conclusionCssColor: Record<string, string> = {
  success: "var(--color-success, #3fb950)",
  failure: "var(--color-failure, #f85149)",
  cancelled: "var(--color-failure, #f85149)",
  timed_out: "var(--color-failure, #f85149)",
  pending: "var(--color-pending, #d29922)",
  skipped: "var(--color-grey, #8b949e)",
  neutral: "var(--color-grey, #8b949e)",
};

function JobCell({ job }: { job: CrcrJobRow }) {
  const conclusion = job.status === "completed" ? job.conclusion : job.status;
  const char = getConclusionChar(conclusion);
  const color = conclusionCssColor[conclusion] ?? "var(--color-grey, #8b949e)";

  const tooltipContent = [
    `Job: ${job.job_name}`,
    `Status: ${conclusion}`,
    job.run_attempt > 1 ? `Attempt: ${job.run_attempt}` : null,
    `Duration: ${
      job.duration_seconds
        ? durationDisplay(Math.round(job.duration_seconds))
        : "–"
    }`,
    job.total_tests
      ? `Tests: ${job.passed_tests}/${job.total_tests} passed`
      : null,
    job.queue_time != null ? `Queue: ${job.queue_time.toFixed(1)}s` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Tooltip
      title={<span style={{ whiteSpace: "pre-line" }}>{tooltipContent}</span>}
    >
      <a
        href={job.workflow_run_url}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontFamily: "monospace",
          fontWeight: "bold",
          fontSize: "1rem",
          display: "inline-block",
          width: "14px",
          textAlign: "center",
          color,
          textDecoration: "none",
        }}
      >
        {char}
      </a>
    </Tooltip>
  );
}

// ---- Matrix Builder ----

interface MatrixRow {
  prNumber: number;
  upstreamRepo: string;
  latestTime: string;
  jobs: Map<string, CrcrJobRow>;
}

function buildMatrix(data: CrcrJobRow[]): {
  jobNames: string[];
  rows: MatrixRow[];
} {
  const jobNamesSet = new Set<string>();
  const prMap = new Map<number, MatrixRow>();

  for (const job of data) {
    jobNamesSet.add(job.job_name);
    let row = prMap.get(job.pr_number);
    if (!row) {
      row = {
        prNumber: job.pr_number,
        upstreamRepo: job.upstream_repo ?? "pytorch/pytorch",
        latestTime: job.started_at,
        jobs: new Map(),
      };
      prMap.set(job.pr_number, row);
    }
    // Track latest started_at for this PR
    if (job.started_at > row.latestTime) {
      row.latestTime = job.started_at;
    }
    // Keep the latest attempt per job_name
    const existing = row.jobs.get(job.job_name);
    if (!existing || job.run_attempt > existing.run_attempt) {
      row.jobs.set(job.job_name, job);
    }
  }

  const jobNames = Array.from(jobNamesSet).sort();
  const rows = Array.from(prMap.values()).sort(
    (a, b) => b.prNumber - a.prNumber
  );
  return { jobNames, rows };
}

// ---- Time display ----

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---- Pagination ----

const PER_PAGE = 50;

function CrcrPagination({
  page,
  hasNextPage,
  onPageChange,
}: {
  page: number;
  hasNextPage: boolean;
  onPageChange: (page: number) => void;
}) {
  return (
    <div>
      Page {page}:{" "}
      {page > 1 ? (
        <Link
          component="button"
          underline="hover"
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </Link>
      ) : (
        <span>Prev</span>
      )}{" "}
      |{" "}
      {hasNextPage ? (
        <Link
          component="button"
          underline="hover"
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Link>
      ) : (
        <span>Next</span>
      )}
    </div>
  );
}

// ---- PR Info Hook ----

interface PrInfo {
  prNumber: number;
  title: string;
  author: string;
}

function usePrInfo(
  upstreamRepo: string,
  prNumbers: number[]
): Map<number, PrInfo> {
  const dedupedPrs = useMemo(
    () => Array.from(new Set(prNumbers.filter((n) => n > 0))).slice(0, 50),
    [prNumbers]
  );
  const url =
    upstreamRepo && dedupedPrs.length > 0
      ? `/api/crcr/pr-info?repo=${encodeURIComponent(
          upstreamRepo
        )}&prs=${encodeURIComponent(dedupedPrs.join(","))}`
      : null;
  const { data } = useSWR<PrInfo[]>(url, fetcher, {
    revalidateOnFocus: false,
  });

  return useMemo(() => {
    const map = new Map<number, PrInfo>();
    if (data) {
      for (const pr of data) {
        map.set(pr.prNumber, pr);
      }
    }
    return map;
  }, [data]);
}

// ---- PR Matrix Table ----

function CrcrMatrix({
  repoFullName,
  days,
  page,
  onPageChange,
}: {
  repoFullName: string;
  days: number;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const offset = (page - 1) * PER_PAGE;
  const url = `/api/clickhouse/crcr_backend_dashboard?parameters=${encodeURIComponent(
    JSON.stringify({
      repo: repoFullName,
      days: String(days),
      per_page: String(PER_PAGE + 1),
      offset: String(offset),
    })
  )}`;
  const { data, error } = useSWR<CrcrJobRow[]>(url, fetcher, {
    refreshInterval: 60_000,
  });

  const { matrix, hasNextPage } = useMemo(() => {
    if (!data) return { matrix: null, hasNextPage: false };
    const full = buildMatrix(data);
    const hasMore = full.rows.length > PER_PAGE;
    return {
      matrix: {
        jobNames: full.jobNames,
        rows: full.rows.slice(0, PER_PAGE),
      },
      hasNextPage: hasMore,
    };
  }, [data]);

  const upstreamRepo = matrix?.rows[0]?.upstreamRepo ?? "pytorch/pytorch";
  const prNumbers = useMemo(
    () => (matrix?.rows ?? []).map((r) => r.prNumber),
    [matrix]
  );
  const prInfoMap = usePrInfo(upstreamRepo, prNumbers);

  if (error) {
    return (
      <Typography color="error">
        Failed to load dashboard: {error.message}
      </Typography>
    );
  }
  if (!data || !matrix) {
    return <Skeleton variant="rectangular" height={400} />;
  }
  if (data.length === 0) {
    return (
      <>
        <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
          No results for {repoFullName} in the last {days} days.
        </Typography>
        {page > 1 && (
          <CrcrPagination
            page={page}
            hasNextPage={false}
            onPageChange={onPageChange}
          />
        )}
      </>
    );
  }

  return (
    <>
      <TableContainer component={Paper} elevation={2}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>
                <strong>Time</strong>
              </TableCell>
              <TableCell>
                <strong>Commit</strong>
              </TableCell>
              <TableCell>
                <strong>Author</strong>
              </TableCell>
              <TableCell>
                <strong>PR</strong>
              </TableCell>
              {matrix.jobNames.map((name) => (
                <TableCell key={name} align="center">
                  <strong>{name}</strong>
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {matrix.rows.map((row) => {
              const pr = prInfoMap.get(row.prNumber);
              return (
                <TableRow key={row.prNumber} hover>
                  <TableCell sx={{ whiteSpace: "nowrap" }}>
                    <Tooltip title={new Date(row.latestTime).toLocaleString()}>
                      <Typography variant="body2" color="text.secondary">
                        {formatShortDate(row.latestTime)}
                        <br />
                        <small>{timeAgo(row.latestTime)}</small>
                      </Typography>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 300 }}>
                    <Link
                      href={`https://github.com/${row.upstreamRepo}/pull/${row.prNumber}`}
                      target="_blank"
                      rel="noopener"
                      underline="hover"
                      sx={{ fontSize: "0.85rem" }}
                    >
                      {pr?.title
                        ? pr.title.length > 60
                          ? pr.title.slice(0, 57) + "..."
                          : pr.title
                        : `PR #${row.prNumber}`}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {pr?.author ? (
                      <Link
                        href={`https://github.com/${pr.author}`}
                        target="_blank"
                        rel="noopener"
                        underline="hover"
                        sx={{ fontSize: "0.85rem" }}
                      >
                        {pr.author}
                      </Link>
                    ) : (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ fontSize: "0.85rem" }}
                      >
                        –
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`https://github.com/${row.upstreamRepo}/pull/${row.prNumber}`}
                      target="_blank"
                      rel="noopener"
                      underline="hover"
                    >
                      #{row.prNumber}
                    </Link>
                  </TableCell>
                  {matrix.jobNames.map((name) => {
                    const job = row.jobs.get(name);
                    return (
                      <TableCell key={name} align="center">
                        {job ? <JobCell job={job} /> : "–"}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ mt: 2 }}>
        <CrcrPagination
          page={page}
          hasNextPage={hasNextPage}
          onPageChange={onPageChange}
        />
      </Box>
    </>
  );
}

// ---- Main Page ----

export default function CrcrBackendPage() {
  const router = useRouter();
  const { org, repo } = router.query;

  const page = parseInt(router.query.page as string) || 1;
  const days = parseInt(router.query.days as string) || 7;

  const repoFullName = org && repo ? `${org}/${repo}` : "";

  const summaryUrl = repoFullName
    ? `/api/clickhouse/crcr_backend_summary?parameters=${encodeURIComponent(
        JSON.stringify({ repo: repoFullName, days: String(days) })
      )}`
    : null;
  const { data: summaryData } = useSWR<SummaryStats[]>(summaryUrl, fetcher, {
    refreshInterval: 60_000,
  });
  const stats = summaryData?.[0] ?? null;

  if (!org || !repo) return null;

  function updateQuery(updates: Record<string, string | number>) {
    router.push(
      { pathname: router.pathname, query: { ...router.query, ...updates } },
      undefined,
      { shallow: true }
    );
  }

  return (
    <>
      <Head>
        <title>{repoFullName} — CRCR CI | PyTorch HUD</title>
      </Head>
      <Stack spacing={3} sx={{ p: 3, maxWidth: 1600, mx: "auto" }}>
        <Box display="flex" justifyContent="space-between" alignItems="center">
          <Stack spacing={0.5}>
            <Typography variant="h4">{repoFullName}</Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <NextLink href="/crcr" passHref legacyBehavior>
                <Link variant="body2" underline="hover">
                  ← Back to CRCR Summary
                </Link>
              </NextLink>
              <Link
                href={`https://github.com/${repoFullName}`}
                target="_blank"
                rel="noopener"
                variant="body2"
                underline="hover"
              >
                GitHub ↗
              </Link>
            </Stack>
          </Stack>
          <Stack direction="row" spacing={2} alignItems="center">
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <InputLabel>Time Range</InputLabel>
              <Select
                value={days}
                label="Time Range"
                onChange={(e: SelectChangeEvent<number>) =>
                  updateQuery({ days: Number(e.target.value), page: 1 })
                }
              >
                <MenuItem value={1}>Last 24h</MenuItem>
                <MenuItem value={7}>Last 7 days</MenuItem>
                <MenuItem value={30}>Last 30 days</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </Box>

        {stats ? (
          <SummaryCards stats={stats} />
        ) : (
          <Skeleton variant="rectangular" height={140} />
        )}

        <Typography variant="body2" color="text.secondary">
          Rows = PyTorch PRs (50 per page), columns = downstream CI jobs. Click
          a cell to open the workflow run.
        </Typography>

        <CrcrMatrix
          repoFullName={repoFullName}
          days={days}
          page={page}
          onPageChange={(p) => updateQuery({ page: p })}
        />
      </Stack>
    </>
  );
}
