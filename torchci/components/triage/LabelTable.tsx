import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import {
  Box,
  IconButton,
  Link,
  Paper,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { DataGrid, GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import {
  formatDays,
  formatPct,
  githubSelectionUrl,
  LabelRow,
  OUTCOMES,
  SLA_DAYS,
  slaLevel,
  slaPct,
} from "lib/triage/issueTriage";
import { LabelTree, treeRows } from "lib/triage/labelTree";
import NextLink from "next/link";
import { useState } from "react";
import { useSlaColor } from "./SummaryTiles";

// The table grows with its rows up to this height, then scrolls.
const TABLE_MAX_HEIGHT = 640;
const PAGE_SIZE = 100;

// Custom cells are not vertically centred by default in a compact DataGrid.
function Cell({
  children,
  align = "flex-end",
}: {
  children: any;
  align?: string;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: align,
        height: "100%",
      }}
    >
      {children}
    </Box>
  );
}

export function useOutcomeColors(): string[] {
  const theme = useTheme();
  const p = theme.palette;
  const dark = p.mode === "dark";
  return [
    p.success.main,
    p.info.main,
    p.secondary.main,
    p.warning.main,
    // won't fix (final) is the stronger grey, closed the lighter one.
    dark ? p.grey[300] : p.grey[700],
    dark ? p.grey[600] : p.grey[400],
  ];
}

function OutcomeBar({ row }: { row: LabelRow }) {
  const colors = useOutcomeColors();
  const counts = OUTCOMES.map((o) => row[o.key] as number);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <Typography variant="caption">–</Typography>;
  }
  const summary = OUTCOMES.map((o, i) => `${o.label}: ${counts[i]}`).join(
    " · "
  );
  return (
    <Tooltip title={summary}>
      <Box
        sx={{
          display: "flex",
          width: "100%",
          height: 12,
          borderRadius: 1,
          overflow: "hidden",
        }}
      >
        {counts.map((count, i) =>
          count > 0 ? (
            <Box
              key={OUTCOMES[i].key}
              sx={{ flexGrow: count, backgroundColor: colors[i] }}
            />
          ) : null
        )}
      </Box>
    </Tooltip>
  );
}

export function OutcomeLegend() {
  const colors = useOutcomeColors();
  return (
    <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
      {OUTCOMES.map((o, i) => (
        <Box
          key={o.key}
          sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
        >
          <Box
            sx={{
              width: 10,
              height: 10,
              borderRadius: 0.5,
              bgcolor: colors[i],
            }}
          />
          <Typography variant="caption">{o.label}</Typography>
        </Box>
      ))}
    </Box>
  );
}

type TableRow = LabelRow & { depth: number; hasChildren: boolean };

// Rows in the table's default order: most overdue first.
function compareRows(a: LabelRow, b: LabelRow): number {
  return (
    b.overdue - a.overdue ||
    b.queue_size - a.queue_size ||
    a.label.localeCompare(b.label)
  );
}

export default function LabelTable({
  rows,
  tree,
  includeChildren,
  outline,
  start,
  startDate,
}: {
  // One row per label, already counted with or without its children.
  rows: LabelRow[] | undefined;
  tree: LabelTree;
  // Page-wide: parents count their child labels' issues too.
  includeChildren: boolean;
  // Nest child labels under their parents, collapsed until opened.
  outline: boolean;
  // `start` URL value to carry into the drill-down links.
  start: string;
  startDate: string;
}) {
  const theme = useTheme();
  const slaColor = useSlaColor();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const byLabel = new Map((rows ?? []).map((r) => [r.label, r]));
  const tableRows: TableRow[] | undefined =
    rows === undefined
      ? undefined
      : outline
      ? treeRows(
          rows.map((r) => r.label),
          tree,
          expanded,
          (a, b) => compareRows(byLabel.get(a)!, byLabel.get(b)!)
        ).map((t) => ({ ...byLabel.get(t.label)!, ...t }))
      : rows.map((r) => ({ ...r, depth: 0, hasChildren: false }));

  function toggle(label: string) {
    const next = new Set(expanded);
    next.has(label) ? next.delete(label) : next.add(label);
    setExpanded(next);
  }

  const columns: GridColDef<TableRow>[] = [
    {
      field: "label",
      headerName: "Label",
      flex: 2,
      minWidth: 260,
      renderCell: (params: GridRenderCellParams<TableRow>) => (
        <Cell align="flex-start">
          <Box sx={{ width: params.row.depth * 20 + 28, flexShrink: 0 }}>
            {params.row.hasChildren && (
              <IconButton
                size="small"
                sx={{ ml: `${params.row.depth * 20}px` }}
                aria-label={
                  expanded.has(params.row.label)
                    ? "Hide child labels"
                    : "Show child labels"
                }
                onClick={() => toggle(params.row.label)}
              >
                {expanded.has(params.row.label) ? (
                  <KeyboardArrowDownIcon fontSize="small" />
                ) : (
                  <KeyboardArrowRightIcon fontSize="small" />
                )}
              </IconButton>
            )}
          </Box>
          <Link
            component={NextLink}
            href={{
              pathname: "/triage/modules",
              query: {
                ...(start ? { start } : {}),
                label: params.row.label,
                ...(includeChildren ? {} : { children: "exclude" }),
              },
            }}
            noWrap
          >
            {params.row.label}
          </Link>
        </Cell>
      ),
    },
    {
      field: "queue_size",
      headerName: "In queue",
      description: "Open issues with this label and no state label",
      type: "number",
      flex: 1,
    },
    {
      field: "overdue",
      headerName: "Overdue",
      type: "number",
      flex: 1,
      description: `In the queue and created more than ${SLA_DAYS} days ago`,
      renderCell: (params: GridRenderCellParams<TableRow>) => (
        <Cell>
          <Typography
            variant="body2"
            sx={{
              fontWeight: params.row.overdue > 0 ? "bold" : undefined,
              color:
                params.row.overdue > 0 ? theme.palette.error.main : undefined,
            }}
          >
            {params.row.overdue}
          </Typography>
        </Cell>
      ),
    },
    {
      field: "oldest_days",
      headerName: "Oldest (d)",
      description: "Age in days of the oldest issue in the queue",
      type: "number",
      flex: 1,
    },
    {
      field: "high_pri_in_queue",
      headerName: "High pri",
      description: "Issues in the queue labelled high priority",
      type: "number",
      flex: 1,
    },
    {
      field: "issues_created",
      headerName: "Created",
      description: "Issues with this label created since the start date",
      type: "number",
      flex: 1,
    },
    {
      field: "sla_pct",
      headerName: `≤ ${SLA_DAYS}d`,
      description: `% of issues older than ${SLA_DAYS} days that were fully triaged within ${SLA_DAYS} days of creation`,
      type: "number",
      flex: 1,
      valueGetter: (_value, row) => slaPct(row.met_sla, row.sla_eligible),
      renderCell: (params: GridRenderCellParams<TableRow>) => {
        const pct = slaPct(params.row.met_sla, params.row.sla_eligible);
        return (
          <Cell>
            <Tooltip
              title={`${params.row.met_sla} of ${params.row.sla_eligible} issues older than ${SLA_DAYS} days`}
            >
              <Typography
                variant="body2"
                sx={{ color: slaColor(slaLevel(pct)) }}
              >
                {formatPct(pct)}
              </Typography>
            </Tooltip>
          </Cell>
        );
      },
    },
    {
      field: "median_days_to_triage",
      headerName: "Median (d)",
      description:
        "Median days from creation to fully triaged, among triaged issues",
      type: "number",
      flex: 1,
      valueFormatter: (value: number | null) => formatDays(value),
    },
    {
      field: "outcomes",
      headerName: "Outcomes",
      flex: 1.5,
      minWidth: 140,
      sortable: false,
      renderCell: (params: GridRenderCellParams<TableRow>) => (
        <Cell align="flex-start">
          <OutcomeBar row={params.row} />
        </Cell>
      ),
    },
    {
      field: "github",
      headerName: "GitHub",
      flex: 0.8,
      sortable: false,
      renderCell: (params: GridRenderCellParams<TableRow>) => (
        <Link
          href={githubSelectionUrl(
            [params.row.label],
            includeChildren,
            tree,
            startDate
          )}
          target="_blank"
          rel="noopener noreferrer"
        >
          queue
        </Link>
      ),
    },
  ];

  return (
    <Paper sx={{ p: 1 }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          p: 1,
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Typography fontWeight="bold">Per label</Typography>
        <OutcomeLegend />
      </Box>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          maxHeight: TABLE_MAX_HEIGHT,
        }}
      >
        <DataGrid
          rows={tableRows ?? []}
          loading={tableRows === undefined}
          columns={columns}
          getRowId={(row) => row.label}
          density="compact"
          disableRowSelectionOnClick
          initialState={{
            pagination: { paginationModel: { pageSize: PAGE_SIZE } },
          }}
          pageSizeOptions={[25, 50, PAGE_SIZE]}
          hideFooter={tableRows !== undefined && tableRows.length <= PAGE_SIZE}
          // The outline order is the tree's; sorting a column would break it.
          disableColumnSorting={outline}
        />
      </Box>
    </Paper>
  );
}
