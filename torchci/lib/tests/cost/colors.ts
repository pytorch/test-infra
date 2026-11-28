import { alpha, type Theme } from "@mui/material/styles";
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
// the other machines are grey, Unknown machine is grey stripes, and the rest
// of a highlighted bar is pale.

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
