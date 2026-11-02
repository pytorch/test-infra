import type { Theme } from "@mui/material/styles";
import type { SystemStyleObject } from "@mui/system";
import { headerBandColor, headerRuleColor } from "lib/tests/headerColors";
import {
  HEADER_FILTER_INSET,
  HEADER_FILTER_SIZE,
  HEADER_TITLE_STYLE,
  TABLE_BORDER,
} from "lib/tests/layout";
import { CELL_VERTICAL_PADDING, ROW_HEIGHT } from "lib/tests/rows";

// The style the hub's tables share, the tests list's and the commit page's
// (components/tests/HubDataGrid.tsx draws it). A table is set like a
// typeset list, in the voice of the title above it: HUD's shared table
// border (`--table-border-color`, which its other tables draw) around the
// grid's rounded corners, hairlines in the palette's divider color between
// rows, compact rows, and emphasis carried by text color. The header is a
// band in the same grey as the title's pills, clipped above by the box's
// rounded corners and square below so the rows' hairlines meet it flush,
// with small bold uppercase muted labels and a short hairline between its
// columns, so the header and the title read as one system. Every color
// follows the theme's mode.

// The class of a header that holds a filter, which makes room for it.
export const FILTERABLE_HEADER = "tests-filterable-header";
// The class of the Name header, which holds the search field.
export const SEARCH_HEADER = "tests-search-header";

export interface HubTableStyleOptions {
  // The fields of the cells that hold a block (the list's Health, the
  // commit page's Outcome): their sides are padded as their top and bottom
  // are, so the block sits the same distance from every edge; the block
  // pads its own text out to where the other cells' text starts.
  blockFields?: readonly string[];
  // The fields of the cells set in the secondary tone with tabular figures
  // (the list's Last run).
  mutedFields?: readonly string[];
  // The fields whose header label is set on two lines with a line break in
  // its name, which pre-line keeps (the list's "Mean Passed\nDuration").
  // Left to wrap on its own, the label would fill the header's width and
  // push the sort arrow to the far edge instead of after the label, where
  // the other headers have it.
  twoLineHeaderFields?: readonly string[];
}

function cellSelector(fields: readonly string[]): string {
  return fields
    .map((field) => `& .MuiDataGrid-cell[data-field="${field}"]`)
    .join(", ");
}

export function hubTableSx(
  theme: Theme,
  {
    blockFields = [],
    mutedFields = [],
    twoLineHeaderFields = [],
  }: HubTableStyleOptions
): SystemStyleObject<Theme> {
  const hairline = theme.palette.divider;
  const headerBand = headerBandColor(theme);
  const headerDivider = headerRuleColor(theme);
  // The accent as text on the band, for the sorted header's label and arrow:
  // a step darker in light mode and a step lighter in dark mode, since the
  // accent itself reads at 4.0:1 and 3.1:1 against the band and these at
  // 5.0:1 and 4.0:1 (measured 2026-10-26).
  const sortedHeaderText =
    theme.palette.mode === "dark"
      ? theme.palette.primary.light
      : theme.palette.primary.dark;
  return {
    // The grid's own border color darkens the divider, which in HUD's
    // dark theme ends up darker than the page; the shared variable is
    // set for both modes in globals.css.
    border: `${TABLE_BORDER}px solid var(--table-border-color)`,
    "--DataGrid-rowBorderColor": hairline,
    "& .MuiDataGrid-columnHeaders": { backgroundColor: headerBand },
    "& .MuiDataGrid-columnHeader, & .MuiDataGrid-columnHeaders .MuiDataGrid-filler, & .MuiDataGrid-columnHeaders .MuiDataGrid-scrollbarFiller":
      { backgroundColor: "transparent" },
    // The grid's own font size, which HUD's other tables keep too.
    "& .MuiDataGrid-columnHeaderTitle": {
      ...HEADER_TITLE_STYLE,
      color: theme.palette.text.secondary,
    },
    "& .MuiDataGrid-columnHeaders .MuiDataGrid-row--borderBottom .MuiDataGrid-columnHeader, & .MuiDataGrid-columnHeaders .MuiDataGrid-row--borderBottom .MuiDataGrid-filler":
      { borderBottom: "none" },
    // The sort arrow's button only: a header's filter button sets its
    // own color.
    "& .MuiDataGrid-columnHeader .MuiDataGrid-iconButtonContainer .MuiIconButton-root, & .MuiDataGrid-sortIcon":
      { color: theme.palette.text.secondary },
    ...(twoLineHeaderFields.length > 0
      ? {
          [twoLineHeaderFields
            .map(
              (field) =>
                `& .MuiDataGrid-columnHeader[data-field="${field}"] .MuiDataGrid-columnHeaderTitle`
            )
            .join(", ")]: { whiteSpace: "pre-line", lineHeight: 1.2 },
        }
      : {}),
    // A header with a filter keeps the filter key at its right edge,
    // out of the flow, and leaves it room and a gap, so the label and
    // the sort arrow sit as they do in the other headers.
    [`& .${FILTERABLE_HEADER}`]: { position: "relative" },
    [`& .${FILTERABLE_HEADER} .MuiDataGrid-columnHeaderTitleContainer`]: {
      paddingRight: `${HEADER_FILTER_INSET + HEADER_FILTER_SIZE + 4}px`,
    },
    // The Name header's search field is in the title row instead, after
    // the sort arrow, taking the width the label and the arrow leave.
    // The row's content wrapper is made transparent to layout, so the
    // field is an item of the row and can follow the arrow (its
    // `order`); the arrow's slot is kept whether or not the arrow
    // shows, so the field does not move when the header is sorted or
    // hovered; and the header's right padding is the field's inset,
    // so it ends where the other headers' keys end.
    [`& .${SEARCH_HEADER}`]: {
      paddingRight: `${HEADER_FILTER_INSET}px`,
    },
    [`& .${SEARCH_HEADER} .MuiDataGrid-columnHeaderTitleContainerContent`]: {
      display: "contents",
    },
    [`& .${SEARCH_HEADER} .MuiDataGrid-iconButtonContainer`]: {
      width: "auto",
    },
    // Between header columns the grid's own separator stays: a 1px rule
    // shorter than the band. None after the last column, and nothing to
    // drag because the columns do not resize.
    "& .MuiDataGrid-columnSeparator": { color: headerDivider },
    "& .MuiDataGrid-columnHeader--last .MuiDataGrid-columnSeparator": {
      display: "none",
    },
    // The grid paints the sorted column's icon box in its default header
    // color so it covers the separator; paint it in the band's grey.
    "& .MuiDataGrid-columnHeader--sorted .MuiDataGrid-iconButtonContainer": {
      background: headerBand,
    },
    // The sorted column's header is marked as the active control it is,
    // like a header's filled filter key: its label and arrow take the
    // accent color and an accent rule runs along its bottom edge, the
    // width of the column, so the column the table is ordered by can
    // be seen at a glance. The rule is an inset shadow, not a border,
    // so the header keeps its height and its text stays put.
    "& .MuiDataGrid-columnHeader--sorted": {
      boxShadow: `inset 0 -2px 0 ${theme.palette.primary.main}`,
    },
    "& .MuiDataGrid-columnHeader--sorted .MuiDataGrid-columnHeaderTitle, & .MuiDataGrid-columnHeader--sorted .MuiDataGrid-iconButtonContainer .MuiIconButton-root, & .MuiDataGrid-columnHeader--sorted .MuiDataGrid-sortIcon":
      { color: sortedHeaderText },
    // HUD's global stylesheet paints every link in a grid cell in
    // the link blue (`.MuiDataGrid-root .MuiDataGrid-cell a` in
    // globals.css), which is what the name and the duration figure
    // want; said here too, so the table does not lean on that
    // sheet. A cell whose link wants another color names it in
    // `--cell-link-color`, which the rule reads first: the Health
    // block its hue's ink, the healthy word the text around it. The
    // rule outranks the global one by the root class.
    "&.MuiDataGrid-root .MuiDataGrid-cell a": {
      color: "var(--cell-link-color, var(--link-color))",
    },
    // A row's cells are as tall as its tallest, `ROW_HEIGHT` at least,
    // and keep a little air above and below a name that wraps.
    "& .MuiDataGrid-cell": {
      borderTopColor: hairline,
      minHeight: ROW_HEIGHT,
      paddingTop: `${CELL_VERTICAL_PADDING}px`,
      paddingBottom: `${CELL_VERTICAL_PADDING}px`,
    },
    ...(blockFields.length > 0
      ? {
          [cellSelector(blockFields)]: {
            paddingLeft: `${CELL_VERTICAL_PADDING}px`,
            paddingRight: `${CELL_VERTICAL_PADDING}px`,
          },
        }
      : {}),
    ...(mutedFields.length > 0
      ? {
          [cellSelector(mutedFields)]: {
            color: theme.palette.text.secondary,
            fontVariantNumeric: "tabular-nums",
          },
        }
      : {}),
    "& .MuiDataGrid-footerContainer": {
      borderTop: `1px solid ${hairline}`,
      color: theme.palette.text.secondary,
    },
  };
}
