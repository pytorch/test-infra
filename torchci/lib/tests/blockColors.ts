import type { Theme } from "@mui/material";
import type { BlockStatus } from "lib/tests/health";

// The hues a cell's block can take, and their colors in each mode: a pale
// background with the text in a dark shade of the same color, GitHub's
// label colors, since the theme has neither yellow nor purple and its
// warning orange would read as a fourth thing beside the red. Each pair
// was measured at 4.5:1 or better in the browser.
export type Hue = "red" | "yellow" | "purple";

export interface BlockColors {
  background: string;
  text: string;
}

export function hueColors(theme: Theme, hue: Hue): BlockColors {
  const dark = theme.palette.mode === "dark";
  switch (hue) {
    case "red":
      return dark
        ? { background: "rgba(248, 81, 73, 0.18)", text: "#ff7b72" }
        : { background: "#ffebe9", text: "#cf222e" };
    case "yellow":
      return dark
        ? { background: "rgba(187, 128, 9, 0.2)", text: "#d29922" }
        : { background: "#fff8c5", text: "#8a5c00" };
    case "purple":
      return dark
        ? { background: "rgba(163, 113, 247, 0.18)", text: "#d2a8ff" }
        : { background: "#fbefff", text: "#6e40c9" };
  }
}

// The hue of each status that is a block: failing red, flaky yellow,
// skipped purple.
export const STATUS_HUES: Record<BlockStatus, Hue> = {
  failing: "red",
  flaky: "yellow",
  skipped: "purple",
};
