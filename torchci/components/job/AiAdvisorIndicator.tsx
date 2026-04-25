import { Button, Chip, CircularProgress, Tooltip } from "@mui/material";
import { fetcher } from "lib/GeneralUtils";
import { AdvisorVerdict, AdvisorVerdictType } from "lib/advisorVerdictUtils";
import { useSession } from "next-auth/react";
import { useRouter } from "next/router";
import { useCallback, useState } from "react";
import useSWR from "swr";
import AdvisorSection from "./AdvisorSection";

const DISPATCH_STORAGE_KEY = "ai_advisor_dispatches";
const DISPATCH_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface DispatchEntry {
  timestamp: number;
}

function getDispatchKey(
  prNumber: number,
  sha: string,
  signalKey: string
): string {
  return `${prNumber}:${sha}:${signalKey}`;
}

function getDispatches(): Record<string, DispatchEntry> {
  try {
    const raw = localStorage.getItem(DISPATCH_STORAGE_KEY);
    if (!raw) return {};
    const entries = JSON.parse(raw) as Record<string, DispatchEntry>;
    const now = Date.now();
    const valid: Record<string, DispatchEntry> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (now - v.timestamp < DISPATCH_TTL_MS) {
        valid[k] = v;
      }
    }
    if (Object.keys(valid).length !== Object.keys(entries).length) {
      localStorage.setItem(DISPATCH_STORAGE_KEY, JSON.stringify(valid));
    }
    return valid;
  } catch {
    return {};
  }
}

function markDispatched(
  prNumber: number,
  sha: string,
  signalKey: string
): void {
  const dispatches = getDispatches();
  dispatches[getDispatchKey(prNumber, sha, signalKey)] = {
    timestamp: Date.now(),
  };
  localStorage.setItem(DISPATCH_STORAGE_KEY, JSON.stringify(dispatches));
}

function isDispatched(
  prNumber: number,
  sha: string,
  signalKey: string
): boolean {
  const dispatches = getDispatches();
  const entry = dispatches[getDispatchKey(prNumber, sha, signalKey)];
  if (!entry) return false;
  return Date.now() - entry.timestamp < DISPATCH_TTL_MS;
}

const VERDICT_CHIP_COLORS: Record<
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

export default function AiAdvisorIndicator({
  jobName,
  sha,
  prNumber,
  conclusion,
  mergeBaseSha,
  workflowName,
}: {
  jobName: string;
  sha: string;
  prNumber: number;
  conclusion?: string;
  mergeBaseSha?: string;
  workflowName?: string;
}) {
  const isFailed =
    conclusion === "failure" ||
    conclusion === "cancelled" ||
    conclusion === "timed_out";
  const router = useRouter();
  const { repoOwner, repoName } = router.query;
  const session = useSession();
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState("");

  // dr_ci_ prefix separates HUD-dispatched verdicts from autorevert-system ones
  const signalKey = `dr_ci_${jobName}`;

  const { data: verdicts } = useSWR<AdvisorVerdict[]>(
    prNumber
      ? `/api/${repoOwner}/${repoName}/pull/advisor-runs?prNumber=${prNumber}`
      : null,
    fetcher,
    { refreshInterval: 60_000 }
  );

  const matchingVerdict = verdicts?.find(
    (v) => v.signalKey === signalKey && v.sha === sha
  );

  const dispatched = !matchingVerdict && isDispatched(prNumber, sha, signalKey);

  const isAuthenticated =
    session?.data &&
    session.data["accessToken"] !== undefined &&
    session.data["user"] !== undefined;

  const [, setTick] = useState(0);

  const handleDispatch = useCallback(async () => {
    if (!isAuthenticated || dispatching || dispatched) return;

    setDispatching(true);
    setError("");

    try {
      const res = await fetch(
        `/api/${repoOwner}/${repoName}/pull/dispatch-advisor`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: session.data!["accessToken"] as string,
          },
          body: JSON.stringify({
            prNumber,
            headSha: sha,
            mergeBaseSha: mergeBaseSha || "",
            jobName,
            workflowName: workflowName || "",
          }),
        }
      );

      if (res.status === 409) {
        // Already dispatched — treat as success so we show "Dispatched"
        markDispatched(prNumber, sha, signalKey);
        setTick((t) => t + 1);
        return;
      }

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      markDispatched(prNumber, sha, signalKey);
      setTick((t) => t + 1);
    } catch (e: any) {
      setError(e.message || "Failed to dispatch");
    } finally {
      setDispatching(false);
    }
  }, [
    isAuthenticated,
    dispatching,
    dispatched,
    repoOwner,
    repoName,
    prNumber,
    sha,
    mergeBaseSha,
    jobName,
    signalKey,
    workflowName,
    session.data,
  ]);

  const chipColor =
    VERDICT_CHIP_COLORS[matchingVerdict?.verdict as AdvisorVerdictType] ||
    "default";
  const chipLabel =
    VERDICT_LABELS[matchingVerdict?.verdict as AdvisorVerdictType] ||
    matchingVerdict?.verdict;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {matchingVerdict && (
        <Tooltip
          title={
            <AdvisorSection
              verdict={matchingVerdict}
              repoOwner={repoOwner as string}
              repoName={repoName as string}
            />
          }
          arrow
          placement="bottom-start"
          slotProps={{
            tooltip: {
              sx: { maxWidth: 500, fontSize: "inherit", p: 0.5 },
            },
          }}
        >
          <Chip
            label={`AI: ${chipLabel}`}
            color={chipColor}
            size="small"
            variant="outlined"
            sx={{ ml: 1, cursor: "pointer" }}
          />
        </Tooltip>
      )}
      {!matchingVerdict && !dispatched && isFailed && isAuthenticated && (
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
              <CircularProgress size={14} sx={{ mr: 0.5 }} />
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
