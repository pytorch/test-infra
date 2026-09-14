import { Box } from "@mui/material";
import { green, lightGreen, red } from "@mui/material/colors";
import { Theme } from "@mui/material/styles";
import { ReactNode } from "react";

// One colour per figure family on the page, so a value and the sub-line naming
// its denominator or its unit can be painted the same and the mapping between
// them needs no reading.
export interface QualityColors {
  land: string;
  // NO_LAND verdicts, review runs that failed or overran, reverts.
  fault: string;
  // A tile carrying two figures paints the first of them in firstFigure and the
  // second in secondFigure, in the order they appear on the face. One pair for
  // the whole page: the tiles that need it measure unrelated things, and a pair
  // per tile would make the same position mean a different colour tile to tile.
  firstFigure: string;
  secondFigure: string;
}

// Measured against the background the tile actually paints: in dark mode MUI
// lays --Paper-overlay over Paper, so elevation 3 lifts #2A2A2A by 8.2% white to
// #3b3b3b. Every entry clears 4.5:1 there or on #ffffff, whichever mode it is
// picked for, because the sub-lines are 14px. Several MUI defaults do not reach
// it — error.main is 3.04:1 on #3b3b3b, success.dark 2.72:1 there — so each mode
// takes whichever token does rather than the same one twice.
export function qualityColors(theme: Theme): QualityColors {
  const dark = theme.palette.mode === "dark";
  return {
    land: theme.palette.success.main,
    fault: dark ? red[200] : theme.palette.error.main,
    // The lighter of the pair stays the lighter one in both modes, but the two
    // ramps barely overlap: of the whole green and lightGreen ramp only three
    // shades clear AA on white, all at the dark end, which caps the light-mode
    // pair at dE2000 10.5. Dark mode is not so constrained and takes the widest
    // separation available without leaving the muted register the rest of the
    // page sits in.
    firstFigure: dark ? lightGreen.A100 : green[800],
    secondFigure: dark ? green[400] : green[900],
  };
}

// Box renders a <div>, and the pieces of one figure would each take a line of
// their own.
export function tinted(text: ReactNode, color: string) {
  return (
    <Box component="span" sx={{ color }}>
      {text}
    </Box>
  );
}
