import { Box, ButtonBase, Typography, useTheme } from "@mui/material";
import TextButton from "components/tests/TextButton";
import { estimatedFill, paintFill } from "lib/tests/cost/colors";
import { hoursLabel, shareLabel } from "lib/tests/cost/query";
import {
  type CostView,
  machineKeyRows,
  type PreparedHours,
  scopeName,
} from "lib/tests/cost/runnerHours";
import { HEADER_TITLE_STYLE } from "lib/tests/layout";
import { useState } from "react";

export interface MachineKeyProps {
  prepared: PreparedHours;
  view: CostView;
  onToggleMachines: (_machines: string[]) => void;
  onClearMachines: () => void;
}

// The owner chart's legend, machine picker and machine shares in one: a row
// per colored machine, the other machines together (listed while open) and
// Unknown machine, each with its share of the scope. A click highlights the
// machine across the page; with owners highlighted, the solid part of each
// bar and the figure are their hours on that machine. Without, the striped
// end of a bar is the hours whose machine is estimated from runner labels.
export default function MachineKey({
  prepared,
  view,
  onToggleMachines,
  onClearMachines,
}: MachineKeyProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const rows = machineKeyRows(prepared, view, open);
  const max = Math.max(1, ...rows.map((r) => r.hours));
  const total = view.scopeTotal || 1;
  const owners = view.owners.size > 0;
  const machines = view.machines.size > 0;
  return (
    <Box sx={{ typography: "body2" }}>
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.75, mb: 0.5 }}>
        <Typography
          component="h3"
          sx={{
            ...HEADER_TITLE_STYLE,
            fontSize: "0.75rem",
            color: "text.secondary",
          }}
        >
          Machines
        </Typography>
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          · share of {hoursLabel(view.scopeTotal)} h
          {view.scope.size > 0 ? ` in ${scopeName(prepared, view)}` : ""}
        </Typography>
        <Box sx={{ mr: "auto" }} />
        {machines && (
          <TextButton
            label="Clear the machine highlight"
            onClick={onClearMachines}
          >
            <Box component="span" sx={{ color: "primary.main" }}>
              Clear
            </Box>
          </TextButton>
        )}
      </Box>
      <Typography
        variant="caption"
        component="p"
        sx={{ color: "text.secondary", mb: 1 }}
      >
        Bar colors. Click to highlight
        {owners
          ? "; solid: highlighted owners"
          : "; striped: machine estimated from runner labels"}
        .
      </Typography>
      {rows.map((row) => {
        const selected = row.machines.some((m) => view.machines.has(m));
        const fill = paintFill(theme, prepared, row.paint);
        const names = row.machines.map((m) => prepared.machines[m]);
        return (
          <Box
            key={`${row.kind}:${row.key}`}
            sx={{
              display: "grid",
              gridTemplateColumns: "18px minmax(0, 1fr)",
              alignItems: "center",
            }}
          >
            {row.kind === "group" ? (
              <ButtonBase
                aria-label={
                  open ? "Fold the other machines" : "List the other machines"
                }
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                sx={{
                  height: 24,
                  borderRadius: "4px",
                  color: "primary.main",
                  "&:hover": { backgroundColor: "action.hover" },
                  "&.Mui-focusVisible": {
                    outline: `2px solid ${theme.palette.primary.main}`,
                  },
                }}
              >
                {open ? "▾" : "▸"}
              </ButtonBase>
            ) : (
              <span />
            )}
            <ButtonBase
              component="div"
              aria-pressed={selected}
              onClick={() => onToggleMachines(names)}
              title={`${row.label}: ${hoursLabel(row.hours)} runner-hours${
                row.estimated > 0
                  ? `, of which ≈ ${hoursLabel(
                      row.estimated
                    )} h estimated from runner labels (test jobs without reports)`
                  : ""
              }${
                owners
                  ? `; ${hoursLabel(
                      row.highlighted
                    )} h for the highlighted owners`
                  : ""
              }`}
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) 56px 36px 64px",
                alignItems: "center",
                columnGap: 1,
                width: "100%",
                minHeight: 24,
                px: 0.5,
                borderRadius: "4px",
                textAlign: "left",
                font: "inherit",
                opacity: machines && !selected ? 0.45 : 1,
                "&:hover": { backgroundColor: "action.hover" },
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                },
              }}
            >
              <Box
                component="span"
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  minWidth: 0,
                  pl: row.kind === "member" ? 2.5 : 0,
                  color:
                    row.kind === "member" ? "text.secondary" : "text.primary",
                  fontWeight: selected ? 600 : 400,
                }}
              >
                {row.kind !== "member" && (
                  <Box
                    component="span"
                    sx={{
                      flex: "0 0 auto",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: fill,
                      outline:
                        row.paint.kind === "not_probed"
                          ? `1px solid ${theme.palette.grey[500]}`
                          : undefined,
                    }}
                  />
                )}
                <Box
                  component="span"
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {selected ? "✓ " : ""}
                  {row.label}
                </Box>
              </Box>
              <Box component="span" sx={{ position: "relative", height: 8 }}>
                <Box
                  component="span"
                  sx={{
                    position: "absolute",
                    inset: 0,
                    width: `${
                      (100 * (owners ? row.hours : row.hours - row.estimated)) /
                      max
                    }%`,
                    background: fill,
                    borderRadius: "2px",
                    opacity: owners ? 0.28 : 1,
                  }}
                />
                {!owners && row.estimated > 0 && (
                  <Box
                    component="span"
                    sx={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: `${(100 * (row.hours - row.estimated)) / max}%`,
                      width: `${(100 * row.estimated) / max}%`,
                      background: estimatedFill(fill),
                      borderRadius: "2px",
                    }}
                  />
                )}
                {owners && (
                  <Box
                    component="span"
                    sx={{
                      position: "absolute",
                      inset: 0,
                      width: `${(100 * row.highlighted) / max}%`,
                      background: fill,
                      borderRadius: "2px",
                    }}
                  />
                )}
              </Box>
              <Box
                component="span"
                sx={{
                  color: "text.secondary",
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {shareLabel(row.hours / total)}
              </Box>
              <Box
                component="span"
                sx={{
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  color: owners ? "text.primary" : "text.secondary",
                  fontWeight: owners ? 500 : 400,
                }}
              >
                {hoursLabel(owners ? row.highlighted : row.hours)} h
              </Box>
            </ButtonBase>
          </Box>
        );
      })}
    </Box>
  );
}
