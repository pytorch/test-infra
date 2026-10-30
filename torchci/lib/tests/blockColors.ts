import type { Theme } from "@mui/material";
import type { BlockStatus } from "lib/tests/health";

// The hub's status colors, in one place, so the list page's Health blocks
// and the test page's run grid move together. Each hue has its colors in
// each mode for a big pill, the Health block that fills a cell of the list
// (a pale background with the text in a deep shade of the same color), and
// for a small pill, a cell of the grid a few pixels wide (a tint for its
// fill, a mid shade for its edge, and a deeper shade for its fill under the
// pointer); a small pill's ring under the pointer is the big pill's text
// shade, the block's ink. The small colors may deviate from the big ones
// where a few pixels need more color: the small red is two steps stronger
// in fill and edge, since at a cell's size the block's pale red was
// mistaken for the skipped purple and one step was not red enough; its
// hover fill is its edge, the ring doing the rest. GitHub's label scale
// throughout, since the theme has neither yellow nor purple and its warning
// orange would read as a fourth thing beside the red; each big red, yellow
// and purple pair was measured at 4.5:1 or better in the browser. The list
// page leaves Healthy plain by decision, so no big green is drawn; the
// pair is GitHub's success colors, kept so the palette is whole, and the
// small green's fill is the pale green chosen for it, 213, 245, 222.
export type Hue = "red" | "yellow" | "green" | "purple";

export interface BlockColors {
  background: string;
  text: string;
}

export interface SmallPillColors {
  fill: string;
  edge: string;
  hoverFill: string;
}

export interface PillColors {
  big: BlockColors;
  small: SmallPillColors;
}

type Mode = Theme["palette"]["mode"];

export const PILL_COLORS: Record<Hue, Record<Mode, PillColors>> = {
  red: {
    light: {
      big: { background: "#ffebe9", text: "#cf222e" },
      small: { fill: "#ffaba8", edge: "#fa4549", hoverFill: "#fa4549" },
    },
    dark: {
      big: { background: "rgba(248, 81, 73, 0.18)", text: "#ff7b72" },
      small: {
        fill: "rgba(248, 81, 73, 0.4)",
        edge: "#f85149",
        hoverFill: "#f85149",
      },
    },
  },
  yellow: {
    light: {
      big: { background: "#fff8c5", text: "#8a5c00" },
      small: { fill: "#fff8c5", edge: "#f2d366", hoverFill: "#eac54f" },
    },
    dark: {
      big: { background: "rgba(187, 128, 9, 0.2)", text: "#d29922" },
      small: {
        fill: "rgba(187, 128, 9, 0.2)",
        edge: "#9e6a03",
        hoverFill: "#bb8009",
      },
    },
  },
  green: {
    light: {
      big: { background: "#dafbe1", text: "#1a7f37" },
      small: {
        fill: "rgb(213, 245, 222)",
        edge: "#8ee6a3",
        hoverFill: "#6fdd8b",
      },
    },
    dark: {
      big: { background: "rgba(46, 160, 67, 0.18)", text: "#3fb950" },
      small: {
        fill: "rgba(63, 185, 80, 0.2)",
        edge: "#238636",
        hoverFill: "#2ea043",
      },
    },
  },
  purple: {
    light: {
      big: { background: "#fbefff", text: "#6e40c9" },
      small: { fill: "#fbefff", edge: "#e2c9ff", hoverFill: "#d8b9ff" },
    },
    dark: {
      big: { background: "rgba(163, 113, 247, 0.18)", text: "#d2a8ff" },
      small: {
        fill: "rgba(163, 113, 247, 0.18)",
        edge: "#6e40c9",
        hoverFill: "#8957e5",
      },
    },
  },
};

function pillColors(theme: Theme, hue: Hue): PillColors {
  return PILL_COLORS[hue][theme.palette.mode];
}

// The big pill: a Health block's colors.
export function hueColors(theme: Theme, hue: Hue): BlockColors {
  return pillColors(theme, hue).big;
}

// The small pill: a grid cell's colors.
export function smallPillColors(theme: Theme, hue: Hue): SmallPillColors {
  return pillColors(theme, hue).small;
}

// The hue of each status that is a block: failing red, flaky yellow,
// skipped purple.
export const STATUS_HUES: Record<BlockStatus, Hue> = {
  failing: "red",
  flaky: "yellow",
  skipped: "purple",
};
