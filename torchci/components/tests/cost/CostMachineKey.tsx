import { Box, ButtonBase, Typography, useTheme } from "@mui/material";
import RateCell from "components/tests/cost/RateCell";
import TextButton from "components/tests/TextButton";
import { paintFill, runnerFill } from "lib/tests/cost/colors";
import {
  amountLabel,
  hoursLabel,
  rateLabel,
  shareLabel,
} from "lib/tests/cost/query";
import { priceKey } from "lib/tests/cost/rates";
import {
  type CostView,
  joinNames,
  machineKeyRows,
  ownerLabel,
  type PreparedHours,
  runnerBreakdown,
  scopeName,
} from "lib/tests/cost/runnerHours";
import { HEADER_TITLE_STYLE } from "lib/tests/layout";
import { useState } from "react";

export interface CostMachineKeyProps {
  // The answer in $ (pricedRunnerHours).
  prepared: PreparedHours;
  view: CostView;
  onToggleMachines: (_machines: string[]) => void;
  onClearMachines: () => void;
  // Given, each runner's $/h is editable in place (RateCell); the file's
  // rates, to mark the edited ones.
  onRateChange?: (_key: string, _rate: number | null) => void;
  originalRates?: Readonly<Record<string, number>>;
}

const COLUMNS = "minmax(0, 1fr) 54px 32px 32px 56px";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// The owner chart's machine key in $: legend, machine picker and shares
// as MachineKey's in runner-hours, each machine with its average $/h and a ▸
// listing its runners (the labels a rates file prices) with their rates, in
// shades of its color in a fixed order (machineRunners). Every figure is of
// one set, every owner or, with owners highlighted, theirs: a row's $/h,
// share and $ alike, the pale bar behind still every owner's, so a
// machine's runners add up to it. A highlighted machine lists its runners,
// and the others dim with theirs. A note names the runners the file misses.
export default function CostMachineKey({
  prepared,
  view,
  onToggleMachines,
  onClearMachines,
  onRateChange,
  originalRates,
}: CostMachineKeyProps) {
  const theme = useTheme();
  // Folded until the reader says otherwise, or a machine among the others is
  // highlighted: then it shows.
  const [openChoice, setOpen] = useState<boolean | null>(null);
  const open =
    openChoice ??
    machineKeyRows(prepared, view, false).some(
      (r) => r.kind === "group" && r.machines.some((m) => view.machines.has(m))
    );
  // Machines whose runners the reader opened or folded; the rest are open
  // while highlighted.
  const [runnersOpen, setRunnersOpen] = useState<Record<string, boolean>>({});
  const rows = machineKeyRows(prepared, view, open);
  const owners = Array.from(view.owners);
  const highlighting = owners.length > 0;
  const machines = view.machines.size > 0;
  const amount = (value: number) => amountLabel("cost", value);
  const all = new Map(
    runnerBreakdown(prepared, view, null).map((b) => [b.machine, b])
  );
  // The set the figures are of, and its $.
  const mine = highlighting
    ? new Map(
        runnerBreakdown(prepared, view, owners).map((b) => [b.machine, b])
      )
    : all;
  const total = highlighting
    ? owners.reduce((a, o) => a + (view.ownerScope.get(o) ?? 0), 0)
    : view.scopeTotal;
  const whose = highlighting ? `${joinNames(owners.map(ownerLabel))}'s` : "";
  const max = Math.max(1e-9, ...rows.map((r) => r.hours));
  const sum = (ms: number[], k: "value" | "hours" | "unpriced") =>
    ms.reduce((a, m) => a + (mine.get(m)?.[k] ?? 0), 0);
  const missing = new Map<string, number>();
  for (const b of mine.values()) {
    for (const r of b.runners) {
      if (r.rate === null) {
        missing.set(r.label, (missing.get(r.label) ?? 0) + r.hours);
      }
    }
  }
  const largestMissing = Array.from(missing).sort((a, b) => b[1] - a[1]);
  const mineHours = sum(Array.from(mine.keys()), "hours");
  const mineUnpriced = sum(Array.from(mine.keys()), "unpriced");
  const chevron = {
    height: 24,
    borderRadius: "4px",
    color: "primary.main",
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
  // A bar: every owner's pale behind, the highlighted owners' solid.
  const bar = (
    allValue: number,
    value: number,
    fill: string,
    height: number
  ) => (
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
          opacity: highlighting ? 0.28 : 1,
        }}
      />
      {highlighting && (
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
          · share of {highlighting ? `${whose} ` : ""}
          {amount(total)}
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
        Bar colors. Click to highlight; ▸ lists runners
        {onRateChange !== undefined ? ", whose $/h you can edit." : "."}
        {highlighting ? ` Figures are ${whose}; pale bars, every owner's.` : ""}
      </Typography>
      {rows.map((row) => {
        const selected = row.machines.some((m) => view.machines.has(m));
        const dim = machines && !selected ? 0.45 : 1;
        const fill = paintFill(theme, prepared, row.paint);
        const names = row.machines.map((m) => prepared.machines[m]);
        const m = row.machines[0];
        const runners = row.kind === "group" ? undefined : all.get(m)?.runners;
        const value = sum(row.machines, "value");
        const hours = sum(row.machines, "hours");
        const unpriced = sum(row.machines, "unpriced");
        const noRate = hours > 0 && unpriced >= hours - 1e-9;
        const rate = hours > unpriced ? value / (hours - unpriced) : null;
        const priced = (mine.get(m)?.runners ?? []).filter(
          (r) => r.rate !== null && r.hours > 0
        );
        const mixed = new Set(priced.map((r) => r.rate)).size > 1;
        const shown =
          runners !== undefined && (runnersOpen[row.key] ?? selected);
        return (
          <Box key={`${row.kind}:${row.key}`}>
            <Box
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
                  sx={chevron}
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
                aria-pressed={selected}
                // Pressed, a click takes off what is highlighted; a group
                // with one machine highlighted never adds its others.
                onClick={() =>
                  onToggleMachines(
                    selected
                      ? names.filter((_, i) =>
                          view.machines.has(row.machines[i])
                        )
                      : names
                  )
                }
                title={`${row.label}: ${amount(value)} · ${hoursLabel(
                  hours
                )} h${
                  unpriced > 0.5 && !noRate
                    ? `, ${hoursLabel(unpriced)} h with no rate`
                    : ""
                }${
                  highlighting
                    ? ` (${whose}; every owner's ${amount(row.hours)})`
                    : ""
                }`}
                sx={{
                  display: "grid",
                  gridTemplateColumns: COLUMNS,
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
                      row.kind === "member" || noRate
                        ? "text.secondary"
                        : "text.primary",
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
                <Box component="span" sx={{ ...numeric, fontSize: "0.75rem" }}>
                  {row.kind === "group" || row.paint.kind === "not_probed"
                    ? ""
                    : rate === null
                    ? "—"
                    : `${mixed ? "~" : ""}${rateLabel(rate)}`}
                </Box>
                {noRate ? (
                  <Box
                    component="span"
                    sx={{
                      ...numeric,
                      gridColumn: "span 2",
                      fontSize: "0.75rem",
                    }}
                  >
                    no rate
                  </Box>
                ) : (
                  <>
                    {bar(row.hours, value, fill, 8)}
                    <Box component="span" sx={numeric}>
                      {shareLabel(value / (total || 1))}
                    </Box>
                  </>
                )}
                <Box
                  component="span"
                  sx={{
                    ...numeric,
                    color: highlighting ? "text.primary" : "text.secondary",
                    fontWeight: highlighting ? 500 : 400,
                  }}
                >
                  {noRate ? `${hoursLabel(hours)} h` : amount(value)}
                </Box>
              </ButtonBase>
            </Box>
            {shown &&
              runners !== undefined &&
              // In the machine's fixed order, in shades of its color.
              [...runners]
                .sort(
                  (a, b) =>
                    prepared.machineRunners[m].indexOf(a.label) -
                    prepared.machineRunners[m].indexOf(b.label)
                )
                .map((r) => {
                  const own = mine
                    .get(m)
                    ?.runners.find((x) => x.label === r.label) ?? {
                    value: 0,
                    hours: 0,
                  };
                  const noRunnerRate = r.rate === null;
                  const key =
                    onRateChange === undefined ? null : priceKey(r.label);
                  const was =
                    key === null ? null : originalRates?.[key] ?? null;
                  const shade = runnerFill(
                    theme,
                    prepared,
                    row.paint,
                    prepared.machineRunners[m].indexOf(r.label)
                  );
                  return (
                    <Box
                      key={r.label}
                      title={`${r.label}: ${hoursLabel(own.hours)} h${
                        noRunnerRate
                          ? " · no rate"
                          : ` × ${rateLabel(r.rate ?? 0)} = ${amount(
                              own.value
                            )}`
                      } · ${shareLabel(own.hours / (hours || 1))} of ${
                        row.label
                      }'s runner-hours${highlighting ? ` (${whose})` : ""}`}
                      sx={{
                        display: "grid",
                        gridTemplateColumns: `18px ${COLUMNS}`,
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
                        {r.label}
                      </Box>
                      <Box component="span" sx={numeric}>
                        {key !== null && onRateChange !== undefined ? (
                          <RateCell
                            runner={key}
                            rate={r.rate}
                            was={was}
                            edited={r.rate !== was}
                            onChange={(rate) => onRateChange(key, rate)}
                          />
                        ) : noRunnerRate ? (
                          "—"
                        ) : (
                          rateLabel(r.rate ?? 0)
                        )}
                      </Box>
                      {noRunnerRate ? (
                        <Box
                          component="span"
                          sx={{ ...numeric, gridColumn: "span 2" }}
                        >
                          no rate
                        </Box>
                      ) : (
                        <>
                          {bar(r.value, own.value, shade, 6)}
                          <Box component="span" sx={numeric}>
                            {shareLabel(own.value / (total || 1))}
                          </Box>
                        </>
                      )}
                      <Box
                        component="span"
                        sx={{
                          ...numeric,
                          color: highlighting
                            ? "text.primary"
                            : "text.secondary",
                        }}
                      >
                        {noRunnerRate
                          ? amountLabel("hours", own.hours)
                          : amount(own.value)}
                      </Box>
                    </Box>
                  );
                })}
          </Box>
        );
      })}
      {largestMissing.length > 0 && (
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
          No rate: {hoursLabel(mineUnpriced)} h (
          {shareLabel(mineUnpriced / (mineHours || 1))} of{" "}
          {whose ? `${whose} ` : ""}
          runner-hours) on {largestMissing.length}{" "}
          {largestMissing.length === 1 ? "runner" : "runners"}, largest{" "}
          {largestMissing
            .slice(0, 2)
            .map(([label, h]) => `${label} (${hoursLabel(h)} h)`)
            .join(", ")}
          . Set rates under ▸.
        </Typography>
      )}
    </Box>
  );
}
