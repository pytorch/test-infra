import { alpha, type Theme } from "@mui/material/styles";
import type { BarPaint, BasePaint } from "lib/tests/cost/ownerBars";
import type { PreparedHours } from "lib/tests/cost/runnerHours";

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
// seven hues (MACHINE_HUES) by their position among the colored machines;
// the other machines are grey, Unknown machine is grey stripes, a machine
// estimated from a runner label is its hue striped, and the rest of a
// highlighted bar is pale.

export function otherMachinesColor(theme: Theme): string {
  return theme.palette.mode === "dark"
    ? theme.palette.grey[600]
    : theme.palette.grey[500];
}

export function paleColor(theme: Theme): string {
  return alpha(
    theme.palette.text.primary,
    theme.palette.mode === "dark" ? 0.14 : 0.09
  );
}

// Grey stripes at 45°: Unknown machine's, and No test reports'.
export function hatch(color: string): string {
  return `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)`;
}

// A machine's hue where it has one.
export function machineHue(
  theme: Theme,
  prepared: PreparedHours,
  machine: number
): string | undefined {
  const position = prepared.colored.indexOf(machine);
  return position < 0 ? undefined : MACHINE_HUES[theme.palette.mode][position];
}

// Stripes of a paint over its own pale tint, at 135° so they never read as
// Unknown machine's 45° hatch: the machine is still legible, and the stripes
// say it is a guess.
export function estimatedFill(color: string): string {
  return `repeating-linear-gradient(135deg, ${color} 0 2px, ${alpha(
    color,
    0.3
  )} 2px 4px)`;
}

// An owner bar's paint as a CSS background: a machine's hue (the grey of the
// others when it has none), Unknown machine's grey stripes (mid grey reads on
// either background), the accent, the pale rest of a highlighted bar, or any
// of them striped where the machine is estimated.
export function barFill(
  theme: Theme,
  prepared: PreparedHours,
  paint: BarPaint
): string {
  switch (paint.kind) {
    case "estimated":
      return paint.of.kind === "not_probed" || paint.of.kind === "pale"
        ? barFill(theme, prepared, paint.of)
        : estimatedFill(barFill(theme, prepared, paint.of));
    case "machine":
      return (
        machineHue(theme, prepared, paint.machine) ?? otherMachinesColor(theme)
      );
    case "other":
      return otherMachinesColor(theme);
    case "not_probed":
      return hatch(theme.palette.grey[500]);
    case "accent":
      return theme.palette.primary.main;
    case "pale":
      return paleColor(theme);
  }
}

// A runner's shade of its machine's paint in the owner bars' runner lists:
// by its place in the machine's runners (the most runner-hours first), the
// first in the full paint, then lighter steps, the fourth on sharing the
// last. Unknown machine keeps its stripes: the names say which is which.
const RUNNER_SHADES = [1, 0.62, 0.38, 0.22];

export function runnerFill(
  theme: Theme,
  prepared: PreparedHours,
  paint: BasePaint,
  position: number
): string {
  const fill = barFill(theme, prepared, paint);
  if (paint.kind === "not_probed") return fill;
  return alpha(
    fill,
    RUNNER_SHADES[Math.min(Math.max(position, 0), RUNNER_SHADES.length - 1)]
  );
}

// The owner hues, contrast-checked in both modes. Never on one chart with MACHINE_HUES:
// one dimension is stacked at a time. Position = index in namedOwners(); Other owners = otherMachinesColor.
const OWNER_HUES = {
  light: ["#00a9d3", "#ba2c3a", "#978200", "#794881", "#ad4d00"],
  dark: ["#04a0b9", "#ae2738", "#8fa000", "#a14fa3", "#965220"],
};
export function ownerFill(theme: Theme, position: number): string | undefined {
  return OWNER_HUES[theme.palette.mode][position];
}
export function noOwnerColor(theme: Theme): string {
  return theme.palette.mode === "dark" ? "#a8a8a8" : "#c4c4c4";
}
