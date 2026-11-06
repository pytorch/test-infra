import { Box, ButtonBase, useTheme } from "@mui/material";
import type { CostChanges } from "lib/api/tests/cost/types";
import {
  type ChangeRow,
  changeWord,
  labelMachines,
  machineChanges,
  machineLines,
} from "lib/tests/cost/changes";
import { otherMachinesColor, paintFill } from "lib/tests/cost/colors";
import { fineAmountLabel, shareLabel } from "lib/tests/cost/query";
import type { RatesFile } from "lib/tests/cost/rates";
import { NOT_PROBED, type PreparedHours } from "lib/tests/cost/runnerHours";
import { deltaLabel, type TrendPer } from "lib/tests/cost/trend";
import { useMemo, useState } from "react";

export interface ChangesMachinesProps {
  changes: CostChanges;
  // The rates file when the panel shows $, null in runner-hours.
  rates: RatesFile | null;
  per: TrendPer;
  // The cost answer, for each runner label's machine and each machine's
  // hue, as the page's machine keys paint them; without it, labels only.
  prepared?: PreparedHours;
  // The labels A and B stand for, for the column titles.
  aLabel: string;
  bLabel: string;
}

interface Line {
  key: string;
  label: string;
  row: ChangeRow;
  kind: "all" | "machine" | "group" | "member" | "runner" | "more" | "less";
  fill: string;
  // The runners or machines it lists while open.
  children: Line[];
}

// What changed by machine, laid out as the page's machine keys are
// (machineLines): every machine first, then a row per colored machine, the
// other machines together and Unknown machine, the rows past the largest
// few folded into "N more machines" until listed, each with B's bar and a
// tick where A stood, its share of B, A and B per day (or per commit), the
// change, ▲ in the error color or ▼ in the success color, and the change in
// %. A click on a machine lists its runner labels, each with its own
// change.
export default function ChangesMachines({
  changes,
  rates,
  per,
  prepared,
  aLabel,
  bLabel,
}: ChangesMachinesProps) {
  const theme = useTheme();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const unit = rates === null ? "hours" : "cost";
  const amount = (v: number) => fineAmountLabel(unit, v);
  const up = theme.palette.error.main;
  const down =
    theme.palette.mode === "dark"
      ? theme.palette.success.light
      : theme.palette.success.dark;
  const machineOf = useMemo(
    () =>
      prepared === undefined
        ? new Map<string, string>()
        : labelMachines(prepared),
    [prepared]
  );
  const machines = machineChanges(changes, rates, per, machineOf);
  const grey = otherMachinesColor(theme);
  const fillOf = (machine: string) => {
    if (prepared === undefined) return grey;
    const m = prepared.machines.indexOf(machine);
    if (m < 0) return grey;
    if (machine === NOT_PROBED) {
      return paintFill(theme, prepared, { kind: "not_probed" });
    }
    return prepared.colored.includes(m)
      ? paintFill(theme, prepared, { kind: "machine", machine: m })
      : grey;
  };
  const colored = (machine: string) =>
    prepared === undefined ||
    machine === NOT_PROBED ||
    prepared.colored.includes(prepared.machines.indexOf(machine));
  const lines: Line[] = machineLines(machines, colored, expanded).map((l) => {
    if (l.kind === "machine") {
      const fill = fillOf(l.key);
      return {
        ...l,
        fill,
        children: l.machines[0].runners.map((r) => ({
          key: `${l.key}|${r.key}`,
          label: r.name,
          row: r,
          kind: "runner" as const,
          fill,
          children: [],
        })),
      };
    }
    return {
      ...l,
      fill: grey,
      children:
        l.kind === "group"
          ? l.machines.map((m) => ({
              key: m.machine,
              label: m.machine,
              row: m.row,
              kind: "member" as const,
              fill: grey,
              children: [],
            }))
          : [],
    };
  });
  const all = lines[0].row;
  const shown: Line[] = lines.flatMap((l) => [
    l,
    ...(open.has(l.key) ? l.children : []),
  ]);
  const max = Math.max(
    1e-9,
    ...shown
      .filter((l) => l.kind !== "all" && l.kind !== "more")
      .flatMap((l) => [l.row.aPer, l.row.bPer])
  );
  const color = (delta: number) =>
    delta === 0 ? "text.secondary" : delta > 0 ? up : down;
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const columns =
    "18px minmax(180px, 2.4fr) minmax(96px, 1.6fr) minmax(64px, 0.6fr) minmax(72px, 0.7fr) minmax(72px, 0.7fr) minmax(88px, 0.8fr) minmax(64px, 0.6fr)";
  const cell = {
    px: 1,
    py: 0.5,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  } as const;
  const head = { ...cell, color: "text.secondary", fontWeight: 500 };
  const rowSx = {
    display: "grid",
    gridTemplateColumns: columns,
    width: "100%",
    alignItems: "center",
    font: "inherit",
    textAlign: "inherit",
    borderBottom: `1px solid ${theme.palette.divider}`,
  } as const;

  return (
    <Box role="table" sx={{ typography: "body2" }}>
      <Box role="row" sx={rowSx}>
        <Box role="columnheader" sx={head} />
        <Box role="columnheader" sx={{ ...head, textAlign: "left" }}>
          Machine
        </Box>
        <Box
          role="columnheader"
          sx={head}
          aria-label="B, with a tick at A"
          title="Bars show B; ticks mark A"
        />
        <Box role="columnheader" sx={head}>
          Share of B
        </Box>
        <Box role="columnheader" sx={head} title={`A: ${aLabel}`}>
          A / {per}
        </Box>
        <Box role="columnheader" sx={head} title={`B: ${bLabel}`}>
          B / {per}
        </Box>
        <Box role="columnheader" sx={head}>
          Change
        </Box>
        <Box role="columnheader" sx={head}>
          %
        </Box>
      </Box>
      {shown.map((line) => {
        const nested = line.kind === "member" || line.kind === "runner";
        const folding = line.kind === "more" || line.kind === "less";
        const expandable = line.children.length > 0;
        const isOpen = open.has(line.key);
        const { row } = line;
        if (line.kind === "less") {
          return (
            <ButtonBase
              key="less"
              component="div"
              role="row"
              aria-expanded
              title="Fold the smaller machines back into one row"
              onClick={() => setExpanded(false)}
              sx={{
                ...rowSx,
                color: "text.secondary",
                "&:hover": { backgroundColor: "action.hover" },
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                },
              }}
            >
              <Box role="cell" />
              <Box
                role="cell"
                sx={{ ...cell, textAlign: "left", gridColumn: "2 / -1" }}
              >
                Show fewer ▴
              </Box>
            </ButtonBase>
          );
        }
        // Hours on runners the rates file has no rate for: no $ to show.
        const unpriced =
          unit === "cost" &&
          row.a.value === 0 &&
          row.b.value === 0 &&
          row.a.unpriced + row.b.unpriced > 0;
        const title = `${line.label}: ${
          unpriced
            ? "no rate in the rates file"
            : `${amount(row.aPer)} a ${per} in A, ${amount(row.bPer)} in B`
        }${
          line.kind === "more"
            ? ". Click to list them"
            : expandable
            ? `. Click to ${isOpen ? "fold" : "list"} its ${
                line.kind === "group" ? "machines" : "runners"
              }`
            : ""
        }`;
        const content = (
          <>
            <Box
              role="cell"
              aria-hidden
              sx={{ color: "primary.main", textAlign: "center" }}
            >
              {expandable ? (isOpen ? "▾" : "▸") : folding ? "▸" : ""}
            </Box>
            <Box
              role="cell"
              sx={{
                ...cell,
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                pl: nested ? 3.5 : 1,
                color: nested || folding ? "text.secondary" : "text.primary",
                fontWeight: line.kind === "all" ? 600 : 400,
                fontFamily: line.kind === "runner" ? "monospace" : undefined,
                fontSize: line.kind === "runner" ? "0.75rem" : undefined,
              }}
            >
              {!nested && line.kind !== "all" && !folding && (
                <Box
                  component="span"
                  sx={{
                    flex: "0 0 auto",
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: line.fill,
                  }}
                />
              )}
              <Box
                component="span"
                sx={{ overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {line.label}
              </Box>
            </Box>
            <Box role="cell" aria-hidden sx={{ px: 1 }}>
              {line.kind !== "all" && line.kind !== "more" && (
                <Box sx={{ position: "relative", height: 12 }}>
                  <Box
                    sx={{
                      position: "absolute",
                      top: 2,
                      bottom: 2,
                      left: 0,
                      width: `${(100 * row.bPer) / max}%`,
                      background: line.fill,
                      borderRadius: "2px",
                    }}
                  />
                  {row.aPer > 0 && (
                    <Box
                      sx={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `calc(${(100 * row.aPer) / max}% - 1px)`,
                        width: "2px",
                        backgroundColor: "text.primary",
                      }}
                    />
                  )}
                </Box>
              )}
            </Box>
            <Box role="cell" sx={{ ...cell, color: "text.secondary" }}>
              {unpriced
                ? "—"
                : shareLabel(all.bPer > 0 ? row.bPer / all.bPer : 0)}
            </Box>
            <Box role="cell" sx={cell}>
              {unpriced ? "—" : amount(row.aPer)}
            </Box>
            <Box role="cell" sx={{ ...cell, fontWeight: nested ? 400 : 500 }}>
              {unpriced ? "—" : amount(row.bPer)}
            </Box>
            <Box role="cell" sx={{ ...cell, color: color(row.delta) }}>
              {unpriced || row.delta === 0
                ? "—"
                : deltaLabel(row.delta, amount)}
            </Box>
            <Box
              role="cell"
              sx={{
                ...cell,
                color: unpriced ? "text.secondary" : color(row.delta),
              }}
            >
              {unpriced ? "unpriced" : changeWord(row)}
            </Box>
          </>
        );
        return expandable || folding ? (
          <ButtonBase
            key={`${line.kind}:${line.key}`}
            component="div"
            role="row"
            aria-expanded={folding ? false : isOpen}
            title={title}
            onClick={() => (folding ? setExpanded(true) : toggle(line.key))}
            sx={{
              ...rowSx,
              "&:hover": { backgroundColor: "action.hover" },
              "&.Mui-focusVisible": {
                outline: `2px solid ${theme.palette.primary.main}`,
              },
            }}
          >
            {content}
          </ButtonBase>
        ) : (
          <Box
            key={`${line.kind}:${line.key}`}
            role="row"
            title={title}
            sx={rowSx}
          >
            {content}
          </Box>
        );
      })}
    </Box>
  );
}
