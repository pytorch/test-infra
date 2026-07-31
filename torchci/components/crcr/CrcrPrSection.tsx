import { Stack, styled, Tooltip, Typography } from "@mui/material";
import styles from "components/commit/commit.module.css";
import { durationDisplay } from "components/common/TimeUtils";
import JobConclusion from "components/job/JobConclusion";
import { fetcher } from "lib/GeneralUtils";
import _ from "lodash";

import useSWR from "swr";

interface CrcrPrResult {
  downstream_repo: string;
  downstream_repo_level: string;
  workflow_name: string;
  job_name: string;
  check_run_id: string;
  run_id: string;
  run_attempt: number;
  status: string;
  conclusion: string;
  duration_seconds: number;
  workflow_run_url: string;
  artifact_url: string;
  started_at: string;
  queue_time: number | null;
  execution_time: number | null;
}

function crcrToConclusion(status: string, conclusion: string): string {
  if (status === "in_progress") return "pending";
  return conclusion || "pending";
}

function isFailedResult(r: CrcrPrResult): boolean {
  return (
    r.status === "completed" &&
    r.conclusion !== "success" &&
    r.conclusion !== "skipped"
  );
}

const LinkButton = styled("a")({
  fontSize: "8px",
  padding: "0 2px",
  color: "green",
  margin: "2px",
  border: "1px solid rgba(0,128,0,0.5)",
  borderRadius: "3px",
  textDecoration: "none",
});

function CrcrJobLine({ result }: { result: CrcrPrResult }) {
  const conclusion = crcrToConclusion(result.status, result.conclusion);

  const subInfo = [];
  if (result.queue_time != null) {
    subInfo.push(`Queued: ${durationDisplay(Math.max(result.queue_time, 0))}`);
  }
  if (result.status === "in_progress") {
    subInfo.push("Running");
  } else if (result.execution_time != null) {
    subInfo.push(
      `Duration: ${durationDisplay(Math.round(result.execution_time))}`
    );
  } else if (result.duration_seconds) {
    subInfo.push(
      `Duration: ${durationDisplay(Math.round(result.duration_seconds))}`
    );
  }

  return (
    <div>
      <JobConclusion conclusion={conclusion} />
      {result.workflow_run_url ? (
        <a href={result.workflow_run_url} target="_blank" rel="noreferrer">
          {" "}
          {result.job_name}{" "}
        </a>
      ) : (
        <span> {result.job_name} </span>
      )}
      <br />
      <small>
        &nbsp;&nbsp;&nbsp;&nbsp;
        {subInfo.join(" ")}
        {result.workflow_run_url && (
          <>
            {" "}
            <LinkButton
              href={result.workflow_run_url}
              target="_blank"
              rel="noreferrer"
            >
              Run
            </LinkButton>
          </>
        )}
        {result.artifact_url && (
          <LinkButton
            href={result.artifact_url}
            target="_blank"
            rel="noreferrer"
          >
            Artifacts
          </LinkButton>
        )}
      </small>
    </div>
  );
}

function CrcrBackendBox({
  repoName,
  level,
  results,
}: {
  repoName: string;
  level: string;
  results: CrcrPrResult[];
}) {
  const hasFailed = results.some(isFailedResult);
  const hasPending = results.some((r) => r.status === "in_progress");

  const boxClass = hasFailed
    ? styles.workflowBoxFail
    : hasPending
    ? styles.workflowBoxPending
    : styles.workflowBoxSuccess;

  const sorted = _.orderBy(
    results,
    [
      (r) => {
        if (isFailedResult(r)) return 0;
        if (r.status === "in_progress") return 1;
        return 2;
      },
      (r) => r.job_name,
    ],
    ["asc", "asc"]
  );

  return (
    <div className={boxClass}>
      <Typography variant="h6" fontWeight="bold" paddingTop={2}>
        <a
          href={`/crcr/${repoName.replace("/", "/")}`}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {repoName}
        </a>
        <span className={styles.crcrLevelBadge}>{level}</span>
      </Typography>
      <Typography fontWeight="bold" paddingBottom={2}>
        Job Status
      </Typography>
      {sorted.map((r, i) => (
        <CrcrJobLine key={`${r.check_run_id}-${i}`} result={r} />
      ))}
    </div>
  );
}

export default function CrcrPrSection({ prNumber }: { prNumber: number }) {
  const url = `/api/clickhouse/crcr_pr_results?parameters=${encodeURIComponent(
    JSON.stringify({ pr: String(prNumber) })
  )}`;
  const { data, error } = useSWR<CrcrPrResult[]>(url, fetcher, {
    refreshInterval: 60_000,
  });

  if (error || !data || data.length === 0) return null;

  const byRepo = _.groupBy(data, "downstream_repo");
  const repoNames = Object.keys(byRepo).sort();

  const totalBackends = repoNames.length;

  return (
    <div className={styles.crcrSection}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6" fontWeight="bold">
          Cross-Repo CI Backends
        </Typography>
        <Tooltip title="Results from downstream CI backends via the Cross-Repository CI Relay (CRCR)">
          <Typography
            sx={{
              fontSize: "0.7rem",
              px: 1,
              py: 0.25,
              borderRadius: "10px",
              bgcolor: "#0288d1",
              color: "#fff",
              fontWeight: 600,
            }}
          >
            CRCR
          </Typography>
        </Tooltip>
        <Typography variant="body2" color="text.secondary">
          ({totalBackends} backend{totalBackends !== 1 ? "s" : ""} dispatched)
        </Typography>
      </Stack>
      <div className={styles.crcrBackendsGrid}>
        {repoNames.map((repo) => {
          const results = byRepo[repo];
          const level = results[0]?.downstream_repo_level || "L2";
          return (
            <CrcrBackendBox
              key={repo}
              repoName={repo}
              level={level}
              results={results}
            />
          );
        })}
      </div>
    </div>
  );
}
