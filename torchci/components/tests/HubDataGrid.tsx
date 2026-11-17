import { useTheme } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import type { SystemStyleObject } from "@mui/system";
import {
  DataGrid,
  DataGridProps,
  gridClasses,
  GridLoadingOverlay,
  GridLoadingOverlayProps,
  GridOverlay,
  gridRowCountSelector,
  GridSkeletonCell,
  GridValidRowModel,
  gridVisibleColumnDefinitionsSelector,
  useGridApiContext,
  useGridSelector,
} from "@mui/x-data-grid";
import { ROW_HEIGHT } from "lib/tests/rows";
import { columnHeaderHeightFor } from "lib/tests/table";
import {
  HubTableStyleOptions,
  hubTableSx,
  SKELETON_ROWS,
} from "lib/tests/tableStyle";
import { useIsomorphicLayoutEffect } from "lib/tests/useIsomorphicLayoutEffect";
import { useRef, useState } from "react";

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

// The fewest and the most skeleton rows a grid draws.
const FEWEST_SKELETON_ROWS = 3;
const MOST_SKELETON_ROWS = 150;

// The skeleton rows from `top` pixels down the window to its bottom edge.
const skeletonRowsBelow = (top: number) =>
  Math.min(
    MOST_SKELETON_ROWS,
    Math.max(
      FEWEST_SKELETON_ROWS,
      Math.ceil((window.innerHeight - top) / ROW_HEIGHT)
    )
  );

// The rows of a grid that has none while its first rows are on their way:
// the grid's skeleton cells in rows from the grid's top down to the window's
// bottom edge, so what is in sight keeps its place. The grid's own skeleton
// is as tall as the grid, whose height in turn follows its skeleton's: the
// two chased each other, a row or two before the first rows and, after a
// hundred rows, a hundred skeleton rows drawn again a row shorter each time.
function SkeletonRows() {
  const apiRef = useGridApiContext();
  const columns = useGridSelector(apiRef, gridVisibleColumnDefinitionsSelector);
  const ref = useRef<HTMLDivElement>(null);
  // A window's worth to begin with: with fewer, a page scrolled down to the
  // grid is too short to stay there, and is scrolled back before the rows
  // are counted.
  const [rows, setRows] = useState(() => skeletonRowsBelow(0));
  useIsomorphicLayoutEffect(() => {
    setRows(skeletonRowsBelow(ref.current?.getBoundingClientRect().top ?? 0));
  }, []);
  return (
    <div ref={ref} className={SKELETON_ROWS}>
      {Array.from({ length: rows }, (_unused, row) => (
        <div
          key={row}
          className={[
            gridClasses.row,
            gridClasses.rowSkeleton,
            row === 0 ? gridClasses["row--firstVisible"] : "",
          ].join(" ")}
        >
          {columns.map((column) => (
            <GridSkeletonCell
              key={column.field}
              field={column.field}
              type={column.type}
              align={column.align}
              width={column.computedWidth}
              height={ROW_HEIGHT}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// What a grid shows while rows are on their way: the grid's progress bar
// over the rows it has, the skeleton rows when it has none.
function LoadingOverlay(props: GridLoadingOverlayProps) {
  const apiRef = useGridApiContext();
  return useGridSelector(apiRef, gridRowCountSelector) > 0 ? (
    <GridLoadingOverlay {...props} />
  ) : (
    <GridOverlay style={{ display: "block" }}>
      <SkeletonRows />
    </GridOverlay>
  );
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
      slots={{
        loadingOverlay: LoadingOverlay,
        ...slots,
        ...(headerless ? { columnHeaders: NoColumnHeaders } : {}),
      }}
      disableColumnMenu
      disableColumnResize
      disableRowSelectionOnClick
      sortingMode="server"
      {...props}
    />
  );
}
