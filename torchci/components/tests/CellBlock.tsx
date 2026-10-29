import { Box, ButtonBase, useTheme } from "@mui/material";
import { Hue, hueColors } from "lib/tests/blockColors";
import { CELL_BLOCK_PADDING } from "lib/tests/rows";
import { endsTextSelection } from "lib/tests/selection";
import NextLink from "next/link";
import { MouseEvent, ReactNode } from "react";

// The two-line cells, Health and Mean Passed Duration, are set here one way:
// a lead line over a smaller muted caption (`CellLines`). The Health cell
// sets its lines in a frame the size of the cell less its uniform margin,
// plain for the unremarkable case (`CellFrame`) and, for the case worth a
// look, a block of a hue (`CellBlock`): a pale background with the text in a
// dark shade of the same color, rounded like the header's keys.

// Tight lines in tabular numerals.
const CELL_TEXT_SX = {
  minWidth: 0,
  lineHeight: 1.25,
  fontVariantNumeric: "tabular-nums",
} as const;

// The root of a framed cell: fills the cell, which centers its content by
// default, so the frame inside can fill it too.
export const CELL_ROOT_SX = {
  display: "flex",
  alignSelf: "stretch",
  width: "100%",
  ...CELL_TEXT_SX,
} as const;

// The geometry of the frame, plain or a block: the whole cell less its
// uniform padding, as wide and as tall as the cell's content, so a block
// grows with a row that a wrapped name has grown; the text inset to where
// the other cells' text starts (the cell pads its sides by as much as above
// and below, TestsTable, and the frame by the rest), the lines centered.
const FRAME_SX = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "flex-start",
  textAlign: "left",
  boxSizing: "border-box",
  width: "100%",
  alignSelf: "stretch",
  px: `${CELL_BLOCK_PADDING}px`,
  borderRadius: "6px",
} as const;

export interface CellLinesProps {
  // The first line: the status and its rate, the mean.
  lead: ReactNode;
  // The smaller line beneath it: the counts behind the first.
  caption: ReactNode;
}

// The two lines, each its own item of the column they sit in, so the
// caption's line is as tall as its smaller text, not as the text above it.
// In a block the lead is a little heavier and the caption is told apart by
// its size alone, in the block's own text color: a fainter shade would fall
// under the 4.5:1 contrast the smaller text needs (measured 3.9:1 at 85%
// opacity on the red). Plain, the caption is the muted text.
function Lines({
  lead,
  caption,
  painted,
}: CellLinesProps & { painted: boolean }) {
  return (
    <>
      <Box component="span" sx={{ fontWeight: painted ? 500 : undefined }}>
        {lead}
      </Box>
      <Box
        component="span"
        sx={{
          fontSize: (theme) => theme.typography.caption.fontSize,
          color: painted ? undefined : "text.secondary",
        }}
      >
        {caption}
      </Box>
    </>
  );
}

// The lines on their own, in a cell with no frame: the cell's own padding
// places them. The title, given, is the cell's tooltip.
export function CellLines({
  lead,
  caption,
  title,
}: CellLinesProps & { title?: string }) {
  return (
    <Box
      component="span"
      title={title}
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        ...CELL_TEXT_SX,
      }}
    >
      <Lines lead={lead} caption={caption} painted={false} />
    </Box>
  );
}

// The lines in the plain frame: the unremarkable case a block stands out of,
// set the same way so the two line up.
export function CellFrame({ lead, caption }: CellLinesProps) {
  return (
    <Box component="span" sx={FRAME_SX}>
      <Lines lead={lead} caption={caption} painted={false} />
    </Box>
  );
}

export interface CellBlockProps extends CellLinesProps {
  hue: Hue;
  // Given, the block is a link that leads there, and shows a ring when
  // hovered.
  href?: string;
}

// The lines as a block of a hue. A block that leads somewhere is a link
// (ButtonBase makes it focusable; the page's router follows a plain click,
// the modifier keys and the middle button open a tab, and the status bar
// shows where it leads). Its text is selectable, to copy, like the rest of
// the row: the link is not draggable, so a drag across it selects instead
// of dragging the link (Chrome lets a selection begin inside a link only
// where `user-select: text` is set), and the click that ends the drag goes
// nowhere (endsTextSelection). The block's text keeps its hue's ink against
// HUD's global rule painting a grid cell's links blue: it names the ink in
// `--cell-link-color`, which the table's own rule reads (TestsTable).
export function CellBlock({ hue, href, lead, caption }: CellBlockProps) {
  const theme = useTheme();
  const colors = hueColors(theme, hue);
  const painted = {
    ...FRAME_SX,
    color: colors.text,
    backgroundColor: colors.background,
  };
  const lines = <Lines lead={lead} caption={caption} painted />;
  if (href === undefined) {
    return (
      <Box component="span" sx={painted}>
        {lines}
      </Box>
    );
  }
  return (
    <ButtonBase
      component={NextLink}
      href={href}
      prefetch={false}
      draggable={false}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (endsTextSelection(event)) {
          event.preventDefault();
        }
      }}
      sx={{
        ...painted,
        "--cell-link-color": colors.text,
        font: "inherit",
        letterSpacing: "inherit",
        lineHeight: "inherit",
        textDecoration: "none",
        // ButtonBase forbids selecting a button's text; this text is to copy.
        userSelect: "text",
        "&:hover": { boxShadow: `inset 0 0 0 1px ${colors.text}` },
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 1,
        },
      }}
    >
      {lines}
    </ButtonBase>
  );
}
