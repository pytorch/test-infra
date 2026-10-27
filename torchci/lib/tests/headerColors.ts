import type { Theme } from "@mui/material/styles";

// The colors of the tests table's header band, defined once for the grid's
// own styles and for the controls set on the band. Every color follows the
// theme's mode.

// The band itself: the grey of the title's pills.
export function headerBandColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? theme.palette.grey[800]
    : theme.palette.grey[200];
}

// Lines on the band: the rules between its columns and the edges of its
// controls. Two steps of grey off the band in either mode; the palette's
// divider color is for lines on the page background and all but vanishes
// on the band.
export function headerRuleColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? theme.palette.grey[600]
    : theme.palette.grey[400];
}
