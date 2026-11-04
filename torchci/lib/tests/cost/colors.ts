import { alpha, type Theme } from "@mui/material/styles";
import type { Paint, PreparedHours } from "lib/tests/cost/runnerHours";

// Seven hues for the seven largest machines, checked with the dataviz palette
// validator for neighbours that stay apart under color-vision deficiency, in
// light and dark steps of the same hues. Hue here names a machine; the hub
// keeps hue for status in its tables, where no chart needs it.
const MACHINE_HUES = {
  light: [
    "#2a78d6",
    "#eb6834",
    "#1baf7a",
    "#eda100",
    "#e87ba4",
    "#008300",
    "#6250d6",
  ],
  dark: [
    "#3987e5",
    "#d95926",
    "#199e70",
    "#c98500",
    "#d55181",
    "#008300",
    "#9085e9",
  ],
};

// The cost page's colors, every one by the theme's mode. Machines take the
// split chart's seven hues (MACHINE_HUES, checked with the dataviz palette
// validator) by their position among the colored machines; the other
// machines are grey, Unknown machine is grey stripes, hours whose machine
// is estimated are stripes in their machine's paint, and the rest of a
// highlighted bar is pale. The matrix shades by one sequential blue ramp, its own light
// and dark steps, the cell's text dark or light by contrast.

export function otherMachinesColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? theme.palette.grey[600]
    : theme.palette.grey[500];
}

// Mid grey reads on either background, so one step serves both modes.
function notProbedColor(theme: Theme): string {
  return theme.palette.grey[500];
}

export function paleColor(theme: Theme): string {
  return alpha(
    theme.palette.text.primary,
    theme.palette.mode === "dark" ? 0.14 : 0.09
  );
}

// Unknown machine's grey stripes, at 45° so they never read as an estimated
// grey machine's 135° stripes.
export function hatch(color: string): string {
  return `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)`;
}

// Stripes of a paint over its own pale tint: the machine is still legible,
// and the stripes say it is a guess.
export function estimatedFill(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 2px, ${alpha(
    color,
    0.3
  )} 2px 4px)`;
}

// A paint as a CSS background.
export function paintFill(
  theme: Theme,
  prepared: PreparedHours,
  paint: Paint
): string {
  switch (paint.kind) {
    case "estimated":
      return paint.of.kind === "not_probed" || paint.of.kind === "pale"
        ? paintFill(theme, prepared, paint.of)
        : estimatedFill(paintFill(theme, prepared, paint.of));
    case "machine": {
      const position = prepared.colored.indexOf(paint.machine);
      return (
        MACHINE_HUES[theme.palette.mode][position] ?? otherMachinesColor(theme)
      );
    }
    case "other":
      return otherMachinesColor(theme);
    case "not_probed":
      return hatch(notProbedColor(theme));
    case "accent":
      return theme.palette.primary.main;
    case "pale":
      return paleColor(theme);
  }
}

// A machine's hue where it has one, for the shard profiles' marks.
export function machineHue(
  theme: Theme,
  prepared: PreparedHours,
  machine: number
): string | undefined {
  const position = prepared.colored.indexOf(machine);
  return position < 0 ? undefined : MACHINE_HUES[theme.palette.mode][position];
}

const RAMP = {
  light: [
    "#eef4fc",
    "#cde2fb",
    "#9ec5f4",
    "#6da7ec",
    "#3987e5",
    "#256abf",
    "#184f95",
    "#0d366b",
  ],
  dark: [
    "#1f2733",
    "#173a66",
    "#184f95",
    "#256abf",
    "#3987e5",
    "#6da7ec",
    "#9ec5f4",
    "#cde2fb",
  ],
};

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A share from 0 to 1 as a cell's background and text, a faint step above
// zero so every filled cell reads as filled.
export function heatColors(theme: Theme, share: number) {
  const ramp = RAMP[theme.palette.mode];
  const t = (0.04 + 0.96 * Math.max(0, Math.min(1, share))) * (ramp.length - 1);
  const i = Math.min(Math.floor(t), ramp.length - 2);
  const f = t - i;
  const a = rgb(ramp[i]);
  const b = rgb(ramp[i + 1]);
  const hex = `#${a
    .map((v, j) =>
      Math.round(v + (b[j] - v) * f)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
  const L = luminance(hex);
  // Whichever of near-black and near-white contrasts more.
  const color = (L + 0.05) / 0.064 >= 1.05 / (L + 0.05) ? "#1f1f1f" : "#fcfcfb";
  return { background: hex, color };
}

// The ramp's ends, for its key.
export function rampGradient(theme: Theme): string {
  return `linear-gradient(to right, ${RAMP[theme.palette.mode].join(", ")})`;
}
