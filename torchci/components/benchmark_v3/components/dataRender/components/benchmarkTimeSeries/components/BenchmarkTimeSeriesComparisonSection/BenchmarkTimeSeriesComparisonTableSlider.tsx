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

const BenchmarkSlider = styled(Slider)(({ theme }) => ({
  "& .MuiSlider-valueLabelLabel": {
    whiteSpace: "pre-line", // <- allow \n
    fontSize: 12,
    lineHeight: 1.25,
    padding: 0,
    display: "block", // makes JSX work too
  },
}));

export function BenchmarkTimeSeriesComparisonTableSlider({
  workflows,
  onChange,
  lWorkflowId,
  rWorkflowId,
}: {
  workflows: WorkflowMetaInfo[];
  onChange: (next: [string, string]) => void;
  lWorkflowId?: string; // optional controlled inputs
  rWorkflowId?: string;
}) {
  // map ids
  const { ids, byId } = useMemo(() => {
    const byId: Record<string, WorkflowMetaInfo> = {};
    workflows.forEach((it) => (byId[it.workflow_id] = it));
    const ids = workflows.map((it) => it.workflow_id);
    return { ids, byId };
  }, [workflows]);

  // controlled slider indices
  const [range, setRange] = useState<[number, number]>(() => {
    const n = workflows.length;
    return n >= 2 ? [0, n - 1] : [0, 0];
  });

  // ❗ useEffect (not useMemo) for side effects
  // 1) When workflows list changes, reset to ends—unless l/r are provided and found.
  useEffect(() => {
    const n = ids.length;
    if (n === 0) return;

    // prefer external l/r if they exist and are present in ids
    const li = lWorkflowId ? ids.indexOf(lWorkflowId) : -1;
    const ri = rWorkflowId ? ids.indexOf(rWorkflowId) : -1;

    if (li >= 0 && ri >= 0) {
      setRange(li <= ri ? [li, ri] : [ri, li]);
    } else if (n >= 2) {
      setRange([0, n - 1]);
    } else {
      setRange([0, 0]);
    }
  }, [ids, lWorkflowId, rWorkflowId]);

  // If only l or only r changes later, sync partially without breaking
  useEffect(() => {
    const [curL, curR] = range;
    const li = lWorkflowId ? ids.indexOf(lWorkflowId) : -1;
    const ri = rWorkflowId ? ids.indexOf(rWorkflowId) : -1;

    let next: [number, number] | null = null;
    if (li >= 0 && ri >= 0) next = li <= ri ? [li, ri] : [ri, li];
    else if (li >= 0) next = li <= curR ? [li, curR] : [curR, li];
    else if (ri >= 0) next = curL <= ri ? [curL, ri] : [ri, curL];

    if (next && (next[0] !== curL || next[1] !== curR)) setRange(next);
  }, [lWorkflowId, rWorkflowId, ids]); // ids needed for indexOf

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
        <div>time:{wf.date}</div>
      </Box>
    );
  }

  const handleChange = useCallback(
    (_e: Event, value: number | number[]) => {
      if (Array.isArray(value) && value.length === 2) {
        const [a, b] =
          value[0] <= value[1]
            ? (value as [number, number])
            : [value[1], value[0]];
        setRange([a, b]);
        onChange([ids[a], ids[b]]); // emit workflow ids
      }
    },
    [ids, onChange]
  );

  const minWidth = Math.min(200, 50 * ids.length);

  return (
    <Box sx={{ p: 2, width: "100%", minWidth }}>
      <Typography variant="subtitle1" gutterBottom>
        Select L / R Data
      </Typography>
      <Stack direction="row" alignItems="center" spacing={2}>
        <Chip label={`L: ${rangeLabelFormat(range[0])}`} />
        <Box sx={{ flex: 1, px: 2 }}>
          <BenchmarkSlider
            value={range}
            onChange={handleChange}
            min={0}
            max={Math.max(0, ids.length - 1)}
            step={1}
            valueLabelDisplay="auto"
            valueLabelFormat={valueLabelFormat}
            disableSwap
          />
        </Box>
        <Chip label={`R: ${rangeLabelFormat(range[1])}`} />
      </Stack>
    </Box>
  );
}
