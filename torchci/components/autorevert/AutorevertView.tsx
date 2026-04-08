import { Box, Chip, Skeleton, Typography } from "@mui/material";
import {
  AdvisorVerdictRow,
  deduplicateVerdicts,
} from "lib/advisorVerdictUtils";
import { fetcher, useClickHouseAPIImmutable } from "lib/GeneralUtils";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import AutorevertControls from "./AutorevertControls";
import AutorevertGrid from "./AutorevertGrid";
import { AutorevertStateResponse } from "./types";

dayjs.extend(utc);

export default function AutorevertView() {
  const [timestamp, setTimestamp] = useState(dayjs());
  const [selectedWorkflows, setSelectedWorkflows] = useState<string[]>([]);
  const [signalFilter, setSignalFilter] = useState("");
  const [workflowsInitialized, setWorkflowsInitialized] = useState(false);

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

  // Initialize workflow selection from available workflows
  const handleStateData = useCallback(
    (data: AutorevertStateResponse | undefined) => {
      if (data && !workflowsInitialized && data.availableWorkflows.length > 0) {
        setSelectedWorkflows(data.availableWorkflows);
        setWorkflowsInitialized(true);
      }
    },
    [workflowsInitialized]
  );
  // Call on each render when data changes
  if (stateData && !workflowsInitialized) {
    handleStateData(stateData);
  }

  // Fetch full advisor verdicts for commit linking
  const commitShas = stateData?.commits || [];
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

  const snapshotTime = stateData?.ts
    ? dayjs(stateData.ts).utc().format("YYYY-MM-DD HH:mm:ss UTC")
    : null;

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
        {stateData && (
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

      {stateData && (
        <AutorevertGrid
          state={stateData}
          signalFilter={signalFilter}
          advisorVerdicts={advisorVerdicts}
        />
      )}

      {!stateLoading && !stateData && (
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
