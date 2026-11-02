import { Box } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { CELL_EDGE, CellStatus, GRID_SIZES } from "lib/tests/grid";
import { cellFill, cellStroke } from "lib/tests/gridColors";

// A swatch of a status, as the grid's card and header menus show it: a
// cell, fill and edge, in the status's colors for the theme's mode. The
// words beside it say what it is, so it is hidden from assistive
// technology.
export default function Swatch({
  theme,
  status,
}: {
  theme: Theme;
  status: CellStatus;
}) {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        flex: "none",
        boxSizing: "border-box",
        width: GRID_SIZES.swatchWidth,
        height: GRID_SIZES.cellHeight,
        borderRadius: "999px",
        backgroundColor: cellFill(theme, status),
        border: `${CELL_EDGE}px solid ${cellStroke(theme, status)}`,
      }}
    />
  );
}
