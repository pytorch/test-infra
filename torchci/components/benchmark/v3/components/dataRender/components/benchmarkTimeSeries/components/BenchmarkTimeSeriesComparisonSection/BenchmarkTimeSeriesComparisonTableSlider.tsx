import styled from "@emotion/styled";
import { Box, Chip, Paper, Slider, Stack, Typography } from "@mui/material";
import * as React from "react";
import { useMemo } from "react";

export type WorkflowItem = {
  workflow_id: string;
  commit: string;
  [k: string]: any;
};

const BenchmarkSlider = styled(Slider)(({ theme }) => ({
  "& .MuiSlider-valueLabelLabel": {
    whiteSpace: "pre-line", // <- allow \n
    fontSize: 12,
    lineHeight: 1.25,
    padding: 0,
    display: "block", // makes JSX work too
  },
}));

const shortSha = (id?: string) =>
  id ? (id.length > 10 ? id.slice(0, 7) : id) : "—";

const fmtTs = (ts?: string) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
};

function sortIds(ids: string[]) {
  const allNum = ids.every((id) => /^\d+$/.test(id));
  return allNum
    ? [...ids].sort((a, b) => Number(a) - Number(b))
    : [...ids].sort();
}

export function BenchmarkTimeSeriesComparisonTableSlider({
  items,
  range,
  onChange,
}: {
  items: WorkflowItem[];
  range: [number, number]; // controlled index range
  onChange: (next: [number, number]) => void;
  labelForMark?: (w: WorkflowItem) => string;
}) {
  // sort & map
  const { ids, byId } = useMemo(() => {
    const byId: Record<string, WorkflowItem> = {};
    items.forEach((it) => (byId[it.workflow_id] = it));
    const ids = sortIds(items.map((it) => it.workflow_id));
    return { ids, byId };
  }, [items]);

  const lWorkflowId = ids[range[0]] ?? null;
  const rWorkflowId = ids[range[1]] ?? null;

  // render slider tick labels when slider is hovered
  function valueLabelFormat(idx: number) {
    const wf = byId[ids[idx as number]];
    if (!wf) return "";

    return (
      <Box sx={{ p: 0.5 }}>
        <strong>WorkflowId: {wf.workflow_id}</strong>
        <div>Commit: {shortSha(wf.commit)}</div>
        <div>{fmtTs(wf.ts)}</div>
      </Box>
    );
  }

  function rangeLabelFormat(workflowId: string | number | null) {
    if (!workflowId) return "-";
    const id = shortSha(workflowId as string);
    const commit = byId[workflowId].commit
      ? shortSha(byId[workflowId].commit)
      : "";
    return `${id} (commit: ${commit})`;
  }

  const handleChange = React.useCallback(
    (_event: Event, value: number | number[], _activeThumb: number) => {
      if (Array.isArray(value) && value.length === 2) {
        const [a, b] = value[0] <= value[1] ? value : [value[1], value[0]];
        onChange([a, b]);
      }
    },
    [onChange]
  );

  const minWidth = Math.max(200, 50 * ids.length);
  return (
    <Paper sx={{ p: 2, width: "100%", minWidth: minWidth }}>
      <Typography variant="subtitle1" gutterBottom>
        Select L / R Data
      </Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Chip label={`L: ${rangeLabelFormat(lWorkflowId)}`} />
        <Box sx={{ flex: 1, px: 2 }}>
          <BenchmarkSlider
            value={range}
            onChange={handleChange}
            min={0}
            max={Math.max(0, ids.length - 1)}
            step={1}
            valueLabelDisplay="auto"
            valueLabelFormat={(idx) => valueLabelFormat(idx)}
            disableSwap
          />
        </Box>
        <Chip label={`R: ${rangeLabelFormat(rWorkflowId)}`} />
      </Stack>
      <Typography variant="caption" color="text.secondary">
        {ids.length} Items
      </Typography>
    </Paper>
  );
}
