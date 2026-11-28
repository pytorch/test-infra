import { Box, ButtonBase, Typography, useTheme } from "@mui/material";
import TextButton from "components/tests/TextButton";
import { costUnit, type Pill } from "lib/api/tests/cost/contracts";
import { barFill, runnerFill } from "lib/tests/cost/colors";
import {
  machineKeyRows,
  type MachineRunners,
  noRateRunners,
  type OwnerBarsModel,
  partlyUnpriced,
  rateText,
  runnerBreakdown,
  type RunnerFigures,
  sumFigures,
} from "lib/tests/cost/ownerBars";
import { amountLabel, hoursLabel, shareLabel } from "lib/tests/cost/query";
import { joinNames, ownerLabel } from "lib/tests/cost/runnerHours";
import { HEADER_TITLE_STYLE } from "lib/tests/layout";
import { useState } from "react";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const NONE: RunnerFigures = {
  hours: 0,
  unpriced: 0,
  value: 0,
  rate: null,
  approx: false,
};

export interface MachineKeyProps {
  model: OwnerBarsModel;
  onTogglePill: (_pill: Pill) => void;
}

// The owner bars' legend, machine picker and machine shares in one: a row
// per colored machine, the other machines together (listed while open) and
// Unknown machine, each with its share of B. A click drills into the
// machine below (its m: pill); with an owner pinned, the solid part of each
// bar and the figure are that owner's hours on the machine. Each machine's
// ▸ lists its runners (the labels a rates file prices) in shades of its
// paint, in a fixed order (the most runner-hours first); they add up to the
// machine. In $ each has its $/h over B, and a note names the runners with
// no rate on any priced day.
export default function MachineKey({ model, onTogglePill }: MachineKeyProps) {
  const theme = useTheme();
  const { prepared, view, hours } = model;
  const dollars = model.unit === "usd";
  const amount = (v: number) => amountLabel(costUnit(model.unit), v);
  const hoursText = (v: number) => amountLabel("hours", v);
  const ran = (m: number) => hours.machineScope[m] > 0;
  // Folded until the reader says otherwise, or a machine among the others is
  // pinned: then it shows.
  const [openChoice, setOpen] = useState<boolean | null>(null);
  // Machines whose runners the reader opened or folded; the rest are open
  // while pinned.
  const [runnersOpen, setRunnersOpen] = useState<Record<string, boolean>>({});
  const open =
    openChoice ??
    machineKeyRows(prepared, view, false, ran).some(
      (r) => r.kind === "group" && r.machines.some((m) => view.machines.has(m))
    );
  const rows = machineKeyRows(prepared, view, open, ran);
  const max = Math.max(1e-9, ...rows.map((r) => r.hours));
  const pinnedOwners = Array.from(view.owners);
  const owners = pinnedOwners.length > 0;
  const machines = view.machines.size > 0;
  const pinned = prepared.machineOrder.find((m) => view.machines.has(m));
  // Every owner's runners, and those of the set the figures are of: the
  // pinned owners', or every owner's.
  const all = new Map(runnerBreakdown(model, null).map((b) => [b.machine, b]));
  const mine = owners
    ? new Map(runnerBreakdown(model, pinnedOwners).map((b) => [b.machine, b]))
    : all;
  // A group (Other machines) has a rate where any of its machines does.
  const figures = (ms: number[]): RunnerFigures =>
    ms.length === 1
      ? mine.get(ms[0]) ?? NONE
      : sumFigures(ms.map((m) => mine.get(m) ?? NONE));
  const whose = owners ? `${joinNames(pinnedOwners.map(ownerLabel))}'s ` : "";
  // The share column's whole: B's, or the pinned owners' while one is, so
  // every figure on a row is of one set (as the drill's machines of an owner).
  const whole = owners
    ? Array.from(mine.values()).reduce((s, b) => s + b.value, 0)
    : view.scopeTotal;
  const missing = dollars
    ? noRateRunners(model, owners ? pinnedOwners : null)
    : null;
  const columns = dollars
    ? "minmax(0, 1fr) 62px 32px 34px 56px"
    : "minmax(0, 1fr) 56px 36px 64px";
  const chevron = {
    height: 24,
    borderRadius: "4px",
    "&:hover": { backgroundColor: "action.hover" },
    "&.Mui-focusVisible": {
      outline: `2px solid ${theme.palette.primary.main}`,
    },
  };
  const numeric = {
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    color: "text.secondary",
    whiteSpace: "nowrap",
  } as const;
  // A bar: every owner's, pale behind the pinned owners' while one is.
  const bar = (allValue: number, value: number, fill: string, height = 8) => (
    <Box component="span" sx={{ position: "relative", height }}>
      <Box
        component="span"
        sx={{
          position: "absolute",
          inset: 0,
          width: `${(100 * allValue) / max}%`,
          minWidth: allValue > 0 ? "1px" : 0,
          background: fill,
          borderRadius: "2px",
          opacity: owners ? 0.28 : 1,
        }}
      />
      {owners && (
        <Box
          component="span"
          sx={{
            position: "absolute",
            inset: 0,
            width: `${(100 * value) / max}%`,
            background: fill,
            borderRadius: "2px",
          }}
        />
      )}
    </Box>
  );
  // A machine's or runner's $/h, share and figure; "no rate" and its hours
  // where none of them has one.
  const tail = (
    f: RunnerFigures,
    allValue: number,
    fill: string,
    rate: string,
    height?: number
  ) => {
    const none = dollars && f.hours > 0 && f.rate === null;
    return (
      <>
        {dollars && (
          <Box component="span" sx={{ ...numeric, fontSize: "0.75rem" }}>
            {none ? "" : rate}
          </Box>
        )}
        {none ? (
          <Box
            component="span"
            sx={{ ...numeric, gridColumn: "span 2", fontSize: "0.75rem" }}
          >
            no rate
          </Box>
        ) : (
          <>
            {bar(allValue, f.value, fill, height)}
            <Box component="span" sx={numeric}>
              {shareLabel((owners ? f.value : allValue) / (whole || 1))}
            </Box>
          </>
        )}
        <Box
          component="span"
          sx={{
            ...numeric,
            color: owners ? "text.primary" : "text.secondary",
            fontWeight: owners ? 500 : 400,
          }}
        >
          {none ? hoursText(f.hours) : amount(f.value)}
        </Box>
      </>
    );
  };
  // A tooltip's words for a machine or runner: hours, the unpriced ones, $.
  const detail = (name: string, f: RunnerFigures) =>
    `${name}: ${hoursText(f.hours)}${
      dollars
        ? f.rate === null
          ? f.hours > 0
            ? " · no rate"
            : ""
          : `${
              partlyUnpriced(f) ? `, ${hoursText(f.unpriced)} unpriced` : ""
            } · ${rateText(f)} · ${amount(f.value)}`
        : ""
    }${owners ? ` (${whose.trim()})` : ""}`;
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
          · share of {whose}
          {amount(whole)}
        </Typography>
        <Box sx={{ mr: "auto" }} />
        {machines && pinned !== undefined && (
          <TextButton
            label="Drop the machine"
            onClick={() =>
              onTogglePill({ dim: "m", value: prepared.machines[pinned] })
            }
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
        Bar colors. Click to drill in; ▸ lists runners
        {owners ? "; solid: the owner's share" : ""}.
      </Typography>
      {rows.map((row) => {
        const selected = row.machines.some((m) => view.machines.has(m));
        const fill = barFill(theme, prepared, row.paint);
        const group = row.kind === "group";
        const m = row.machines[0];
        const f = figures(row.machines);
        const runners: MachineRunners | undefined = group
          ? undefined
          : all.get(m);
        const shown =
          runners !== undefined && (runnersOpen[row.key] ?? selected);
        const dim = machines && !selected ? 0.45 : 1;
        const toggle = () =>
          group
            ? setOpen(!open)
            : onTogglePill({
                dim: "m",
                value: prepared.machines[m],
              });
        return (
          <Box key={`${row.kind}:${row.key}`}>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "18px minmax(0, 1fr)",
                alignItems: "center",
              }}
            >
              {group ? (
                <ButtonBase
                  aria-label={
                    open ? "Fold the other machines" : "List the other machines"
                  }
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                  sx={{ ...chevron, color: "primary.main" }}
                >
                  {open ? "▾" : "▸"}
                </ButtonBase>
              ) : runners !== undefined ? (
                <ButtonBase
                  aria-label={
                    shown
                      ? `Fold ${row.label}'s runners`
                      : `List ${row.label}'s runners`
                  }
                  aria-expanded={shown}
                  onClick={() =>
                    setRunnersOpen({ ...runnersOpen, [row.key]: !shown })
                  }
                  sx={{
                    ...chevron,
                    color: "text.secondary",
                    fontSize: "0.7rem",
                  }}
                >
                  {shown ? "▾" : "▸"}
                </ButtonBase>
              ) : (
                <span />
              )}
              <ButtonBase
                component="div"
                aria-pressed={group ? undefined : selected}
                aria-expanded={group ? open : undefined}
                onClick={toggle}
                title={`${detail(row.label, f)}${
                  owners ? ` · every owner's ${amount(row.hours)}` : ""
                }`}
                sx={{
                  display: "grid",
                  gridTemplateColumns: columns,
                  alignItems: "center",
                  columnGap: 1,
                  width: "100%",
                  minHeight: 24,
                  px: 0.5,
                  borderRadius: "4px",
                  textAlign: "left",
                  font: "inherit",
                  opacity: dim,
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
                    {selected && !group ? "✓ " : ""}
                    {row.label}
                  </Box>
                </Box>
                {tail(
                  f,
                  row.hours,
                  fill,
                  group || f.hours === 0 ? "" : rateText(f)
                )}
              </ButtonBase>
            </Box>
            {shown &&
              runners !== undefined &&
              // In the machine's fixed order, in shades of its paint.
              (model.runnerOrder[m] ?? []).map((label, position) => {
                const every =
                  runners.runners.find((r) => r.label === label) ?? NONE;
                const own = owners
                  ? mine.get(m)?.runners.find((r) => r.label === label) ?? NONE
                  : every;
                const shade = runnerFill(theme, prepared, row.paint, position);
                return (
                  <Box
                    key={label}
                    title={`${detail(label, own)} · ${shareLabel(
                      owners
                        ? own.value / (mine.get(m)?.value || 1)
                        : every.value / (runners.value || 1)
                    )} of ${row.label}'s`}
                    sx={{
                      display: "grid",
                      gridTemplateColumns: `18px ${columns}`,
                      alignItems: "center",
                      columnGap: 1,
                      minHeight: 20,
                      pr: 0.5,
                      typography: "caption",
                      color: "text.secondary",
                      opacity: dim,
                    }}
                  >
                    <span />
                    <Box
                      component="span"
                      sx={{
                        pl: 1.5,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontFamily: MONO,
                      }}
                    >
                      <Box
                        component="span"
                        sx={{
                          display: "inline-block",
                          width: 8,
                          height: 8,
                          mr: 0.75,
                          borderRadius: "2px",
                          background: shade,
                        }}
                      />
                      {label}
                    </Box>
                    {tail(
                      own,
                      every.value,
                      shade,
                      own.hours === 0 ? "" : rateText(own),
                      6
                    )}
                  </Box>
                );
              })}
          </Box>
        );
      })}
      {missing !== null && missing.runners.length > 0 && (
        <Typography
          variant="caption"
          component="p"
          sx={{
            color: "text.secondary",
            mt: 1,
            pt: 0.75,
            borderTop: `1px solid ${theme.palette.divider}`,
          }}
        >
          No rate: {hoursLabel(missing.hours)} h (
          {shareLabel(missing.hours / (missing.of || 1))} of {whose}
          runner-hours
          {model.divisors.pricedNote !== null ? " on priced days" : ""}) on{" "}
          {missing.runners.length}{" "}
          {missing.runners.length === 1 ? "runner" : "runners"}, largest{" "}
          {missing.runners
            .slice(0, 2)
            .map((r) => `${r.label} (${hoursLabel(r.hours)} h)`)
            .join(", ")}
          .
        </Typography>
      )}
    </Box>
  );
}
