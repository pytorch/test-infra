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
import TooltipTarget from "components/common/tooltipTarget/TooltipTarget";
import hudStyles from "components/hud.module.css";
import { getConclusionChar } from "lib/JobClassifierUtil";
import { Highlight } from "lib/types";
import Head from "next/head";
import NextLink from "next/link";
import { useRouter } from "next/router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import useSWR from "swr";

import { fetcherHandleError } from "lib/GeneralUtils";

const CrcrPinnedContext = createContext<[Highlight, any]>([
  { sha: undefined, name: undefined },
  null,
]);

// ---- Types ----

interface CrcrJobRow {
  upstream_repo: string;
  pr_number?: number;
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
  timeout_rate: number;
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
    stats.pass_rate >= 1.0
      ? "#2e7d32"
      : stats.pass_rate >= 0.9
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
          label="Timeout Rate"
          value={`${(stats.timeout_rate * 100).toFixed(1)}%`}
          sub={`${stats.timed_out} timed out / ${stats.total_jobs} jobs`}
          color={
            stats.timeout_rate >= 0.1
              ? "#d32f2f"
              : stats.timeout_rate > 0
              ? "#ed6c02"
              : undefined
          }
        />
      </Box>
    </Stack>
  );
}

function NightlySummaryCards({ data }: { data: CrcrJobRow[] }) {
  const stats = useMemo(() => {
    const completed = data.filter((j) => j.status === "completed");
    const successes = completed.filter(
      (j) => j.conclusion === "success"
    ).length;
    const failures = completed.filter((j) => j.conclusion === "failure").length;
    const timedOut = completed.filter(
      (j) => j.conclusion === "timed_out"
    ).length;
    const total = completed.length;
    const passRate = total > 0 ? successes / total : 0;
    const uniqueShas = new Set(data.map((j) => j.pytorch_head_sha)).size;
    return { successes, failures, timedOut, total, passRate, uniqueShas };
  }, [data]);

  const passColor =
    stats.passRate >= 1.0
      ? "#2e7d32"
      : stats.passRate >= 0.9
      ? "#ed6c02"
      : "#d32f2f";

  return (
    <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
      <StatCard
        label="Pass Rate"
        value={`${(stats.passRate * 100).toFixed(1)}%`}
        sub={`${stats.successes}/${stats.total} jobs`}
        color={passColor}
      />
      <StatCard
        label="Nightly Runs"
        value={stats.uniqueShas}
        sub="unique SHAs tested"
      />
      <StatCard
        label="Failures"
        value={stats.failures}
        sub={stats.timedOut > 0 ? `+ ${stats.timedOut} timed out` : ""}
        color={stats.failures > 0 ? "#d32f2f" : undefined}
      />
    </Box>
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

function JobCellTooltipContent({ job }: { job: CrcrJobRow }) {
  const conclusion = job.status === "completed" ? job.conclusion : job.status;
  const lines = [
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
  ].filter(Boolean);

  return (
    <div style={{ whiteSpace: "pre-line", fontSize: "0.8rem" }}>
      {lines.join("\n")}
      {job.workflow_run_url && (
        <div style={{ marginTop: 4 }}>
          <a
            href={job.workflow_run_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--link-color, #58a6ff)" }}
          >
            Show log ›
          </a>
        </div>
      )}
    </div>
  );
}

function JobCell({ job, sha }: { job: CrcrJobRow; sha: string }) {
  const conclusion =
    job.status === "completed"
      ? job.conclusion
      : job.status === "in_progress"
      ? "pending"
      : job.status;
  const char = getConclusionChar(conclusion);
  const color = conclusionCssColor[conclusion] ?? "var(--color-grey, #8b949e)";
  const [pinnedId, setPinnedId] = useContext(CrcrPinnedContext);

  return (
    <TooltipTarget
      sha={sha}
      name={job.job_name}
      pinnedId={pinnedId}
      setPinnedId={setPinnedId}
      tooltipContent={<JobCellTooltipContent job={job} />}
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
          cursor: "pointer",
        }}
      >
        {char}
      </span>
    </TooltipTarget>
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
  sha,
}: {
  jobs: CrcrJobRow[];
  groupName: string;
  sha: string;
}) {
  const [pinnedId, setPinnedId] = useContext(CrcrPinnedContext);

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

  const tooltipContent = (
    <div style={{ whiteSpace: "pre-line", fontSize: "0.8rem" }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {groupName} ({jobs.length} jobs)
      </div>
      {jobs.map((j) => {
        const c = j.status === "completed" ? j.conclusion : j.status;
        return (
          <div key={j.job_name}>
            {j.workflow_run_url ? (
              <a
                href={j.workflow_run_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--link-color, #58a6ff)" }}
              >
                {j.job_name}
              </a>
            ) : (
              j.job_name
            )}
            : {c}
          </div>
        );
      })}
    </div>
  );

  return (
    <TooltipTarget
      sha={sha}
      name={groupName}
      pinnedId={pinnedId}
      setPinnedId={setPinnedId}
      tooltipContent={tooltipContent}
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
          cursor: "pointer",
        }}
      >
        {char}
      </span>
    </TooltipTarget>
  );
}

function buildMatrix(data: CrcrJobRow[]): {
  jobNames: string[];
  rows: MatrixRow[];
} {
  const jobNamesSet = new Set<string>();
  const prMap = new Map<number, MatrixRow>();

  for (const job of data) {
    const prNum = job.pr_number ?? 0;
    if (prNum <= 0) continue;
    jobNamesSet.add(job.job_name);
    let row = prMap.get(prNum);
    if (!row) {
      row = {
        prNumber: prNum,
        sha: job.pytorch_head_sha,
        upstreamRepo: job.upstream_repo ?? "pytorch/pytorch",
        latestTime: job.started_at,
        jobs: new Map(),
      };
      prMap.set(prNum, row);
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
    (a, b) =>
      new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime()
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
  const { data } = useSWR<PrInfo[]>(url, fetcherHandleError, {
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

// ---- Commit Info Hook (for nightly view) ----

interface CommitInfo {
  sha: string;
  title: string;
  author: string;
}

function useCommitInfo(
  upstreamRepo: string,
  shas: string[]
): Map<string, CommitInfo> {
  const dedupedShas = useMemo(
    () => Array.from(new Set(shas.filter(Boolean))).slice(0, 50),
    [shas]
  );
  const url =
    upstreamRepo && dedupedShas.length > 0
      ? `/api/crcr/commit-info?repo=${encodeURIComponent(
          upstreamRepo
        )}&shas=${encodeURIComponent(dedupedShas.join(","))}`
      : null;
  const { data } = useSWR<CommitInfo[]>(url, fetcherHandleError, {
    revalidateOnFocus: false,
  });

  return useMemo(() => {
    const map = new Map<string, CommitInfo>();
    if (data) {
      for (const c of data) {
        map.set(c.sha, c);
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
  const { data, error } = useSWR<CrcrJobRow[]>(url, fetcherHandleError, {
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
  const [pinnedId, setPinnedId] = useContext(CrcrPinnedContext);

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
      <div style={{ overflowX: "auto", overflowY: "visible" }}>
        <table className={hudStyles.hudTable}>
          <colgroup>
            <col className={hudStyles.colTime} />
            <col className={hudStyles.colSha} />
            <col className={hudStyles.colCommit} />
            <col className={hudStyles.colPr} />
            <col className={hudStyles.colAuthor} />
            {columns.map((col) => (
              <col key={col.name} className={hudStyles.colJob} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className={hudStyles.regularHeader}>Time</th>
              <th className={hudStyles.regularHeader}>SHA</th>
              <th className={hudStyles.regularHeader}>Commit</th>
              <th className={hudStyles.regularHeader}>PR</th>
              <th className={hudStyles.regularHeader}>Author</th>
              {columns.map((col) => (
                <th
                  key={col.name}
                  className={hudStyles.jobHeader}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinnedId({
                      sha: undefined,
                      name: pinnedId.name === col.name ? undefined : col.name,
                    });
                  }}
                >
                  <div
                    className={hudStyles.jobHeaderName}
                    style={{
                      fontWeight: col.type === "group" ? 700 : 400,
                    }}
                  >
                    <span
                      className={
                        pinnedId.name === col.name ? hudStyles.highlight : ""
                      }
                    >
                      {col.name}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const pr = prInfoMap.get(row.prNumber);
              const commitTitle = pr?.title ?? `PR #${row.prNumber}`;

              const isRowHighlighted = pinnedId.sha === row.sha;
              const rowClass = isRowHighlighted ? hudStyles.highlight : "";

              return (
                <tr
                  key={row.prNumber}
                  className={rowClass}
                  onClick={(e) => {
                    if (
                      pinnedId.name !== undefined ||
                      pinnedId.sha !== undefined
                    ) {
                      return;
                    }
                    e.stopPropagation();
                    setPinnedId({ sha: row.sha, name: undefined });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td className={hudStyles.jobMetadata}>
                    <LocalTimeDisplay timestamp={row.latestTime} />
                  </td>
                  <td className={hudStyles.jobMetadata}>
                    <a
                      href={`https://github.com/${row.upstreamRepo}/commit/${row.sha}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {row.sha ? row.sha.substring(0, 7) : "–"}
                    </a>
                  </td>
                  <td className={hudStyles.jobMetadata}>
                    <div className={hudStyles.jobMetadataTruncated}>
                      <a
                        href={`https://github.com/${row.upstreamRepo}/pull/${row.prNumber}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={commitTitle}
                      >
                        {commitTitle}
                      </a>
                    </div>
                  </td>
                  <td className={hudStyles.jobMetadata}>
                    <a
                      href={`https://github.com/${row.upstreamRepo}/pull/${row.prNumber}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      #{row.prNumber}
                    </a>
                  </td>
                  <td className={hudStyles.jobMetadata}>
                    <div className={hudStyles.jobMetadataTruncatedAuthor}>
                      {pr?.author ? (
                        <a
                          href={`https://github.com/${pr.author}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {pr.author}
                        </a>
                      ) : (
                        "–"
                      )}
                    </div>
                  </td>
                  {columns.map((col) => {
                    const colHighlight =
                      pinnedId.name === col.name ? hudStyles.highlight : "";
                    if (col.type === "group" && col.members) {
                      const groupJobs = col.members
                        .map((m) => row.jobs.get(m))
                        .filter((j): j is CrcrJobRow => j != null);
                      return (
                        <td
                          key={col.name}
                          className={`${hudStyles.jobMetadata} ${colHighlight}`}
                          style={{ textAlign: "center" }}
                        >
                          {groupJobs.length > 0 ? (
                            <GroupedJobCell
                              jobs={groupJobs}
                              groupName={col.name}
                              sha={row.sha}
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
                        className={`${hudStyles.jobMetadata} ${colHighlight}`}
                        style={{ textAlign: "center" }}
                      >
                        {job ? <JobCell job={job} sha={row.sha} /> : "–"}
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

// ---- Nightly Matrix Table ----

interface NightlyRow {
  sha: string;
  upstreamRepo: string;
  latestTime: string;
  jobs: Map<string, CrcrJobRow>;
}

function buildNightlyMatrix(data: CrcrJobRow[]): {
  jobNames: string[];
  rows: NightlyRow[];
} {
  const jobNamesSet = new Set<string>();
  const shaMap = new Map<string, NightlyRow>();

  for (const job of data) {
    jobNamesSet.add(job.job_name);
    const sha = job.pytorch_head_sha || "unknown";
    let row = shaMap.get(sha);
    if (!row) {
      row = {
        sha,
        upstreamRepo: job.upstream_repo ?? "pytorch/pytorch",
        latestTime: job.started_at,
        jobs: new Map(),
      };
      shaMap.set(sha, row);
    }
    if (job.started_at > row.latestTime) {
      row.latestTime = job.started_at;
    }
    const existing = row.jobs.get(job.job_name);
    if (!existing || job.run_attempt > existing.run_attempt) {
      row.jobs.set(job.job_name, job);
    }
  }

  const jobNames = Array.from(jobNamesSet).sort();
  const rows = Array.from(shaMap.values()).sort(
    (a, b) =>
      new Date(b.latestTime).getTime() - new Date(a.latestTime).getTime()
  );
  return { jobNames, rows };
}

function CrcrNightlyMatrix({
  repoFullName,
  days,
}: {
  repoFullName: string;
  days: number;
}) {
  const url = `/api/clickhouse/crcr_nightly_dashboard?parameters=${encodeURIComponent(
    JSON.stringify({ repo: repoFullName, days: String(days) })
  )}`;
  const { data, error } = useSWR<CrcrJobRow[]>(url, fetcherHandleError, {
    refreshInterval: 60_000,
  });

  const { matrix, columns } = useMemo(() => {
    if (!data) return { matrix: null, columns: [] };
    const full = buildNightlyMatrix(data);
    return {
      matrix: full,
      columns: detectGroups(full.jobNames),
    };
  }, [data]);

  const upstreamRepo = matrix?.rows[0]?.upstreamRepo ?? "pytorch/pytorch";
  const nightlyShas = useMemo(
    () => (matrix?.rows ?? []).map((r) => r.sha),
    [matrix]
  );
  const commitInfoMap = useCommitInfo(upstreamRepo, nightlyShas);
  const [pinnedId, setPinnedId] = useContext(CrcrPinnedContext);

  if (error) {
    return (
      <Typography color="error">
        Failed to load nightly dashboard: {error.message}
      </Typography>
    );
  }
  if (!data || !matrix) {
    return <Skeleton variant="rectangular" height={400} />;
  }
  if (data.length === 0) {
    return (
      <Typography color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        No nightly results for {repoFullName} in the last {days} days.
      </Typography>
    );
  }

  return (
    <>
      <NightlySummaryCards data={data} />
      <div style={{ overflowX: "auto", overflowY: "visible" }}>
        <table className={hudStyles.hudTable}>
          <colgroup>
            <col className={hudStyles.colTime} />
            <col className={hudStyles.colSha} />
            <col className={hudStyles.colCommit} />
            {columns.map((col) => (
              <col key={col.name} className={hudStyles.colJob} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className={hudStyles.regularHeader}>Time</th>
              <th className={hudStyles.regularHeader}>SHA</th>
              <th className={hudStyles.regularHeader}>Commit</th>
              {columns.map((col) => (
                <th
                  key={col.name}
                  className={hudStyles.jobHeader}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinnedId({
                      sha: undefined,
                      name: pinnedId.name === col.name ? undefined : col.name,
                    });
                  }}
                >
                  <div
                    className={hudStyles.jobHeaderName}
                    style={{
                      fontWeight: col.type === "group" ? 700 : 400,
                    }}
                  >
                    <span
                      className={
                        pinnedId.name === col.name
                          ? hudStyles.highlight
                          : ""
                      }
                    >
                      {col.name}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const commit = commitInfoMap.get(row.sha);
              const commitTitle =
                commit?.title || `nightly (${row.sha.substring(0, 12)})`;
              const isRowHighlighted = pinnedId.sha === row.sha;
              const rowClass = isRowHighlighted ? hudStyles.highlight : "";
              return (
                <tr
                  key={row.sha}
                  className={rowClass}
                  onClick={(e) => {
                    if (
                      pinnedId.name !== undefined ||
                      pinnedId.sha !== undefined
                    ) {
                      return;
                    }
                    e.stopPropagation();
                    setPinnedId({ sha: row.sha, name: undefined });
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td className={hudStyles.jobMetadata}>
                    <LocalTimeDisplay timestamp={row.latestTime} />
                  </td>
                  <td className={hudStyles.jobMetadata}>
                    <span className={hudStyles.mono}>
                      <a
                        href={`https://github.com/${row.upstreamRepo}/commit/${row.sha}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {row.sha.substring(0, 7)}
                      </a>
                    </span>
                  </td>
                  <td className={hudStyles.jobMetadataTruncated}>
                    <Tooltip title={commitTitle}>
                      <a
                        href={`https://github.com/${row.upstreamRepo}/commit/${row.sha}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {commitTitle}
                      </a>
                    </Tooltip>
                  </td>
                  {columns.map((col) => {
                    const colHighlight =
                      pinnedId.name === col.name ? hudStyles.highlight : "";
                    if (col.type === "group" && col.members) {
                      const groupJobs = col.members
                        .map((m) => row.jobs.get(m))
                        .filter((j): j is CrcrJobRow => j != null);
                      return (
                        <td
                          key={col.name}
                          className={`${hudStyles.jobMetadata} ${colHighlight}`}
                          style={{ textAlign: "center" }}
                        >
                          {groupJobs.length > 0 ? (
                            <GroupedJobCell
                              jobs={groupJobs}
                              groupName={col.name}
                              sha={row.sha}
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
                        className={`${hudStyles.jobMetadata} ${colHighlight}`}
                        style={{ textAlign: "center" }}
                      >
                        {job ? <JobCell job={job} sha={row.sha} /> : "–"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---- Main Page ----

export default function CrcrBackendPage() {
  const router = useRouter();
  const { org, repo } = router.query;

  const page = parseInt(router.query.page as string) || 1;
  const days = parseInt(router.query.days as string) || 7;
  const eventType = (router.query.event as string) || "pr";
  const isNightly = eventType === "nightly";

  const repoFullName = org && repo ? `${org}/${repo}` : "";

  const summaryUrl =
    repoFullName && !isNightly
      ? `/api/clickhouse/crcr_backend_summary?parameters=${encodeURIComponent(
          JSON.stringify({ repo: repoFullName, days: String(days) })
        )}`
      : null;
  const { data: summaryData } = useSWR<SummaryStats[]>(
    summaryUrl,
    fetcherHandleError,
    { refreshInterval: 60_000 }
  );
  const stats = summaryData?.[0] ?? null;

  const [pinnedTooltip, setPinnedTooltip] = useState<Highlight>({
    sha: undefined,
    name: undefined,
  });

  function handleGlobalClick() {
    setPinnedTooltip({ sha: undefined, name: undefined });
  }

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        setPinnedTooltip({ sha: undefined, name: undefined });
      }
    },
    [setPinnedTooltip]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  if (!org || !repo) return null;

  function updateQuery(updates: Record<string, string | number>) {
    router.push(
      { pathname: router.pathname, query: { ...router.query, ...updates } },
      undefined,
      { shallow: true }
    );
  }

  const pageTitle = isNightly ? `${repoFullName} : nightly` : repoFullName;

  return (
    <>
      <Head>
        <title>{pageTitle} — CRCR CI | PyTorch HUD</title>
      </Head>
      <CrcrPinnedContext.Provider value={[pinnedTooltip, setPinnedTooltip]}>
        <div onClick={handleGlobalClick}>
          <Stack spacing={3} sx={{ p: 3, maxWidth: 1600, mx: "auto" }}>
            <Box
              display="flex"
              justifyContent="space-between"
              alignItems="center"
            >
              <Stack spacing={0.5}>
                <Typography variant="h4">
                  {repoFullName}
                  {isNightly && (
                    <Typography
                      component="span"
                      variant="h4"
                      sx={{
                        color: "text.secondary",
                        fontWeight: 300,
                        mx: 1,
                      }}
                    >
                      : nightly
                    </Typography>
                  )}
                </Typography>
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

            {!isNightly && (
              <>
                {stats ? (
                  <SummaryCards stats={stats} />
                ) : (
                  <Skeleton variant="rectangular" height={140} />
                )}
              </>
            )}

            <Typography variant="body2" color="text.secondary">
              {isNightly
                ? "Rows = nightly CI runs (one per SHA), columns = build & test stages. Click a cell to pin its tooltip, click a column header to highlight the column, or click a row to highlight it. Press Escape to dismiss."
                : "Rows = PyTorch PRs (50 per page), columns = downstream CI jobs. Click a cell to pin its tooltip, click a column header to highlight the column, or click a row to highlight it. Press Escape to dismiss."}
            </Typography>

            {isNightly ? (
              <CrcrNightlyMatrix repoFullName={repoFullName} days={days} />
            ) : (
              <CrcrMatrix
                repoFullName={repoFullName}
                days={days}
                page={page}
                onPageChange={(p) => updateQuery({ page: p })}
              />
            )}
          </Stack>
        </div>
      </CrcrPinnedContext.Provider>
    </>
  );
}
