import {
  Button,
  Chip,
  CircularProgress,
  Tooltip,
} from "@mui/material";
import { fetcher } from "lib/GeneralUtils";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useState } from "react";
import useSWR from "swr";

interface AdvisorVerdict {
  suspectCommit: string;
  signalKey: string;
  verdict:
    | "revert"
    | "unsure"
    | "not_related"
    | "garbage";
  confidence: number;
  summary: string;
  causalReasoning: string;
  runId: number;
  timestamp: string;
}

const VERDICT_COLORS: Record<
  string,
  "error" | "warning" | "success" | "default"
> = {
  revert: "error",
  unsure: "warning",
  not_related: "success",
  garbage: "default",
};

const VERDICT_LABELS: Record<string, string> = {
  revert: "Revert",
  unsure: "Unsure",
  not_related: "Not Related",
  garbage: "Garbage Signal",
};

function VerdictChip({
  verdict,
}: {
  verdict: AdvisorVerdict;
}) {
  const color =
    VERDICT_COLORS[verdict.verdict] || "default";
  const label =
    VERDICT_LABELS[verdict.verdict] || verdict.verdict;
  const runUrl = `https://github.com/pytorch/pytorch/actions/runs/${verdict.runId}`;

  return (
    <Tooltip
      title={
        <div>
          <div>
            <strong>{label}</strong> (confidence:{" "}
            {(verdict.confidence * 100).toFixed(0)}%)
          </div>
          <div style={{ marginTop: 4 }}>
            {verdict.summary}
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: "0.85em",
              opacity: 0.8,
            }}
          >
            {new Date(verdict.timestamp).toLocaleString()}
            {" · "}
            <a
              href={runUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "inherit" }}
            >
              GHA Run
            </a>
          </div>
        </div>
      }
      arrow
    >
      <Chip
        label={`AI: ${label}`}
        color={color}
        size="small"
        variant="outlined"
        sx={{ ml: 1, cursor: "pointer" }}
        onClick={() => window.open(runUrl, "_blank")}
      />
    </Tooltip>
  );
}

export default function AiAdvisorIndicator({
  jobName,
  sha,
  prNumber,
  mergeBaseSha,
  workflowName,
}: {
  jobName: string;
  sha: string;
  prNumber: number;
  mergeBaseSha?: string;
  workflowName?: string;
}) {
  const router = useRouter();
  const { repoOwner, repoName } = router.query;
  const session = useSession();
  const [dispatching, setDispatching] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const [error, setError] = useState("");

  const { data: verdicts } = useSWR<AdvisorVerdict[]>(
    prNumber
      ? `/api/${repoOwner}/${repoName}/pull/advisor-runs?prNumber=${prNumber}`
      : null,
    fetcher,
    { refreshInterval: 60_000 },
  );

  const matchingVerdict = verdicts?.find(
    (v) =>
      v.signalKey === jobName && v.suspectCommit === sha,
  );

  const isAuthenticated =
    session?.data &&
    session.data["accessToken"] !== undefined &&
    session.data["user"] !== undefined;

  const handleDispatch = async () => {
    if (!isAuthenticated || dispatching || dispatched)
      return;

    setDispatching(true);
    setError("");

    try {
      const res = await fetch(
        `/api/${repoOwner}/${repoName}/pull/dispatch-advisor`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: session.data![
              "accessToken"
            ] as string,
          },
          body: JSON.stringify({
            prNumber,
            headSha: sha,
            mergeBaseSha: mergeBaseSha || "",
            jobName,
            workflowName: workflowName || "",
          }),
        },
      );

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      setDispatched(true);
    } catch (e: any) {
      setError(e.message || "Failed to dispatch");
    } finally {
      setDispatching(false);
    }
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {matchingVerdict && (
        <VerdictChip verdict={matchingVerdict} />
      )}
      {!matchingVerdict &&
        !dispatched &&
        isAuthenticated && (
          <Tooltip title="Run AI advisor to analyze this failure">
            <Button
              size="small"
              variant="outlined"
              onClick={handleDispatch}
              disabled={dispatching}
              sx={{
                ml: 1,
                textTransform: "none",
                fontSize: "0.75rem",
                py: 0,
                minHeight: 24,
              }}
            >
              {dispatching ? (
                <CircularProgress
                  size={14}
                  sx={{ mr: 0.5 }}
                />
              ) : (
                "🤖"
              )}{" "}
              AI Analyze
            </Button>
          </Tooltip>
        )}
      {dispatched && (
        <Chip
          label="AI: Dispatched"
          size="small"
          variant="outlined"
          color="info"
          sx={{ ml: 1 }}
        />
      )}
      {error && (
        <Chip
          label={`Error: ${error}`}
          size="small"
          variant="outlined"
          color="error"
          sx={{ ml: 1 }}
        />
      )}
    </span>
  );
}
