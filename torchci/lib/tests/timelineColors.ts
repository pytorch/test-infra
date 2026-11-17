import type { Theme } from "@mui/material/styles";
import { hueColors, solidHueColor } from "lib/tests/blockColors";

// The colors of the commit page's timeline, in either mode. The outcomes
// wear the hub's status hues (blockColors.ts). Test time is a blue of its
// own, a hue no outcome has; unaccounted time is hatched in a soft pink, so
// it stands off the test time beside it; other steps are a solid grey, well
// off the grey that the rows outside an open job fade to, and queued a line
// of dots.
export interface TimelineColors {
  tests: string;
  failed: string;
  flaky: string;
  skipped: string;
  // Text and its background for a failed or a flaky mark.
  failedInk: string;
  failedWash: string;
  flakyInk: string;
  flakyWash: string;
  other: string;
  // Unaccounted time: the lines of its hatch, and the wash under them.
  hatch: string;
  hatchWash: string;
  queue: string;
  gridLine: string;
  // The picked row, and its name in the table's title: a wash of the accent.
  selected: string;
}

export function timelineColors(theme: Theme): TimelineColors {
  const dark = theme.palette.mode === "dark";
  const red = hueColors(theme, "red");
  const yellow = hueColors(theme, "yellow");
  return {
    tests: dark ? "#56a4eb" : "#4a94eb",
    failed: solidHueColor(theme, "red"),
    flaky: solidHueColor(theme, "yellow"),
    skipped: solidHueColor(theme, "purple"),
    failedInk: red.text,
    failedWash: red.background,
    flakyInk: yellow.text,
    flakyWash: yellow.background,
    other: dark ? "rgba(255, 255, 255, 0.36)" : "#a4adba",
    hatch: dark ? "#f778ba" : "#e85aad",
    hatchWash: dark ? "rgba(247, 120, 186, 0.24)" : "rgba(232, 90, 173, 0.24)",
    queue: dark ? "rgba(255, 255, 255, 0.58)" : "rgba(0, 0, 0, 0.5)",
    gridLine: dark ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0.06)",
    selected: dark ? "rgba(74, 144, 226, 0.18)" : "rgba(25, 118, 210, 0.1)",
  };
}
