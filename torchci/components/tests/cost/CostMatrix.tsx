import { Box, ButtonBase, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import CostFrame from "components/tests/cost/CostFrame";
import InfoTip from "components/tests/cost/InfoTip";
import KeyButton from "components/tests/cost/KeyButton";
import HeaderCheck from "components/tests/HeaderCheck";
import type { Cells } from "lib/api/tests/cost/page";
import { downloadCSV } from "lib/csvUtils";
import { heatColors, rampGradient } from "lib/tests/cost/colors";
import { hoursLabel, shareLabel } from "lib/tests/cost/query";
import {
  bucketInfo,
  cellShade,
  type CostView,
  matrixGroups,
  MIN_CELL_HOURS,
  type OwnerRow,
  ownerRows,
  type PreparedHours,
  rowMix,
  rowsCsv,
  scopeName,
} from "lib/tests/cost/runnerHours";
import { type ReactNode, useState } from "react";

// The cell a reader opened, by name: a row of the matrix and a machine. The
// page looks both up in the current matrix on every render and closes the
// drawer when either is gone, so it never shows a row that has changed.
export interface MatrixCell {
  rowKey: string;
  machine: string;
}

// What acts in a table cell: a button that fills it and reads as its text,
// so headers, row names and cells work from the keyboard as from the mouse.
function CellButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <ButtonBase
      component="span"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      sx={{
        display: "block",
        width: "100%",
        font: "inherit",
        color: "inherit",
        textAlign: "inherit",
        overflow: "hidden",
        textOverflow: "ellipsis",
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 1,
        },
      }}
    >
      {children}
    </ButtonBase>
  );
}

const CELL_LABELS: Record<Cells, { label: string; title: string }> = {
  machine: {
    label: "% of machine",
    title: "Owner's share of the machine; columns sum to 100%",
  },
  owner: {
    label: "% of owner",
    title: "Machine's share of the owner; rows sum to 100%",
  },
  hours: {
    label: "hours",
    title: "Runner-hours, square-root shading",
  },
};

export interface CostMatrixProps {
  prepared: PreparedHours;
  view: CostView;
  cells: Cells;
  only: boolean;
  loading: boolean;
  // The days the answer covers, in words.
  dates: string;
  // The CSV's file name.
  fileName: string;
  cell: MatrixCell | null;
  // "N more owners" listed, which the page also reads to find the cell.
  expanded: boolean;
  onExpandedChange: (_expanded: boolean) => void;
  onCellsChange: (_cells: Cells) => void;
  onOnlyChange: (_only: boolean) => void;
  onToggleOwners: (_owners: string[]) => void;
  onToggleMachines: (_machines: string[]) => void;
  onCellChange: (_cell: MatrixCell | null) => void;
}

// Every owner on every machine in the scope, for the reader who audits:
// rows as the owner chart's (top owners, highlighted ones, "N more", then
// each bucket), columns grouped by machine family, a total column and row
// in hours. Cells are shaded by their share of the machine (default), of
// the owner, or by hours. Highlights underline headers and dim the rest;
// "Only selected" hides what is not highlighted, every number unchanged. A
// cell opens its detail in the drawer. The card starts open.
export default function CostMatrix({
  prepared,
  view,
  cells,
  only,
  loading,
  dates,
  fileName,
  cell,
  expanded,
  onExpandedChange,
  onCellsChange,
  onOnlyChange,
  onToggleOwners,
  onToggleMachines,
  onCellChange,
}: CostMatrixProps) {
  const theme = useTheme();
  // Open from the start: it names every machine, which the chart's seven
  // hues cannot.
  const [open, setOpen] = useState(true);
  const [toast, setToast] = useState("");
  const rows = ownerRows(view, expanded, "each");
  const groups = matrixGroups(prepared, view);
  const highlighting = view.owners.size > 0 || view.machines.size > 0;
  const hiding = only && highlighting;
  const dimming = highlighting && !hiding;
  const rowOn = (row: OwnerRow) => row.owners.some((o) => view.owners.has(o));
  const visibleRows = hiding
    ? rows.filter(
        (r) => r.kind !== "less" && (view.owners.size === 0 || rowOn(r))
      )
    : rows;
  const visibleGroups =
    hiding && view.machines.size > 0
      ? groups
          .map((g) => ({
            ...g,
            machines: g.machines.filter((m) => view.machines.has(m)),
          }))
          .filter((g) => g.machines.length > 0)
      : groups;
  const mixes = new Map(
    rows.map((r) => [r.key, rowMix(prepared, view, r.owners)])
  );
  // The hours of each row whose machine is estimated from runner labels.
  const estimates = new Map(
    rows.map((r) => [r.key, rowMix(prepared, view, r.owners, true)])
  );
  const columns = groups.flatMap((g) => g.machines);
  const maxCell = Math.max(
    0,
    ...rows.flatMap((r) => columns.map((m) => mixes.get(r.key)?.[m] ?? 0))
  );
  const maxRow = Math.max(1, ...rows.map((r) => r.hours));
  const name = scopeName(prepared, view);
  const owners = rows.filter((r) => r.kind === "owner").length;
  const download = () => {
    const { csv, rows: count } = rowsCsv(prepared, view);
    downloadCSV(csv, fileName);
    setToast(`${count} rows downloaded`);
  };
  const cellSx = {
    px: 0.5,
    py: 0.5,
    textAlign: "center" as const,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap" as const,
    minWidth: 44,
  };
  const head = (m: number) => {
    const on = view.machines.has(m);
    return (
      <Box
        component="th"
        key={m}
        title={`${prepared.machines[m]}: click to highlight`}
        sx={{
          ...cellSx,
          fontWeight: on ? 600 : 400,
          textDecoration: on ? "underline" : "none",
          textUnderlineOffset: 3,
          color: dimming && !on ? "text.disabled" : "text.primary",
          verticalAlign: "bottom",
          whiteSpace: "normal",
          lineHeight: 1.2,
          maxWidth: 84,
        }}
      >
        <CellButton
          label={`Highlight ${prepared.machines[m]}`}
          pressed={on}
          onClick={() => onToggleMachines([prepared.machines[m]])}
        >
          {prepared.short[m]}
        </CellButton>
      </Box>
    );
  };
  const gap = (key: string) => (
    <Box component="td" key={key} sx={{ width: 8, p: 0 }} />
  );

  return (
    <CostFrame
      title="All owner–machine pairs"
      description="Each owner's hours on each machine. Click a header to highlight, a cell for details."
      note={`· ${hoursLabel(
        view.scopeTotal
      )} runner-hours in ${name}, ${owners} owners × ${
        columns.length
      } machines · ${dates}`}
      open={open}
      onOpenChange={setOpen}
      loading={loading}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 1,
          mb: 1.5,
          typography: "body2",
        }}
      >
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Cells show
        </Typography>
        {(Object.keys(CELL_LABELS) as Cells[]).map((mode) => (
          <KeyButton
            key={mode}
            title={CELL_LABELS[mode].title}
            active={cells === mode}
            onClick={() => onCellsChange(mode)}
          >
            {CELL_LABELS[mode].label}
          </KeyButton>
        ))}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            mx: 1,
            color: "text.secondary",
            typography: "caption",
          }}
        >
          <span>{cells === "hours" ? "0" : "0%"}</span>
          <Box
            sx={{
              width: 96,
              height: 10,
              borderRadius: "2px",
              background: rampGradient(theme),
            }}
          />
          <span>
            {cells === "hours"
              ? `${hoursLabel(maxCell)} h (square-root scale)`
              : "100%"}
          </span>
        </Box>
        <HeaderCheck
          label="Only selected"
          title={
            highlighting
              ? "Hide what isn't highlighted; numbers stay the same"
              : "Highlight owners or machines first"
          }
          checked={only}
          disabled={!highlighting}
          onChange={onOnlyChange}
        />
        <Box sx={{ mr: "auto" }} />
        <KeyButton title="Rows in the scope and highlight" onClick={download}>
          Download CSV
        </KeyButton>
      </Box>
      {toast !== "" && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "text.secondary", mb: 1, overflowWrap: "anywhere" }}
        >
          {toast}
        </Typography>
      )}
      <Box sx={{ overflowX: "auto", opacity: loading ? 0.6 : 1 }}>
        <Box
          component="table"
          sx={{
            // On the card, not on the global tables' dropdown fill.
            backgroundColor: "transparent",
            borderCollapse: "separate",
            borderSpacing: "2px",
            typography: "caption",
            "& td, & th": { borderRadius: "2px" },
          }}
        >
          <thead>
            <tr>
              <th />
              {visibleGroups.map((g, gi) => [
                gi > 0 ? gap(`fg${gi}`) : null,
                <Box
                  component="th"
                  key={g.family}
                  colSpan={g.machines.length}
                  sx={{
                    color: "text.secondary",
                    fontWeight: 500,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    fontSize: "0.7rem",
                    borderBottom: `1px solid ${theme.palette.divider}`,
                    pb: 0.25,
                  }}
                >
                  {g.family}
                </Box>,
              ])}
              <th />
            </tr>
            <tr>
              <th />
              {visibleGroups.map((g, gi) => [
                gi > 0 ? gap(`hg${gi}`) : null,
                ...g.machines.map(head),
              ])}
              <Box
                component="th"
                sx={{
                  textAlign: "left",
                  pl: 1.5,
                  verticalAlign: "bottom",
                  fontWeight: 400,
                  color: "text.secondary",
                }}
              >
                Runner-hours
              </Box>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => {
              const firstBucket =
                row.kind === "bucket" && visibleRows[i - 1]?.kind !== "bucket";
              const on = rowOn(row);
              if (row.kind === "less") {
                return (
                  <tr key={row.key}>
                    <Box
                      component="td"
                      sx={{
                        textAlign: "right",
                        pr: 1,
                        color: "text.secondary",
                      }}
                    >
                      <CellButton
                        label="Fold the smaller owners back into one row"
                        onClick={() => onExpandedChange(false)}
                      >
                        Show fewer ▴
                      </CellButton>
                    </Box>
                  </tr>
                );
              }
              const mix = mixes.get(row.key) ?? new Float64Array(0);
              return (
                <Box
                  component="tr"
                  key={row.key}
                  sx={
                    firstBucket
                      ? {
                          "& > td": {
                            borderTop: `1px solid ${theme.palette.divider}`,
                          },
                        }
                      : undefined
                  }
                >
                  <Box
                    component="td"
                    title={row.kind === "bucket" ? undefined : row.label}
                    sx={{
                      textAlign: "right",
                      pr: 1,
                      maxWidth: 200,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color:
                        row.kind === "owner"
                          ? "primary.main"
                          : "text.secondary",
                      fontWeight: on ? 600 : 400,
                      textDecoration: on ? "underline" : "none",
                      textUnderlineOffset: 3,
                      "&:hover": { textDecoration: "underline" },
                    }}
                  >
                    <Box sx={{ display: "flex", alignItems: "center" }}>
                      <CellButton
                        label={
                          row.kind === "more"
                            ? `List the ${row.owners.length} smaller owners`
                            : `Highlight ${row.label}`
                        }
                        pressed={row.kind === "more" ? undefined : on}
                        onClick={() =>
                          row.kind === "more"
                            ? onExpandedChange(true)
                            : onToggleOwners(row.owners)
                        }
                      >
                        {row.label}
                        {row.kind === "more" ? " ▸" : ""}
                      </CellButton>
                      {row.kind === "bucket" && bucketInfo(row.key) !== "" && (
                        <InfoTip title={bucketInfo(row.key)} />
                      )}
                    </Box>
                  </Box>
                  {visibleGroups.map((g, gi) => [
                    gi > 0 ? gap(`g${gi}`) : null,
                    ...g.machines.map((m) => {
                      const hours = mix[m] ?? 0;
                      const dim = dimming && !(on || view.machines.has(m));
                      const current =
                        cell !== null &&
                        cell.rowKey === row.key &&
                        cell.machine === prepared.machines[m];
                      if (hours < MIN_CELL_HOURS) {
                        return (
                          <Box
                            component="td"
                            key={m}
                            sx={{ ...cellSx, opacity: dim ? 0.3 : 1 }}
                          />
                        );
                      }
                      const share = cellShade(
                        cells,
                        hours,
                        row.hours,
                        view.machineScope[m],
                        maxCell
                      );
                      const colors = heatColors(theme, share);
                      const estimated = estimates.get(row.key)?.[m] ?? 0;
                      // Mostly estimated: striped in the cell's own text
                      // color, which contrasts with its shade in either mode.
                      const guessed = estimated >= hours / 2;
                      const unknown = m === prepared.notProbed;
                      return (
                        <Box
                          component="td"
                          key={m}
                          sx={{
                            ...cellSx,
                            backgroundColor: colors.background,
                            backgroundImage:
                              guessed || unknown
                                ? `repeating-linear-gradient(135deg, ${alpha(
                                    colors.color,
                                    0.22
                                  )} 0 2px, transparent 2px 5px)`
                                : undefined,
                            color: colors.color,
                            opacity: dim ? 0.3 : 1,
                            outline: current
                              ? `2px solid ${theme.palette.text.primary}`
                              : undefined,
                            outlineOffset: -1,
                          }}
                        >
                          <Tooltip
                            title={`${row.label} · ${
                              prepared.machines[m]
                            }\n${hoursLabel(hours)} h${
                              guessed
                                ? " (estimated)"
                                : unknown
                                ? " (machine unknown)"
                                : ""
                            }\nClick for details`}
                            enterDelay={200}
                            slotProps={{
                              tooltip: { sx: { whiteSpace: "pre-line" } },
                            }}
                          >
                            <span>
                              <CellButton
                                label={`${row.label} on ${
                                  prepared.machines[m]
                                }: ${hoursLabel(hours)} runner-hours${
                                  guessed
                                    ? ", estimated"
                                    : unknown
                                    ? ", machine unknown"
                                    : ""
                                }; open the details`}
                                pressed={current}
                                onClick={() =>
                                  onCellChange(
                                    current
                                      ? null
                                      : {
                                          rowKey: row.key,
                                          machine: prepared.machines[m],
                                        }
                                  )
                                }
                              >
                                {cells === "hours"
                                  ? hoursLabel(hours)
                                  : shareLabel(
                                      cells === "machine"
                                        ? hours / (view.machineScope[m] || 1)
                                        : hours / (row.hours || 1)
                                    )}
                              </CellButton>
                            </span>
                          </Tooltip>
                        </Box>
                      );
                    }),
                  ])}
                  <Box
                    component="td"
                    sx={{ pl: 1.5, opacity: dimming && !on ? 0.4 : 1 }}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.75,
                        whiteSpace: "nowrap",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      <Box
                        sx={{
                          // A string: sx reads a number up to 1 as a
                          // fraction of the parent, so 1 would fill it.
                          width: `${Math.max(1, (90 * row.hours) / maxRow)}px`,
                          height: 8,
                          borderRadius: "2px",
                          backgroundColor: theme.palette.primary.main,
                          opacity: 0.7,
                        }}
                      />
                      <span>{hoursLabel(row.hours)} h</span>
                      <Box component="span" sx={{ color: "text.secondary" }}>
                        {shareLabel(row.hours / (view.scopeTotal || 1))}
                      </Box>
                    </Box>
                  </Box>
                </Box>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <Box
                component="td"
                sx={{
                  textAlign: "right",
                  pr: 1,
                  color: "text.secondary",
                  pt: 1,
                }}
              >
                Machine runner-hours
              </Box>
              {visibleGroups.map((g, gi) => [
                gi > 0 ? gap(`t${gi}`) : null,
                ...g.machines.map((m) => (
                  <Box
                    component="td"
                    key={m}
                    sx={{
                      ...cellSx,
                      pt: 1,
                      color:
                        dimming && !view.machines.has(m)
                          ? "text.disabled"
                          : "text.primary",
                    }}
                  >
                    {hoursLabel(view.machineScope[m])} h
                    <br />
                    <Box component="span" sx={{ color: "text.secondary" }}>
                      {shareLabel(
                        view.machineScope[m] / (view.scopeTotal || 1)
                      )}
                    </Box>
                  </Box>
                )),
              ])}
              <Box
                component="td"
                sx={{
                  pl: 1.5,
                  pt: 1,
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {hoursLabel(view.scopeTotal)} h
              </Box>
            </tr>
          </tfoot>
        </Box>
      </Box>
    </CostFrame>
  );
}
