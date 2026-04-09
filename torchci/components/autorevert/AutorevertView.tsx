import { Box, Chip, Skeleton, Typography } from "@mui/material";
import {
  AdvisorVerdictRow,
  deduplicateVerdicts,
} from "lib/advisorVerdictUtils";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useMemo, useState } from "react";
import useSWR from "swr";
import AutorevertControls from "./AutorevertControls";
import AutorevertGrid from "./AutorevertGrid";
import { AutorevertStateResponse } from "./types";
import { fetcher } from "lib/GeneralUtils";

dayjs.extend(utc);

const DEFAULT_WORKFLOWS = ["Lint", "trunk", "pull"];

interface CommitInfoRow {
  sha: string;
  message: string;
  author: string;
  time: string;
}

export default function AutorevertView() {
  const [timestamp, setTimestamp] = useState(dayjs());
  const [selectedWorkflows, setSelectedWorkflows] =
    useState<string[]>(DEFAULT_WORKFLOWS);
  const [signalFilter, setSignalFilter] = useState("");

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

  const snapshotTime = stateData?.ts
    ? dayjs(stateData.ts).local().format("YYYY-MM-DD h:mm:ss A")
    : null;

  const handleTimestampFromGrid = (isoTime: string) => {
    // Parse the same way LocalTimeHuman does
    setTimestamp(dayjs(isoTime).local());
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          mb: 1,
        }}
      >
        <Typography variant="subtitle2" color="text.secondary">
          Autorevert Signal Grid
        </Typography>
        <Chip label="BETA" color="warning" size="small" />
        {snapshotTime && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ ml: 1, fontFamily: "monospace" }}
          >
            Snapshot: {snapshotTime}
          </Typography>
        )}
        {stateValid && (
          <Typography variant="caption" color="text.secondary">
            ({stateData.columns.length} signals, {stateData.commits.length}{" "}
            commits)
          </Typography>
        )}
      </Box>

      <AutorevertControls
        timestamp={timestamp}
        onTimestampChange={setTimestamp}
        availableWorkflows={stateData?.availableWorkflows || []}
        selectedWorkflows={selectedWorkflows}
        onWorkflowsChange={setSelectedWorkflows}
        signalFilter={signalFilter}
        onSignalFilterChange={setSignalFilter}
      />

      {stateLoading && !stateData && (
        <Skeleton variant="rectangular" height={400} sx={{ mt: 2 }} />
      )}

      {stateValid && (
        <AutorevertGrid
          state={stateData}
          signalFilter={signalFilter}
          advisorVerdicts={advisorVerdicts}
          commitInfos={commitInfoRows}
          onTimestampChange={handleTimestampFromGrid}
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
