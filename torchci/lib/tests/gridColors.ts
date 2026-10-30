import type { Theme } from "@mui/material/styles";
import { Hue, hueColors, smallPillColors } from "lib/tests/blockColors";
import type { CellStatus, StretchTone } from "lib/tests/grid";
import { headerBandColor, headerBandHoverColor } from "lib/tests/headerColors";

// The colors of the run grid, each following the theme's mode. A cell is a
// small pill of its status's hue from the hub's one palette (PILL_COLORS in
// blockColors.ts, which also holds the list page's Health blocks, so the
// two move together): a failure red, a run that recovered yellow, a pass
// green, a skip purple. A cell's fill marks its status and nothing else.
// An expected failure or an unknown has no hue: no fill, an edge in the
// disabled tone.
const STATUS_HUE: Record<Exclude<CellStatus, "other">, Hue> = {
  failed: "red",
  flaky: "yellow",
  passed: "green",
  skipped: "purple",
};

// An attempt's pill on the card: the health blocks' pale background with
// the hue's ink for the word, so "Crashed" and "Passed" read in the colors
// the grid's cells and the list's blocks already use; the plain pill for an
// outcome with no hue.
export interface AttemptPillColors {
  background: string;
  text: string;
}

export function attemptPillColors(
  theme: Theme,
  status: CellStatus
): AttemptPillColors {
  if (status === "other") {
    return {
      background: theme.palette.action.selected,
      text: theme.palette.text.secondary,
    };
  }
  const colors = hueColors(theme, STATUS_HUE[status]);
  return { background: colors.background, text: colors.text };
}

export function cellFill(theme: Theme, status: CellStatus): string {
  return status === "other"
    ? "none"
    : smallPillColors(theme, STATUS_HUE[status]).fill;
}

// A cell's edge, one pixel inside its box, since at a cell's size the pale
// fill alone is hard to see on the page.
export function cellStroke(theme: Theme, status: CellStatus): string {
  return status === "other"
    ? theme.palette.text.disabled
    : smallPillColors(theme, STATUS_HUE[status]).edge;
}

// A cell under the pointer, marked as the health blocks mark themselves
// when hovered: ringed in the block's text shade, the ink of the block,
// over a fill a step deeper than its edge, so the cell darkens a step and
// its ring darkens another.
export interface CellHoverColors {
  fill: string;
  stroke: string;
}

export function cellHoverColors(
  theme: Theme,
  status: CellStatus
): CellHoverColors {
  if (status === "other") {
    return {
      fill: theme.palette.action.selected,
      stroke: theme.palette.text.secondary,
    };
  }
  const hue = STATUS_HUE[status];
  return {
    fill: smallPillColors(theme, hue).hoverFill,
    stroke: hueColors(theme, hue).text,
  };
}

// The time bar's blocks: a stretch at the oldest stretch's time, within a
// tenth, is a neutral grey; a slower one takes the failed hue's pale
// background, pill edge and ink, a faster one the passed hue's, since
// slower is the bad news and faster the good. The change figure written in
// a block is in that ink too. Nothing changes under the pointer: the
// blocks are read, not pressed.
export interface StretchColors {
  fill: string;
  edge: string;
  text: string;
}

export function stretchColors(theme: Theme, tone: StretchTone): StretchColors {
  if (tone === "same") {
    return theme.palette.mode === "dark"
      ? {
          fill: "rgba(255, 255, 255, 0.08)",
          edge: "rgba(255, 255, 255, 0.26)",
          text: theme.palette.text.primary,
        }
      : { fill: "#eef0f2", edge: "#cfd4da", text: theme.palette.text.primary };
  }
  const hue = tone === "slower" ? "red" : "green";
  return {
    fill: hueColors(theme, hue).background,
    edge: smallPillColors(theme, hue).edge,
    text: hueColors(theme, hue).text,
  };
}

// The bar beside a configuration's typical time, its share of the slowest
// configuration's: a quiet grey, so the figures stay the reading.
export function typicalBarColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? "rgba(255, 255, 255, 0.2)"
    : "rgba(0, 0, 0, 0.16)";
}

// The badge counting a lane's variables: the header band's grey, as the
// list page's badge is, a step darker under the pointer and while the lane
// is expanded.
export function badgeColors(theme: Theme): {
  fill: string;
  activeFill: string;
} {
  return {
    fill: headerBandColor(theme),
    activeFill: headerBandHoverColor(theme),
  };
}

// The band behind a weekend's columns: a shade off the page background.
export function weekendBandColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? "rgba(255, 255, 255, 0.03)"
    : "rgba(0, 0, 0, 0.025)";
}

// The band over the column under the pointer and the pill naming its
// commit in the footer: the theme's blue, the pill solid, the band a wash
// of it, since a grey band and pill were easy to miss.
export function hoverBandColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? "rgba(74, 144, 226, 0.24)"
    : "rgba(25, 118, 210, 0.14)";
}

// The commit the header's search found: a band over its column and a pill
// pinned in the footer, in orange, a hue the grid uses for nothing else,
// so the found column is told from the blue of the column under the
// pointer and from the statuses' red, yellow, green and purple. The band is a wash of
// the pill's color; the text is dark on the orange in both modes, white on
// it falling short of the contrast small text needs (3.1:1 in light mode).
export interface PinnedCommitColors {
  band: string;
  background: string;
  text: string;
}

export function pinnedCommitColors(theme: Theme): PinnedCommitColors {
  return theme.palette.mode === "dark"
    ? {
        band: "rgba(255, 167, 38, 0.3)",
        background: "#ffa726",
        text: "rgba(0, 0, 0, 0.87)",
      }
    : {
        band: "rgba(239, 108, 0, 0.18)",
        background: "#ef6c00",
        text: "rgba(0, 0, 0, 0.87)",
      };
}

export interface CommitPillColors {
  background: string;
  text: string;
}

export function commitPillColors(theme: Theme): CommitPillColors {
  return {
    background: theme.palette.primary.main,
    text: theme.palette.primary.contrastText,
  };
}
