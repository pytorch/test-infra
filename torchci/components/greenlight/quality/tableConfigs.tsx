import { Box, Tooltip } from "@mui/material";
import { GridColDef, GridRenderCellParams } from "@mui/x-data-grid";
import {
  ABSENT,
  MERGED_VERSION_APPROVED,
  utcStamp,
} from "lib/greenlight/qualityFigures";
import { RevertRow } from "lib/greenlight/qualityQuery";

// Not the SHORT_SHA_LENGTH that greenlightRender.ts exports: that one is 7 and
// is load-bearing for the comment sweep's predicate. This is a display width for
// a grid cell and the two are free to differ, so they may not share a name.
const TABLE_SHA_LENGTH = 8;

// GridColDef declares `field` as a bare string, which is the same unreviewable
// indirection as a tile-config field name: nothing connects it to the query. The
// intersection narrows it to a real column of the reverts row.
type RevertColDef = GridColDef & { field: keyof RevertRow };

export interface RevertedTableConfig {
  heading: string;
  columns: RevertColDef[];
  getRowId: (_row: any) => string;
  defaultSortField: keyof RevertRow;
}

const COL_DESC = {
  mergedSha:
    "The merged commit that was live at revert time. A reverted PR often merges more than once, so this is not necessarily the newest merge.",
  revertSha:
    "The commit that performed the revert. A ghstack stack is reverted by one commit, so sibling PRs of the same stack share this SHA — and share the reverter's message, which is written once against the stack.",
  revertedAt: "When the revert landed on main.",
  mergedVersionApproved:
    "Whether the verdict shown was issued against the commit that actually merged. Stale means it was issued against an earlier one, so the approval never covered what landed.",
  classification:
    "The -c argument of the @pytorchbot revert command that triggered this revert, picked by the reverter from a fixed set. Rows reading ghfirst are listed here but excluded from the rate above, which is why this table can hold more rows than that figure counts. A dash means no classification could be read from this revert at all, most often because no pytorchbot command sits behind it — an internal 'Back out' commit lands that way. Several causes collapse to the same dash and cannot be told apart here.",
  revertMessage:
    "The -m argument of the same command: what the reverter said was wrong, in their own words. This is where the cause is stated, so it is what the classification beside it should be read against. Whitespace is collapsed and the text is capped at 500 characters server-side. A ghstack stack is reverted by one command, so siblings of one stack correctly show the same message — the shared Revert SHA is what marks them as one event.",
};

// merged_version_approved is a query-derived enum; anything the detectors did
// not produce renders as-is rather than being folded into one of these. Keyed off
// the shared constants so this map and the staleness counts cannot come to
// disagree about what the column can say.
const APPROVAL_LABEL: { [_value: string]: string } = {
  [MERGED_VERSION_APPROVED.yes]: "confirmed",
  [MERGED_VERSION_APPROVED.no]: "stale",
  [MERGED_VERSION_APPROVED.unknown]: "unverified",
};

// The one column that reconciles this table against the rate above it: without
// it a reader sees rows here that the figure says do not exist. The query hands
// back '' for a command it could not locate, deliberately without a sentinel
// word, so naming that state is this column's job.
const classificationCol: RevertColDef = {
  field: "revert_classification",
  headerName: "Classification",
  width: 130,
  description: COL_DESC.classification,
  valueFormatter: (value: string) => value || ABSENT,
};

// The page's only renderCell. The message is the one column a reader has to be
// able to read in full, and a grid cell clips it; nothing else here needs more
// than a formatter.
//
// This text is written by whoever filed the revert, so it is attacker-controlled:
// it stays a plain text child with a plain-string tooltip title, and reaches no
// attribute, URL or markup. Do not grow this into anything that interpolates.
//
// No tabIndex on the wrapper — DataGrid runs its own roving tabindex across
// cells, and a second focusable node inside one breaks grid navigation. The text
// is a DOM node, so it is reachable without the tooltip being opened.
const messageCol: RevertColDef = {
  field: "revert_message",
  headerName: "Revert message",
  flex: 3,
  minWidth: 300,
  description: COL_DESC.revertMessage,
  renderCell: (params: GridRenderCellParams<any, string>) =>
    params.value ? (
      <Tooltip title={params.value}>
        <Box
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {params.value}
        </Box>
      </Tooltip>
    ) : (
      ABSENT
    ),
};

const stampCol = (
  field: keyof RevertRow,
  headerName: string,
  description?: string
): RevertColDef => ({
  field,
  headerName,
  description,
  width: 150,
  valueFormatter: (value: string) => utcStamp(value),
});

const shaCol = (
  field: keyof RevertRow,
  headerName: string,
  description: string
): RevertColDef => ({
  field,
  headerName,
  description,
  width: 110,
  valueFormatter: (value: string) =>
    value ? value.slice(0, TABLE_SHA_LENGTH) : ABSENT,
});

export const REVERTED_TABLE: RevertedTableConfig = {
  heading: "Reverted PRs whose merged version GreenLight approved",
  // The query's declared grain, all three parts load-bearing: two revert
  // commits of the same PR in one push share a pr_number and a timestamp, and
  // one revert commit surfacing in two pushes shares a pr_number and a SHA.
  // A duplicate id throws in DataGrid.
  getRowId: (row) => `${row.pr_number}-${row.revert_sha}-${row.reverted_at}`,
  defaultSortField: "reverted_at",
  columns: [
    {
      field: "pr_number",
      headerName: "PR",
      width: 90,
      type: "number",
      // numCol's thousands separator would render #194,379.
      valueFormatter: (value: number) =>
        value === null || value === undefined ? ABSENT : String(value),
    },
    // Narrower than the revert message beside it: every row here is a LAND
    // verdict on a PR that was reverted, so what the PR was called matters less
    // than why someone took it out.
    { field: "title", headerName: "Title", flex: 2, minWidth: 240 },
    { field: "author", headerName: "Author", flex: 1, minWidth: 130 },
    classificationCol,
    messageCol,
    {
      field: "merged_version_approved",
      headerName: "Merged version",
      width: 130,
      description: COL_DESC.mergedVersionApproved,
      valueFormatter: (value: string) =>
        value ? APPROVAL_LABEL[value] ?? value : ABSENT,
    },
    shaCol("merged_sha", "Merged SHA", COL_DESC.mergedSha),
    shaCol("revert_sha", "Revert SHA", COL_DESC.revertSha),
    stampCol("merged_at", "Merged at"),
    stampCol("verdict_at", "Verdict at"),
    stampCol("reverted_at", "Reverted at", COL_DESC.revertedAt),
    { field: "reverter", headerName: "Reverter", flex: 1, minWidth: 130 },
  ],
};
