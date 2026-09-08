// The traffic-light glyph that marks a PR's GreenLight state on the HUD's own
// surfaces. One component owns the status -> colour/label mapping so the trunk
// HUD, the commit page and the PR page cannot drift into saying different
// things about the same row.
//
// Renders nothing for a status it does not know. That is deliberate: the ledger
// grows statuses on the Python side (greenlight/src/greenlight/constants.py) and
// an unrecognised one must read as "no claim", never fall back to a colour that
// implies a verdict.

import { Tooltip, useTheme } from "@mui/material";
import {
  GREENLIGHT_INCOMPLETE_HEADLINE,
  GREENLIGHT_LAND_HEADLINE,
  GREENLIGHT_NO_LAND_HEADLINE,
  GREENLIGHT_REVERTED_HEADLINE,
  GREENLIGHT_REVIEWING_HEADLINE,
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";

type Tone = "approved" | "declined" | "running" | "inconclusive";

// Two shades per tone because the HUD renders on both palettes and a single
// value legible on one is washed out or glaring on the other (torchci/CLAUDE.md).
const TONE_COLORS: Record<Tone, { light: string; dark: string }> = {
  approved: { light: "#2e7d32", dark: "#66bb6a" },
  declined: { light: "#c62828", dark: "#ef5350" },
  running: { light: "#ed6c02", dark: "#ffa726" },
  inconclusive: { light: "#757575", dark: "#9e9e9e" },
};

const STATUS_TONES: Record<string, { tone: Tone; label: string }> = {
  [GREENLIGHT_STATUS_LAND]: {
    tone: "approved",
    label: GREENLIGHT_LAND_HEADLINE,
  },
  [GREENLIGHT_STATUS_NO_LAND]: {
    tone: "declined",
    label: GREENLIGHT_NO_LAND_HEADLINE,
  },
  [GREENLIGHT_STATUS_AI_REVIEW_STARTED]: {
    tone: "running",
    label: GREENLIGHT_REVIEWING_HEADLINE,
  },
  [GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED]: {
    tone: "running",
    label: GREENLIGHT_REVIEWING_HEADLINE,
  },
  [GREENLIGHT_STATUS_CANCELLED]: {
    tone: "inconclusive",
    label: GREENLIGHT_INCOMPLETE_HEADLINE,
  },
  [GREENLIGHT_STATUS_FAILED]: {
    tone: "inconclusive",
    label: GREENLIGHT_INCOMPLETE_HEADLINE,
  },
  [GREENLIGHT_STATUS_REVERTED]: {
    tone: "inconclusive",
    label: GREENLIGHT_REVERTED_HEADLINE,
  },
};

// The same signal as the svg, as one character, for the one place that cannot
// hold an element: a native <option>. Its content is text, and no browser lets
// you colour that text reliably -- so the colour has to be in the glyph itself.
const TONE_GLYPHS: Record<Tone, string> = {
  approved: "\u{1F7E2}", // green circle
  declined: "\u{1F534}", // red circle
  running: "\u{1F7E1}", // yellow circle
  inconclusive: "⚪", // white circle
};

/**
 * The single-character form of the glyph, or "" if the status is unrecognised.
 * Callers concatenate it into plain text, so "" has to mean "add nothing".
 */
export function greenlightGlyphChar(status: string | undefined | null): string {
  const entry = STATUS_TONES[(status ?? "").trim()];
  return entry === undefined ? "" : TONE_GLYPHS[entry.tone];
}

export default function GreenLightIcon({
  status,
  size = 12,
  titleSuffix,
}: {
  status: string | undefined | null;
  size?: number;
  // Appended to the tooltip, for callers that can say more than the status does
  // on its own (e.g. which commit the verdict was reached on).
  titleSuffix?: string;
}) {
  const theme = useTheme();
  const entry = STATUS_TONES[(status ?? "").trim()];
  if (entry === undefined) {
    return null;
  }

  const colors = TONE_COLORS[entry.tone];
  const fill = theme.palette.mode === "dark" ? colors.dark : colors.light;
  const label = `Green Light: ${entry.label}${
    titleSuffix ? ` (${titleSuffix})` : ""
  }`;

  return (
    <Tooltip title={label}>
      <svg
        role="img"
        aria-label={label}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        // Nudged onto the text baseline; an svg is inline and would otherwise
        // sit on the line box bottom and push the row taller.
        style={{ verticalAlign: "text-bottom", flexShrink: 0 }}
      >
        <circle
          cx="8"
          cy="8"
          r="6.5"
          fill="none"
          stroke={fill}
          strokeOpacity="0.45"
          strokeWidth="1.5"
        />
        <circle cx="8" cy="8" r="4" fill={fill} />
      </svg>
    </Tooltip>
  );
}
