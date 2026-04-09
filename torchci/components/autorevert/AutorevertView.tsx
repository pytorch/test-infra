import { Alert, Box, Chip, Collapse, Skeleton, Typography } from "@mui/material";
import AutorevertLegend from "./AutorevertLegend";
import CommitSummary from "./CommitSummary";
import {
  AdvisorVerdictRow,
  deduplicateVerdicts,
} from "lib/advisorVerdictUtils";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import AutorevertControls from "./AutorevertControls";
import AutorevertGrid from "./AutorevertGrid";
import { AutorevertStateResponse, ensureUtc } from "./types";
import { fetcher } from "lib/GeneralUtils";

dayjs.extend(utc);

const DEFAULT_WORKFLOWS = ["Lint", "trunk", "pull"];

// URL param keys (prefixed with ar_ to avoid conflicts with HUD params)
const PARAM_TS = "ar_ts";
const PARAM_WF = "ar_wf";
const PARAM_SF = "ar_sf";
const PARAM_SHA = "ar_sha";

/** Read autorevert params from current URL */
function readUrlParams(): {
  ts?: dayjs.Dayjs;
  workflows?: string[];
  signalFilter?: string;
  highlightSha?: string;
} {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const result: ReturnType<typeof readUrlParams> = {};

  const tsStr = params.get(PARAM_TS);
  if (tsStr) {
    const parsed = dayjs(tsStr);
    if (parsed.isValid()) result.ts = parsed;
  }

  const wfStr = params.get(PARAM_WF);
  if (wfStr) {
    result.workflows = wfStr.split(",").filter(Boolean);
  }

  const sf = params.get(PARAM_SF);
  if (sf) result.signalFilter = sf;

  const sha = params.get(PARAM_SHA);
  if (sha) result.highlightSha = sha;

  return result;
}

/** Update URL params without navigation */
function updateUrlParams(updates: Record<string, string | null>) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  window.history.replaceState({}, "", url.toString());
}

interface CommitInfoRow {
  sha: string;
  message: string;
  author: string;
  time: string;
}

export default function AutorevertView() {
  // Initialize state from URL params
  const urlParams = useMemo(() => readUrlParams(), []);

  const [timestamp, setTimestamp] = useState(urlParams.ts || dayjs());
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>(
    urlParams.workflows || DEFAULT_WORKFLOWS
  );
  const highlightSha = urlParams.highlightSha || null;
  const [signalFilter, setSignalFilter] = useState(
    urlParams.signalFilter || ""
  );

  // Sync state changes to URL
  const handleTimestampChange = useCallback((ts: dayjs.Dayjs) => {
    setTimestamp(ts);
    updateUrlParams({
      [PARAM_TS]: ts.utc().format("YYYY-MM-DDTHH:mm:ss[Z]"),
    });
  }, []);

  const handleWorkflowsChange = useCallback((wf: string[]) => {
    setSelectedWorkflows(wf);
    updateUrlParams({
      [PARAM_WF]: wf.length > 0 ? wf.join(",") : null,
    });
  }, []);

  const handleSignalFilterChange = useCallback((sf: string) => {
    setSignalFilter(sf);
    updateUrlParams({ [PARAM_SF]: sf || null });
  }, []);

  // Set initial URL params on mount if not already present
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(PARAM_TS)) {
      updateUrlParams({
        [PARAM_TS]: timestamp.utc().format("YYYY-MM-DDTHH:mm:ss[Z]"),
        [PARAM_WF]: selectedWorkflows.join(","),
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch merged autorevert state
  const stateUrl = useMemo(() => {
    const params: Record<string, string> = {
      ts: timestamp.utc().format("YYYY-MM-DD HH:mm:ss"),
      repo: "pytorch/pytorch",
    };
    if (selectedWorkflows.length > 0) {
      params.workflows = JSON.stringify(selectedWorkflows);
    }
    const qs = new URLSearchParams(params).toString();
    return `/api/autorevert/state?${qs}`;
  }, [timestamp, selectedWorkflows]);

  const { data: stateData, isLoading: stateLoading } =
    useSWR<AutorevertStateResponse>(stateUrl, fetcher, {
      refreshInterval: 60 * 1000,
      revalidateOnFocus: false,
    });

  // Guard: API may return error object or partial data
  const stateValid = stateData?.columns && stateData?.commits;

  // Lazy-load AI advisor verdicts for commits on screen
  const commitShas = stateValid ? stateData.commits : [];
  const { data: verdictRows } = useClickHouseAPIImmutable<AdvisorVerdictRow>(
    "advisor_verdicts_for_hud",
    {
      repo: "pytorch/pytorch",
      shas: commitShas,
    },
    commitShas.length > 0
  );
  const advisorVerdicts = useMemo(
    () => (verdictRows ? deduplicateVerdicts(verdictRows) : []),
    [verdictRows]
  );

  // Lazy-load commit info (title, author, PR number) for tooltips
  const { data: commitInfoRows } =
    useClickHouseAPIImmutable<CommitInfoRow>(
      "commit_info_for_shas",
      {
        repo: "pytorch/pytorch",
        shas: commitShas,
      },
      commitShas.length > 0
    );

  // Lazy-load autorevert events and run timestamps
  const timeRange = useMemo(() => {
    if (!stateValid || commitShas.length === 0) return null;
    const times = Object.values(stateData.commitTimes)
      .map((t) => new Date(ensureUtc(t)).getTime())
      .filter((t) => !isNaN(t));
    if (times.length === 0) return null;
    const fmt = (ms: number) =>
      new Date(ms)
        .toISOString()
        .replace("T", " ")
        .replace("Z", "")
        .replace(/\.\d+$/, "");
    return {
      start: fmt(Math.min(...times)),
      end: fmt(Math.max(...times) + 3600000),
    };
  }, [stateValid, stateData?.commitTimes, commitShas]);

  const { data: autorevertEvents } = useClickHouseAPIImmutable<{
    ts: string;
    action: string;
    commit_sha: string;
    workflows: string[];
    source_signal_keys: string[];
  }>(
    "autorevert_events_in_range",
    {
      repo: "pytorch/pytorch",
      startTime: timeRange?.start || "",
      endTime: timeRange?.end || "",
      filterWorkflows: selectedWorkflows,
    },
    timeRange !== null
  );

  const { data: runTimestamps } = useClickHouseAPIImmutable<{
    ts: string;
    workflows: string[];
  }>(
    "autorevert_run_timestamps",
    {
      repo: "pytorch/pytorch",
      startTime: timeRange?.start || "",
      endTime: timeRange?.end || "",
      filterWorkflows: selectedWorkflows,
    },
    timeRange !== null
  );

  const snapshotTime = stateData?.ts
    ? dayjs(ensureUtc(stateData.ts)).local().format("YYYY-MM-DD h:mm:ss A")
    : null;

  const handleTimestampFromGrid = (isoTime: string) => {
    const ts = dayjs(ensureUtc(isoTime)).local();
    handleTimestampChange(ts);
  };

  // Show/hide explanation (remember preference)
  const [showExplanation, setShowExplanation] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("ar_hideExplanation") !== "1";
    }
    return true;
  });
  const toggleExplanation = () => {
    const next = !showExplanation;
    setShowExplanation(next);
    localStorage.setItem("ar_hideExplanation", next ? "0" : "1");
  };

  return (
    <Box sx={{ mt: 1 }}>
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          mb: 1,
        }}
      >
        <Typography variant="h6" fontWeight="bold">
          Autorevert Signal Grid
        </Typography>
        <Chip label="BETA" color="warning" size="small" />
        {snapshotTime && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ ml: 1, fontFamily: "monospace" }}
          >
            Snapshot at {snapshotTime}
          </Typography>
        )}
        {stateValid && (
          <Typography variant="body2" color="text.secondary">
            · {stateData.columns.length} signals ·{" "}
            {stateData.commits.length} commits
          </Typography>
        )}
        <Typography
          variant="caption"
          sx={{
            ml: "auto",
            cursor: "pointer",
            color: "var(--link-color, #1a73e8)",
          }}
          onClick={toggleExplanation}
        >
          {showExplanation ? "Hide guide" : "Show guide"}
        </Typography>
      </Box>

      {/* Explanation banner */}
      <Collapse in={showExplanation}>
        <Alert
          severity="info"
          variant="outlined"
          sx={{ mb: 1, fontSize: "0.85rem" }}
        >
          This grid shows a snapshot of the{" "}
          <strong>autorevert system state</strong>. Columns are CI signals
          being monitored. Rows are recent commits (newest at top). Autorevert
          detects when a commit breaks a signal and automatically reverts it.
          Cell colors indicate the autorevert&apos;s analysis: which commit is
          suspected, which is the known-good baseline, and which newer commits
          are also affected.
        </Alert>
      </Collapse>

      {/* Legend */}
      <AutorevertLegend />

      <AutorevertControls
        timestamp={timestamp}
        onTimestampChange={handleTimestampChange}
        availableWorkflows={stateData?.availableWorkflows || []}
        selectedWorkflows={selectedWorkflows}
        onWorkflowsChange={handleWorkflowsChange}
        signalFilter={signalFilter}
        onSignalFilterChange={handleSignalFilterChange}
      />

      {stateLoading && !stateData && (
        <Skeleton variant="rectangular" height={400} sx={{ mt: 2 }} />
      )}

      {/* Commit summary section when ar_sha is in URL */}
      {stateValid && highlightSha && (
        <CommitSummary
          sha={highlightSha}
          state={stateData}
          commitInfo={commitInfoRows?.find(
            (c: CommitInfoRow) => c.sha === highlightSha
          )}
          advisorVerdicts={advisorVerdicts}
          repo="pytorch/pytorch"
        />
      )}

      {stateValid && (
        <AutorevertGrid
          state={stateData}
          signalFilter={signalFilter}
          advisorVerdicts={advisorVerdicts}
          commitInfos={commitInfoRows}
          autorevertEvents={autorevertEvents as any}
          runTimestamps={runTimestamps as any}
          onTimestampChange={handleTimestampFromGrid}
          highlightSha={highlightSha || undefined}
        />
      )}

      {!stateLoading && !stateValid && (
        <Typography
          color="text.secondary"
          sx={{ py: 4, textAlign: "center" }}
        >
          No autorevert state found for this timestamp.
        </Typography>
      )}
    </Box>
  );
}
