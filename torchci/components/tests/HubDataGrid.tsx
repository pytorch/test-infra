import { useTheme } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import type { SystemStyleObject } from "@mui/system";
import { DataGrid, DataGridProps, GridValidRowModel } from "@mui/x-data-grid";
import { ROW_HEIGHT } from "lib/tests/rows";
import { columnHeaderHeightFor } from "lib/tests/table";
import { HubTableStyleOptions, hubTableSx } from "lib/tests/tableStyle";

export type HubDataGridProps<Row extends GridValidRowModel> = Omit<
  DataGridProps<Row>,
  | "getRowHeight"
  | "rowHeight"
  | "columnHeaderHeight"
  | "disableColumnMenu"
  | "disableColumnResize"
  | "disableRowSelectionOnClick"
  | "sortingMode"
> &
  HubTableStyleOptions & {
    // How much taller than a key the Name header's search field is, holding
    // its rows of name-filter chips; the header band grows by it.
    searchExtraHeight?: number;
    // No header band: a grid that continues another one's rows under it
    // (the community grid shows at most a hundred rows, so a longer table
    // is grids stacked on one another, CommitTable).
    headerless?: boolean;
  };

function NoColumnHeaders() {
  return null;
}

// The sx the grid is given: the shared style, then the table's own, which
// may add to or override it.
function mergedSx(
  shared: SystemStyleObject<Theme>,
  own: SxProps<Theme> | undefined
): SxProps<Theme> {
  if (own === undefined) {
    return shared;
  }
  return [shared, ...(Array.isArray(own) ? own : [own])] as SxProps<Theme>;
}

// A table of the hub in the hub's one style (hubTableSx in
// lib/tests/tableStyle.ts), set up as every hub table is: rows that grow
// with their content, so a wrapped name is never cut off (`rowHeight` is
// what the grid assumes for a row it has not measured); a header band as
// tall as the list's two-line labels, taller by the Name header's rows of
// name-filter chips; no column menus, no resizing, no row selection; and
// the API doing the sorting. Everything else, the rows, the columns and
// the paging, is the table's own.
export default function HubDataGrid<Row extends GridValidRowModel>({
  blockFields,
  mutedFields,
  twoLineHeaderFields,
  searchExtraHeight = 0,
  headerless = false,
  sx,
  slots,
  ...props
}: HubDataGridProps<Row>) {
  const theme = useTheme();
  return (
    <DataGrid
      sx={mergedSx(
        hubTableSx(theme, { blockFields, mutedFields, twoLineHeaderFields }),
        sx
      )}
      getRowHeight={() => "auto"}
      rowHeight={ROW_HEIGHT}
      columnHeaderHeight={
        headerless ? 0 : columnHeaderHeightFor(searchExtraHeight)
      }
      slots={headerless ? { ...slots, columnHeaders: NoColumnHeaders } : slots}
      disableColumnMenu
      disableColumnResize
      disableRowSelectionOnClick
      sortingMode="server"
      {...props}
    />
  );
}
