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
  Tooltip,
  Typography,
} from "@mui/material";
import { durationDisplay } from "components/common/TimeUtils";
import { getConclusionChar } from "lib/JobClassifierUtil";
import Head from "next/head";
import NextLink from "next/link";
import { useRouter } from "next/router";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
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
  const conclusion =
    job.status === "completed"
      ? job.conclusion
      : job.status === "in_progress"
      ? "pending"
      : job.status;
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
  sha: string;
  upstreamRepo: string;
  latestTime: string;
  jobs: Map<string, CrcrJobRow>;
}

interface ColumnDef {
  type: "single" | "group";
  name: string;
  members?: string[];
}

function detectGroups(jobNames: string[]): ColumnDef[] {
  const prefixMap = new Map<string, string[]>();
  for (const name of jobNames) {
    const match = name.match(/^(.+[-_])(\d+)$/);
    if (match) {
      const prefix = match[1];
      const group = prefixMap.get(prefix) ?? [];
      group.push(name);
      prefixMap.set(prefix, group);
    }
  }

  const grouped = new Set<string>();
  const columns: ColumnDef[] = [];

  for (const name of jobNames) {
    if (grouped.has(name)) continue;
    const match = name.match(/^(.+[-_])(\d+)$/);
    if (match) {
      const prefix = match[1];
      const members = prefixMap.get(prefix);
      if (members && members.length >= 3) {
        columns.push({
          type: "group",
          name: prefix.replace(/[-_]$/, ""),
          members: members.sort(),
        });
        for (const m of members) grouped.add(m);
        continue;
      }
    }
    columns.push({ type: "single", name });
  }
  return columns;
}

function GroupedJobCell({
  jobs,
  groupName,
}: {
  jobs: CrcrJobRow[];
  groupName: string;
}) {
  const worst = jobs.reduce(
    (w, j) => {
      const c = j.status === "completed" ? j.conclusion : j.status;
      const severity =
        c === "failure" || c === "timed_out"
          ? 3
          : c === "cancelled"
          ? 2
          : c === "pending" || c === "in_progress"
          ? 1
          : 0;
      return severity > w.severity ? { severity, conclusion: c } : w;
    },
    { severity: -1, conclusion: "success" }
  );

  const char = getConclusionChar(
    worst.conclusion === "in_progress" ? "pending" : worst.conclusion
  );
  const color =
    conclusionCssColor[worst.conclusion] ?? "var(--color-grey, #8b949e)";

  const tooltipLines = jobs.map((j) => {
    const c = j.status === "completed" ? j.conclusion : j.status;
    return `${j.job_name}: ${c}`;
  });

  return (
    <Tooltip
      title={
        <span style={{ whiteSpace: "pre-line" }}>
          {`${groupName} (${jobs.length} jobs)\n` + tooltipLines.join("\n")}
        </span>
      }
    >
      <span
        style={{
          fontFamily: "monospace",
          fontWeight: "bold",
          fontSize: "1rem",
          display: "inline-block",
          width: "14px",
          textAlign: "center",
          color,
          cursor: "default",
        }}
      >
        {char}
      </span>
    </Tooltip>
  );
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
        sha: job.pytorch_head_sha,
        upstreamRepo: job.upstream_repo ?? "pytorch/pytorch",
        latestTime: job.started_at,
        jobs: new Map(),
      };
      prMap.set(job.pr_number, row);
    }
    // Track latest started_at for this PR
    if (job.started_at > row.latestTime) {
      row.latestTime = job.started_at;
      row.sha = job.pytorch_head_sha;
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

// ---- Time display (matching main HUD: "h:mm a" style) ----

function LocalTimeDisplay({ timestamp }: { timestamp: string }) {
  const [display, setDisplay] = useState<string | null>(null);
  useEffect(() => {
    const d = new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor(
      (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
    );
    const timeStr = d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    if (diffDays === 0) {
      setDisplay(timeStr);
    } else if (diffDays < 7) {
      const day = d.toLocaleDateString("en-US", { weekday: "short" });
      setDisplay(`${day} ${timeStr}`);
    } else {
      const dateStr = d.toLocaleDateString("en-US", {
        month: "numeric",
        day: "numeric",
      });
      setDisplay(`${dateStr} ${timeStr}`);
    }
  }, [timestamp]);
  return <>{display ?? ""}</>;
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

// ---- Table Styles (matching main HUD) ----

const headerBaseStyle: CSSProperties = {
  fontFamily: "sans-serif",
  fontSize: "0.75rem",
  fontWeight: 600,
  padding: "4px 6px",
  whiteSpace: "nowrap",
  textAlign: "left",
  borderBottom: "1px solid #30363d",
};

const jobHeaderStyle: CSSProperties = {
  fontFamily: "sans-serif",
  height: 120,
  whiteSpace: "nowrap",
  padding: 0,
  borderBottom: "1px solid #30363d",
  position: "relative",
};

const jobHeaderNameStyle: CSSProperties = {
  transform: "translate(5px, 45px) rotate(315deg)",
  transformOrigin: "left bottom",
  width: 12,
  fontWeight: 400,
  fontSize: "0.75em",
};

const cellStyle: CSSProperties = {
  padding: "3px 6px",
  whiteSpace: "nowrap",
  fontSize: "0.8rem",
  verticalAlign: "middle",
};

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

  const { matrix, hasNextPage, columns } = useMemo(() => {
    if (!data) return { matrix: null, hasNextPage: false, columns: [] };
    const full = buildMatrix(data);
    const hasMore = full.rows.length > PER_PAGE;
    return {
      matrix: {
        jobNames: full.jobNames,
        rows: full.rows.slice(0, PER_PAGE),
      },
      hasNextPage: hasMore,
      columns: detectGroups(full.jobNames),
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
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: "0.85rem",
            width: "100%",
          }}
        >
          <colgroup>
            <col style={{ width: 80 }} />
            <col style={{ width: 60 }} />
            <col style={{ width: 280 }} />
            <col style={{ width: 60 }} />
            <col style={{ width: 100 }} />
            {columns.map((col) => (
              <col key={col.name} style={{ width: 18 }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th style={headerBaseStyle}>Time</th>
              <th style={headerBaseStyle}>SHA</th>
              <th style={headerBaseStyle}>Commit</th>
              <th style={headerBaseStyle}>PR</th>
              <th style={headerBaseStyle}>Author</th>
              {columns.map((col) => (
                <th key={col.name} style={jobHeaderStyle}>
                  <div
                    style={{
                      ...jobHeaderNameStyle,
                      fontWeight: col.type === "group" ? 700 : 400,
                    }}
                  >
                    {col.name}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const pr = prInfoMap.get(row.prNumber);
              const commitTitle = pr?.title ?? `PR #${row.prNumber}`;
              const truncatedTitle =
                commitTitle.length > 50
                  ? commitTitle.slice(0, 47) + "..."
                  : commitTitle;
              return (
                <tr
                  key={row.prNumber}
                  style={{ borderBottom: "1px solid #30363d" }}
                >
                  <td style={cellStyle}>
                    <LocalTimeDisplay timestamp={row.latestTime} />
                  </td>
                  <td style={cellStyle}>
                    <a
                      href={`https://github.com/${row.upstreamRepo}/commit/${row.sha}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#58a6ff", textDecoration: "none" }}
                    >
                      {row.sha ? row.sha.substring(0, 7) : "–"}
                    </a>
                  </td>
                  <td style={{ ...cellStyle, maxWidth: 280 }}>
                    <Tooltip title={commitTitle}>
                      <a
                        href={`https://github.com/${row.upstreamRepo}/pull/${row.prNumber}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "#58a6ff",
                          textDecoration: "none",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          display: "block",
                        }}
                      >
                        {truncatedTitle}
                      </a>
                    </Tooltip>
                  </td>
                  <td style={cellStyle}>
                    <a
                      href={`https://github.com/${row.upstreamRepo}/pull/${row.prNumber}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "#2f81f7", textDecoration: "none" }}
                    >
                      #{row.prNumber}
                    </a>
                  </td>
                  <td style={cellStyle}>
                    {pr?.author ? (
                      <a
                        href={`https://github.com/${pr.author}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "#8b949e", textDecoration: "none" }}
                      >
                        {pr.author}
                      </a>
                    ) : (
                      "–"
                    )}
                  </td>
                  {columns.map((col) => {
                    if (col.type === "group" && col.members) {
                      const groupJobs = col.members
                        .map((m) => row.jobs.get(m))
                        .filter((j): j is CrcrJobRow => j != null);
                      return (
                        <td
                          key={col.name}
                          style={{ ...cellStyle, textAlign: "center" }}
                        >
                          {groupJobs.length > 0 ? (
                            <GroupedJobCell
                              jobs={groupJobs}
                              groupName={col.name}
                            />
                          ) : (
                            "–"
                          )}
                        </td>
                      );
                    }
                    const job = row.jobs.get(col.name);
                    return (
                      <td
                        key={col.name}
                        style={{ ...cellStyle, textAlign: "center" }}
                      >
                        {job ? <JobCell job={job} /> : "–"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
