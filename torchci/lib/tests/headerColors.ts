import type { Theme } from "@mui/material/styles";
import { BlockColors, Hue, hueColors } from "lib/tests/blockColors";

// The colors of the tests table's header band, defined once for the grid's
// own styles and for the controls set on the band. Every color follows the
// theme's mode.

// The band itself: the grey of the title's pills.
export function headerBandColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? theme.palette.grey[800]
    : theme.palette.grey[200];
}

// A step darker than the band: a pill or badge in the band's grey under the
// pointer (InlinePill, ViewChips, the grid's variables badge).
export function headerBandHoverColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? theme.palette.grey[700]
    : theme.palette.grey[300];
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

// A control set on the band, a key: a rounded square or pill on the page's
// background with a ruled edge, so it stands off the grey band as a control
// in either mode; filled in the accent while it narrows what the table
// shows (`active`), edged in the accent while its menu is open or it has
// focus (`open`); hovering darkens the fill or strengthens the edge. One
// style for every key: HeaderFilter, NameSearch, HeaderSelect, HeaderCheck
// and HeaderSearch.
export const HEADER_KEY_RADIUS = "6px";

export interface HeaderKeyColors {
  background: string;
  edge: string;
  color: string;
  hoverBackground: string;
  hoverEdge: string;
}

export function headerKeyColors(
  theme: Theme,
  state: { active?: boolean; open?: boolean } = {}
): HeaderKeyColors {
  const accent = theme.palette.primary.main;
  if (state.active) {
    return {
      background: accent,
      edge: accent,
      color: theme.palette.primary.contrastText,
      hoverBackground: theme.palette.primary.dark,
      hoverEdge: theme.palette.primary.dark,
    };
  }
  return {
    background: theme.palette.background.default,
    edge: state.open ? accent : headerRuleColor(theme),
    color: state.open ? accent : theme.palette.text.primary,
    hoverBackground: theme.palette.background.default,
    hoverEdge: state.open ? accent : theme.palette.text.secondary,
  };
}

// The key's frame as sx: its corners, edge, fill and text color, the
// transition between its states, and the hover. The focus ring is apart,
// since each control marks focus on its own element.
export function headerKeySx(theme: Theme, colors: HeaderKeyColors) {
  return {
    borderRadius: HEADER_KEY_RADIUS,
    border: `1px solid ${colors.edge}`,
    backgroundColor: colors.background,
    color: colors.color,
    transition: theme.transitions.create(
      ["background-color", "border-color", "color"],
      { duration: theme.transitions.duration.shortest }
    ),
    "&:hover": {
      backgroundColor: colors.hoverBackground,
      borderColor: colors.hoverEdge,
    },
  };
}

// A pill's tone: a status, the commit page's GreenLight verdict, in the
// hub's status colors, a hue's pale background with its ink (hueColors), as
// a Health block and an attempt's pill are painted: green for good news,
// yellow for what needs a look. A fact has no tone: the commit page's pull
// request number was a pill in GitHub's blue until 2026-11-11, when the
// user had it made grey, so that color in a header says a status and
// nothing else.
export type PillTone = "positive" | "caution";

const TONE_HUES: Record<PillTone, Hue> = {
  positive: "green",
  caution: "yellow",
};

export function tonePillColors(theme: Theme, tone: PillTone): BlockColors {
  return hueColors(theme, TONE_HUES[tone]);
}

// A chip set inside a pill's end (FactPill's `chip`), the commit inside its
// pull request: the page's own background on the pill's grey, as a header
// key is on the band, in the primary ink. At rest it is lifted off the pill
// by a faint shadow in the light mode, and marked by a faint edge in the
// dark one, where a shadow does not show; under the pointer it is ringed in
// the secondary ink, as a key's edge is.
export interface PillChipColors {
  background: string;
  text: string;
  // The chip's box shadow at rest, and under the pointer.
  rest: string;
  hover: string;
}

export function pillChipColors(theme: Theme): PillChipColors {
  const ring = `inset 0 0 0 1px ${theme.palette.text.secondary}`;
  const lift = "0 1px 1.5px rgba(0, 0, 0, 0.1)";
  return {
    background: theme.palette.background.default,
    text: theme.palette.text.primary,
    ...(theme.palette.mode === "dark"
      ? { rest: "inset 0 0 0 1px rgba(255, 255, 255, 0.1)", hover: ring }
      : { rest: lift, hover: `${ring}, ${lift}` }),
  };
}

// The lamp of a status pill, the dot before its words: GitHub's green and
// yellow at the strength of a light, brighter than the ink beside it, which
// is set for reading; the secondary text color for a pill with no status to
// color.
export function lampColor(theme: Theme, tone: PillTone | undefined): string {
  const dark = theme.palette.mode === "dark";
  switch (tone) {
    case "positive":
      return dark ? "#3fb950" : "#2da44e";
    case "caution":
      return dark ? "#d29922" : "#bf8700";
    default:
      return theme.palette.text.secondary;
  }
}

// The keys' focus ring, for the keyboard.
export function headerKeyFocusRing(theme: Theme) {
  return {
    outline: `2px solid ${theme.palette.primary.main}`,
    outlineOffset: 2,
  };
}
