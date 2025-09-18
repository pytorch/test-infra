import styled from "@emotion/styled";
import { Box, Chip, Paper, Slider, Stack, Typography } from "@mui/material";
import { useCallback, useMemo, useState } from "react";

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

const shortSha = (id?: string) =>
  id ? (id.length > 10 ? id.slice(0, 7) : id) : "—";

const fmtTs = (ts?: string) => {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
};

export function BenchmarkTimeSeriesComparisonTableSlider({
  workflows,
  onChange,
}: {
  workflows: WorkflowMetaInfo[];
  onChange: (next: [string, string]) => void;
}) {
  // sort & map
  const { ids, byId } = useMemo(() => {
    const byId: Record<string, WorkflowMetaInfo> = {};
    workflows.forEach((it) => (byId[it.workflow_id] = it));
    const ids = workflows.map((it) => it.workflow_id);
    return { ids, byId };
  }, [workflows]);

  // Controlled slider range (indices)
  const [range, setRange] = useState<[number, number]>(() => {
    const n = workflows.length;
    return n >= 2 ? [0, n - 1] : [0, 0];
  });

  // update range when workflows change
  useMemo(() => {
    const n = workflows.length;
    if (n >= 2) {
      setRange([0, n - 1]);
    } else {
      setRange([0, 0]);
    }
  }, [workflows]);

  function rangeLabelFormat(wfi: any) {
    const wf = byId[ids[wfi as number]];
    if (!wf) return "-";
    const commit = wf.commit ? shortSha(wf.commit) : "";
    return `${wf.workflow_id} (commit: ${commit})`;
  }

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

  const handleChange = useCallback(
    (_event: Event, value: number | number[], _activeThumb: number) => {
      if (Array.isArray(value) && value.length === 2) {
        const [a, b] = value[0] <= value[1] ? value : [value[1], value[0]];
        setRange([a, b]);
        const l = ids[a];
        const r = ids[b];
        console.log("onChange", l, r);
        onChange([l, r]);
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
        <Chip label={`L: ${rangeLabelFormat(range[0])}`} />
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
        <Chip label={`R:  ${rangeLabelFormat(range[1])}`} />
      </Stack>
    </Paper>
  );
}
