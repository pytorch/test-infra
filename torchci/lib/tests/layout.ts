// The measure the test hub's pages share: the tests table's column widths
// and the page column cut to fit them, so the table on
// /tests/[organization]/[repo] is whole at full width and never scrolled
// sideways, and a page without the table, a test's own, keeps the same
// width. Free of React, so TestsTable, PageColumn and the tests can read it.

// The columns' widths in pixels, each sized to what it shows, as its
// definition in TestsTable says. The Name column takes the width the others
// leave, NAME_MIN_WIDTH at least. Together they must fit what a 1920px
// display shows without sideways scrolling: 1905px after the scrollbar,
// less the body's 5px padding and the layout's 2px margin each side, the
// page column's 16px padding each side and the table's border, 1855px for
// the columns (1853px with Windows' wider scrollbar).
export const NAME_MIN_WIDTH = 480;
export const COLUMN_WIDTHS = {
  health: 170,
  environment: 430,
  test_config: 200,
  mean_passed_duration_milliseconds: 180,
  owners: 200,
  last_run_at: 180,
};
export const TABLE_BORDER = 1;
// The table's width with every column at its width and the Name column at
// its minimum. The page column is this wide, so at full width the table is
// whole and not scrolled sideways.
export const TESTS_TABLE_WIDTH =
  NAME_MIN_WIDTH +
  Object.values(COLUMN_WIDTHS).reduce((sum, width) => sum + width, 0) +
  2 * TABLE_BORDER;
// The page column's padding on each side, in theme spacing units.
export const PAGE_PADDING = 2;

// The tables' header band, the list's and the grid's: as tall as the list's
// two-line column headers; its titles small, bold, uppercase and spaced,
// in the secondary text color set where they are drawn; and how long the
// pointer rests on a title before its tooltip opens.
export const COLUMN_HEADER_HEIGHT = 44;
export const HEADER_TITLE_STYLE = {
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
} as const;
export const HEADER_TITLE_TOOLTIP_DELAY_MS = 600;
