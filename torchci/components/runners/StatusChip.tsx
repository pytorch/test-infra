/**
 * @fileoverview Status chip component for GitHub Actions runners
 *
 * Displays the current status of a GitHub Actions runner
 *
 */

import { Chip } from "@mui/material";
import { RunnerData } from "lib/runnerUtils";

export function StatusChip({ runner }: { runner: RunnerData }) {
  let color: "success" | "warning" | "default";
  let label: string;

  if (runner.status === "offline") {
    color = "default";
    label = "offline";
  } else if (runner.busy) {
    color = "warning";
    label = "busy";
  } else {
    color = "success";
    label = "idle";
  }

  return (
    <Chip
      label={label}
      color={color}
      size="small"
      sx={{ minWidth: 80, fontWeight: "bold" }}
    />
  );
}