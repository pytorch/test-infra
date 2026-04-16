import styled from "@emotion/styled";
import { Box, Chip, Slider, Stack, Typography } from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { shortSha } from "../../helper";

export type WorkflowMetaInfo = {
  workflow_id: string;
  commit: string;
  branch: string;
  [k: string]: any;
};

const BenchmarkSlider = styled(Slider)(() => ({
  "& .MuiSlider-valueLabelLabel": {
    whiteSpace: "pre-line",
    fontSize: 12,
    lineHeight: 1.25,
    padding: 0,
    display: "block",
  },
}));

export function BenchmarkTimeSeriesSingleSlider({
  workflows,
  onChange,
  selectedWorkflowId,
  label,
}: {
  workflows: WorkflowMetaInfo[];
  onChange: (next: string) => void;
  selectedWorkflowId?: string;
  label: string;
}) {
  const { ids, byId } = useMemo(() => {
    const byId: Record<string, WorkflowMetaInfo> = {};
    workflows.forEach((it) => (byId[it.workflow_id] = it));
    const ids = workflows.map((it) => it.workflow_id);
    return { ids, byId };
  }, [workflows]);

  const [index, setIndex] = useState<number>(() => {
    const n = workflows.length;
    return n >= 1 ? 0 : 0;
  });

  useEffect(() => {
    const n = ids.length;
    if (n === 0) return;

    const idx = selectedWorkflowId ? ids.indexOf(selectedWorkflowId) : -1;

    if (idx >= 0) {
      setIndex(idx);
    } else {
      setIndex(0);
    }
  }, [ids, selectedWorkflowId]);

  function rangeLabelFormat(wfi: number) {
    const wf = byId[ids[wfi]];
    if (!wf) return "-";
    const commit = wf.commit ? shortSha(wf.commit) : "";
    return `${wf.workflow_id} (commit: ${commit})`;
  }

  function valueLabelFormat(idx: number) {
    const wf = byId[ids[idx]];
    if (!wf) return "";
    return (
      <Box sx={{ p: 0.5 }}>
        <strong>WorkflowId: {wf.workflow_id}</strong>
        <div>Commit: {shortSha(wf.commit)}</div>
        <div>time: {wf.date}</div>
        <div>branch: {wf.branch}</div>
      </Box>
    );
  }

  const handleChange = useCallback(
    (_e: Event, value: number | number[]) => {
      if (typeof value === "number") {
        setIndex(value);
        onChange(ids[value]);
      }
    },
    [ids, onChange]
  );

  const minWidth = Math.min(200, 50 * ids.length);

  return (
    <Box sx={{ p: 2, width: "100%", minWidth }}>
      <Typography variant="subtitle1" gutterBottom>
        Select {label}
      </Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Chip label={`${label}: ${rangeLabelFormat(index)}`} />
        <Box sx={{ flex: 1, px: 2 }}>
          <BenchmarkSlider
            value={index}
            onChange={handleChange}
            min={0}
            max={Math.max(0, ids.length - 1)}
            step={1}
            valueLabelDisplay="auto"
            valueLabelFormat={valueLabelFormat}
          />
        </Box>
      </Stack>
    </Box>
  );
}
