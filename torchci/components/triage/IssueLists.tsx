import { Box, Chip, Link, Paper, Stack, Typography } from "@mui/material";
import { DataGrid, GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import dayjs from "dayjs";
import { formatDays, IssueRow } from "lib/triage/issueTriage";
import { LabelSelection, matchingLabels } from "lib/triage/labelTree";

// Lists grow with their rows up to this height, then scroll.
const LIST_MAX_HEIGHT = 480;
const PAGE_SIZE = 100;

function IssueLink({ row }: { row: IssueRow }) {
  return (
    <Link href={row.html_url} target="_blank" rel="noopener noreferrer">
      #{row.number} {row.title}
    </Link>
  );
}

function Flags({ row }: { row: IssueRow }) {
  return (
    <Stack direction="row" spacing={0.5}>
      {row.overdue === 1 && <Chip size="small" color="error" label="overdue" />}
      {row.reopened === 1 && (
        <Chip size="small" color="warning" label="reopened" />
      )}
      {row.high_priority === 1 && (
        <Chip size="small" color="error" variant="outlined" label="high pri" />
      )}
    </Stack>
  );
}

function ListPaper({
  title,
  subtitle,
  rows,
  columns,
}: {
  title: string;
  subtitle: string;
  rows: IssueRow[] | undefined;
  columns: GridColDef<IssueRow>[];
}) {
  return (
    <Paper sx={{ p: 1 }} elevation={3}>
      <Box sx={{ p: 1 }}>
        <Typography fontWeight="bold">
          {title}
          {rows !== undefined ? ` (${rows.length})` : ""}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {subtitle}
        </Typography>
      </Box>
      {/* A flex column without a fixed height lets the grid size to its rows. */}
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          maxHeight: LIST_MAX_HEIGHT,
        }}
      >
        <DataGrid
          rows={rows ?? []}
          loading={rows === undefined}
          columns={columns}
          getRowId={(row) => row.number}
          density="compact"
          disableRowSelectionOnClick
          initialState={{
            pagination: { paginationModel: { pageSize: PAGE_SIZE } },
          }}
          pageSizeOptions={[25, 50, PAGE_SIZE]}
          hideFooter={rows !== undefined && rows.length <= PAGE_SIZE}
        />
      </Box>
    </Paper>
  );
}

const issueColumn: GridColDef<IssueRow> = {
  field: "title",
  headerName: "Issue",
  flex: 4,
  minWidth: 300,
  renderCell: (params: GridRenderCellParams<IssueRow>) => (
    <IssueLink row={params.row} />
  ),
};

const assigneeColumn: GridColDef<IssueRow> = {
  field: "assignees",
  headerName: "Assignee",
  flex: 1,
  valueGetter: (_value, row) => row.assignees.join(", "),
};

// When the selection spans several labels (several picked, or a parent with
// its children), which of them put each issue in it.
function selectedLabelsColumn(
  selection: LabelSelection
): GridColDef<IssueRow>[] {
  if (selection.includeLabels.length + selection.ownLabels.length < 2) {
    return [];
  }
  return [
    {
      field: "selected_labels",
      headerName: "Labels",
      flex: 1.5,
      valueGetter: (_value, row) =>
        matchingLabels(row.tracked_labels, selection).join(", "),
    },
  ];
}

export function QueueList({
  rows,
  selection,
}: {
  rows: IssueRow[] | undefined;
  selection: LabelSelection;
}) {
  const columns: GridColDef<IssueRow>[] = [
    issueColumn,
    ...selectedLabelsColumn(selection),
    { field: "age_days", headerName: "Age (d)", type: "number", flex: 0.6 },
    {
      field: "flags",
      headerName: "Flags",
      flex: 1.4,
      sortable: false,
      renderCell: (params: GridRenderCellParams<IssueRow>) => (
        <Flags row={params.row} />
      ),
    },
    {
      field: "other_labels",
      headerName: "Can also be triaged by",
      flex: 2,
      valueGetter: (_value, row) => {
        const matching = matchingLabels(row.tracked_labels, selection);
        return row.tracked_labels
          .filter((l) => !matching.includes(l))
          .join(", ");
      },
    },
    assigneeColumn,
  ];
  return (
    <ListPaper
      title="Waiting for triage"
      subtitle="Open issues in this selection with no state label, oldest first."
      rows={rows}
      columns={columns}
    />
  );
}

export function RecentlyTriagedList({
  rows,
  selection,
}: {
  rows: IssueRow[] | undefined;
  selection: LabelSelection;
}) {
  const columns: GridColDef<IssueRow>[] = [
    issueColumn,
    ...selectedLabelsColumn(selection),
    { field: "outcome", headerName: "Outcome", flex: 1 },
    {
      field: "triaged_at",
      headerName: "Triaged on",
      flex: 0.8,
      valueFormatter: (value: string | null) =>
        value === null ? "–" : dayjs(value).format("YYYY-MM-DD"),
    },
    {
      field: "days_to_triage",
      headerName: "Days to triage",
      type: "number",
      flex: 0.8,
      valueFormatter: (value: number | null) => formatDays(value),
    },
    assigneeColumn,
  ];
  return (
    <ListPaper
      title="Recently fully triaged"
      subtitle="Closed or given a state label in the last 30 days, most recent first."
      rows={rows}
      columns={columns}
    />
  );
}

// The drill-down's two lists, from one issue_triage_issues result. An issue
// with several of the selected labels is listed once.
export default function IssueLists({
  rows,
  selection,
}: {
  rows: IssueRow[] | undefined;
  selection: LabelSelection;
}) {
  const queue = rows?.filter((r) => r.in_queue === 1);
  const triaged = rows
    ?.filter((r) => r.in_queue === 0)
    .sort((a, b) => (b.triaged_at ?? "").localeCompare(a.triaged_at ?? ""));
  return (
    <Stack spacing={2}>
      <QueueList rows={queue} selection={selection} />
      <RecentlyTriagedList rows={triaged} selection={selection} />
    </Stack>
  );
}
