import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import { Box, IconButton, Tooltip, Typography, useTheme } from "@mui/material";
import CostFrame from "components/tests/cost/CostFrame";
import CostMachineKey from "components/tests/cost/CostMachineKey";
import InfoTip from "components/tests/cost/InfoTip";
import KeyButton from "components/tests/cost/KeyButton";
import MachineKey from "components/tests/cost/MachineKey";
import HeaderCheck from "components/tests/HeaderCheck";
import TextButton from "components/tests/TextButton";
import TextLink from "components/tests/TextLink";
import type { WorkflowPreset } from "lib/api/tests/cost/types";
import { paintFill, paleColor } from "lib/tests/cost/colors";
import {
  amountLabel,
  hoursLabel,
  ownerTestsHref,
  rateLabel,
  shareLabel,
  UNIT_NAMES,
} from "lib/tests/cost/query";
import { averageRate, costMark } from "lib/tests/cost/rates";
import {
  bucketInfo,
  type CostView,
  highlightedHours,
  highlightName,
  isScope,
  type MachineRunners,
  type OwnerRow,
  ownerRows,
  type PreparedHours,
  rowMix,
  runnerBreakdown,
  scopeName,
  segments,
} from "lib/tests/cost/runnerHours";
import { niceTicks } from "lib/tests/cost/ticks";
import { type ReactElement, type ReactNode, useState } from "react";

const ROW_HEIGHT = 24;
const BAR_HEIGHT = 14;

const COST_METHOD =
  "Runner-hours (as in the chart above) × each runner's $/h from your rates. Runners without a rate count $0; set one under ▸ in the key.";
const DIMMED = 0.35;

export interface OwnerChartProps {
  repo: string;
  prepared: PreparedHours;
  view: CostView;
  presets: WorkflowPreset[];
  // The scope's workflows, as chosen.
  scope: readonly string[];
  split: boolean;
  loading: boolean;
  dates: string;
  method: string;
  onScopeChange: (_workflows: string[]) => void;
  onSplitChange: (_split: boolean) => void;
  onToggleOwners: (_owners: string[]) => void;
  onToggleMachines: (_machines: string[]) => void;
  onClearHighlight: () => void;
  onClearMachines: () => void;
  // In $, opens a row's machines and runners (RunnersDrawer), and the row
  // it has open.
  onOpenRunners?: (_row: OwnerRow) => void;
  runnersKey?: string | null;
  // In $: the runners' rates are editable in the key (RateCell), the file's
  // marking the edited ones.
  onRateChange?: (_key: string, _rate: number | null) => void;
  originalRates?: Readonly<Record<string, number>>;
  // In $: the frame folds, and a line under its band names the rates file.
  open?: boolean;
  onOpenChange?: (_open: boolean) => void;
  banner?: ReactNode;
}

// The scope keys on a card's band: every workflow, each preset, and the
// custom scope ticked in the workflows card, shown only while it is in force.
export function ScopeKeys({
  presets,
  scope,
  scopeLabel,
  onScopeChange,
  showCustom,
}: {
  presets: WorkflowPreset[];
  scope: readonly string[];
  scopeLabel: string;
  onScopeChange: (_workflows: string[]) => void;
  showCustom: boolean;
}) {
  const preset = presets.find((p) => isScope(scope, p.workflows));
  return (
    <Box sx={{ display: "flex", gap: 0.75 }}>
      <KeyButton
        title="Every workflow"
        active={scope.length === 0}
        onClick={() => onScopeChange([])}
      >
        All workflows
      </KeyButton>
      {presets.map((p) => (
        <KeyButton
          key={p.value}
          title={`${p.workflows.join(" + ")}: ${p.description}`}
          active={preset?.value === p.value}
          onClick={() => onScopeChange([...p.workflows])}
        >
          {p.label}
        </KeyButton>
      ))}
      {showCustom && scope.length > 0 && preset === undefined && (
        <KeyButton
          title="Workflows ticked below"
          active
          onClick={() => undefined}
        >
          Custom: {scopeLabel}
        </KeyButton>
      )}
    </Box>
  );
}

// A tooltip that follows the pointer, its lines kept.
function lineTip(title: string, child: ReactElement, key?: string) {
  return (
    <Tooltip
      key={key}
      title={title}
      followCursor
      enterDelay={150}
      slotProps={{
        tooltip: { sx: { whiteSpace: "pre-line", maxWidth: 420 } },
      }}
    >
      {child}
    </Tooltip>
  );
}

// A bar's pieces as the tooltip lists them: each machine once, its
// estimated hours (a piece of their own in the bar) folded into its line.
function machineLines(pieces: { label: string; hours: number }[]) {
  const lines = new Map<
    string,
    { label: string; hours: number; estimated: number }
  >();
  for (const p of pieces) {
    if (!(p.hours > 0)) continue;
    const label = p.label.replace(/ \(est\.\)$/, "");
    const line = lines.get(label) ?? { label, hours: 0, estimated: 0 };
    line.hours += p.hours;
    if (label !== p.label) line.estimated += p.hours;
    lines.set(label, line);
  }
  return Array.from(lines.values());
}

// The scope's runner-hours (or $, in the cost panel) by owner, largest
// first: the top owners, every highlighted one, the rest folded into "N more
// owners", then the unattributed hours, so the rows add up to the scope.
// Split by machine, each bar is its machines in a fixed order; highlighting
// machines moves their pieces to the start of every bar and paints the rest
// pale; highlighting owners dims the other rows. Only the scope and the unit
// move the bars. In $, each piece's tooltip names the runners it ran on, a
// mark on each bar is its share of the runner-hours that have a rate, and a
// row's › opens its machines and runners. The machine key to the right is
// the legend and the machine picker.
export default function OwnerChart({
  repo,
  prepared,
  view,
  presets,
  scope,
  split,
  loading,
  dates,
  method,
  onScopeChange,
  onSplitChange,
  onToggleOwners,
  onToggleMachines,
  onClearHighlight,
  onClearMachines,
  onOpenRunners,
  runnersKey = null,
  onRateChange,
  originalRates,
  open,
  onOpenChange,
  banner,
}: OwnerChartProps) {
  const theme = useTheme();
  const unit = prepared.unit;
  const dollars = unit === "cost";
  const amount = (value: number) => amountLabel(unit, value);
  // Runner names matter only where they are priced: the pieces' runner
  // tooltips and the › drawer are $'s.
  const columns = `200px minmax(0, 1fr) ${dollars ? 200 : 178}px`;
  const [expanded, setExpanded] = useState(false);
  const rows = ownerRows(view, expanded, "grouped");
  const total = view.scopeTotal || 1;
  // In $, each row's share of the runner-hours that have a rate, on the
  // axis's share scale: where its bar would end at the scope's average $/h.
  // A bar past its mark costs more per hour than average.
  const markOf = (row: OwnerRow) =>
    dollars && row.kind !== "less" ? costMark(view, row.owners) : 0;
  const ticks = niceTicks(
    Math.max(1, ...rows.map((r) => Math.max(r.hours, markOf(r))))
  );
  const axisMax = ticks[ticks.length - 1];
  const step = ticks[1] ?? axisMax;
  const name = scopeName(prepared, view);
  const highlight = highlightName(prepared, view);
  const machinesOn = view.machines.size > 0;
  const ownersOn = view.owners.size > 0;
  const firstBucket = rows.findIndex((r) => r.kind === "bucket");
  const bucketGrey =
    theme.palette.mode === "dark"
      ? theme.palette.grey[600]
      : theme.palette.grey[400];

  const keys = (
    <Box sx={{ display: "flex", gap: 0.75, alignItems: "center" }}>
      {/* In $ the scope is the runner-hours chart's, named in the caption. */}
      {!dollars && (
        <ScopeKeys
          presets={presets}
          scope={scope}
          scopeLabel={name}
          onScopeChange={onScopeChange}
          showCustom
        />
      )}
      <HeaderCheck
        label="Split by machine"
        title="Split bars by machine"
        checked={split}
        onChange={onSplitChange}
      />
    </Box>
  );

  // A row's bar, which is also its keyboard control: Enter or Space does
  // what a click on the row does. The owner's name beside it is a link.
  const bar = (row: OwnerRow, act: () => void, pressed: boolean) => {
    const mix = rowMix(prepared, view, row.owners);
    const estimated = rowMix(prepared, view, row.owners, true);
    const pieces: {
      key: string;
      label: string;
      hours: number;
      fill: string;
      machines: number[];
    }[] = split
      ? segments(prepared, mix, view.machines, estimated).map((s) => ({
          key: s.key,
          label: s.label,
          hours: s.hours,
          fill: paintFill(theme, prepared, s.paint),
          machines: s.machines,
        }))
      : machinesOn
      ? [
          {
            key: "on",
            label: "highlighted machines",
            hours: highlightedHours(mix, view.machines),
            fill: theme.palette.primary.main,
            machines: [],
          },
          {
            key: "rest",
            label: "other machines",
            hours: row.hours - highlightedHours(mix, view.machines),
            fill: paleColor(theme),
            machines: [],
          },
        ]
      : [
          {
            key: "all",
            label: row.label,
            hours: row.hours,
            fill:
              row.kind === "bucket" ? bucketGrey : theme.palette.primary.main,
            machines: [],
          },
        ];
    const sum = (m: Map<string, number>) =>
      row.owners.reduce((a, o) => a + (m.get(o) ?? 0), 0);
    const runnerHours = sum(view.ownerRunnerHours);
    const unpriced = sum(view.ownerUnpriced);
    const head = `${row.label}: ${amount(row.hours)} · ${shareLabel(
      row.hours / total
    )} of ${name}`;
    const rate = averageRate(row.hours, runnerHours, unpriced);
    const coverage = dollars
      ? `${hoursLabel(runnerHours)} h${
          unpriced > 0.5 ? ` (${hoursLabel(unpriced)} h with no rate)` : ""
        } · ${shareLabel(
          (runnerHours - unpriced) /
            (view.scopeRunnerHours - view.scopeUnpriced || 1)
        )} of priced hours${rate !== null ? ` · ${rateLabel(rate)} avg` : ""}`
      : "";
    const action =
      row.kind === "more" || row.kind === "less"
        ? "Click to list them"
        : dollars
        ? "Click to highlight · › for runners"
        : "Click to highlight";
    const detail = [
      head,
      coverage,
      ...machineLines(pieces)
        .slice(0, 10)
        .map(
          (l) =>
            `${l.label}: ${amount(l.hours)}${
              l.estimated > 0 ? `, ${amount(l.estimated)} est.` : ""
            } (${shareLabel(l.hours / (row.hours || 1))})`
        ),
      action,
    ]
      .filter(Boolean)
      .join("\n");
    // Split, each piece names what it ran on: a machine's runners, or the
    // largest of the machines it holds.
    const breakdown = split
      ? new Map(
          runnerBreakdown(prepared, view, row.owners).map((b) => [b.machine, b])
        )
      : null;
    const pieceDetail = (p: (typeof pieces)[number]) => {
      const parts = p.machines
        .map((m) => breakdown?.get(m))
        .filter((b): b is MachineRunners => b !== undefined);
      const value = parts.reduce((a, b) => a + b.value, 0);
      const hours = parts.reduce((a, b) => a + b.hours, 0);
      const missing = parts.reduce((a, b) => a + b.unpriced, 0);
      const label = p.label.replace(/ \(est\.\)$/, "");
      // A machine's reported and estimated pieces share its runners: each
      // gives its own amount, of the machine's when it is one of two.
      const lines = [
        head,
        coverage,
        `${p.label}: ${amount(p.hours)} (${shareLabel(
          p.hours / (row.hours || 1)
        )})${
          p.hours < value - 1e-9
            ? ` of ${label}'s ${amount(value)}`
            : dollars
            ? ` · ${hoursLabel(hours)} h`
            : ""
        }`,
        dollars && missing > 0.5 ? `${hoursLabel(missing)} h with no rate` : "",
      ];
      if (parts.length === 1) {
        const runners = parts[0].runners;
        lines.push(`Runners, share of its ${UNIT_NAMES[unit]}:`);
        for (const r of runners.slice(0, 4)) {
          lines.push(
            `• ${r.label}: ${
              !dollars
                ? shareLabel(r.hours / (hours || 1))
                : r.rate === null
                ? `no rate · ${hoursLabel(r.hours)} h`
                : `${shareLabel(r.value / (value || 1))} · ${rateLabel(r.rate)}`
            }`
          );
        }
        if (runners.length > 4) lines.push(`+ ${runners.length - 4} more`);
      } else {
        const largest = [...parts].sort((a, b) => b.value - a.value);
        for (const b of largest.slice(0, 4)) {
          lines.push(
            `• ${prepared.machines[b.machine]}: ${shareLabel(
              b.value / (value || 1)
            )}`
          );
        }
        if (largest.length > 4) {
          lines.push(`+ ${largest.length - 4} more machines`);
        }
      }
      if (label !== p.label) lines.push("Striped: machine estimated");
      lines.push(action);
      return lines.filter(Boolean).join("\n");
    };
    const mark = markOf(row);
    const barBox = (
      <Box
        role="button"
        tabIndex={0}
        aria-label={
          row.kind === "more"
            ? `List the ${row.owners.length} smaller owners`
            : `Highlight ${row.label}: ${amount(row.hours)}`
        }
        aria-pressed={row.kind === "more" ? undefined : pressed}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            act();
          }
        }}
        sx={{
          height: ROW_HEIGHT,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          outline: "none",
          "&:focus-visible": {
            boxShadow: `inset 0 0 0 2px ${theme.palette.primary.main}`,
            borderRadius: "2px",
          },
          backgroundImage: `linear-gradient(to right, ${theme.palette.divider} 1px, transparent 1px)`,
          backgroundSize: `${(step / axisMax) * 100}% 100%`,
          position: "relative",
        }}
      >
        {mark > 0 && (
          <Box
            sx={{
              position: "absolute",
              left: `${(100 * mark) / axisMax}%`,
              top: "50%",
              width: "2px",
              height: `${BAR_HEIGHT + 6}px`,
              transform: "translate(-1px, -50%)",
              borderRadius: "1px",
              backgroundColor: "text.primary",
              boxShadow: `0 0 0 1px ${theme.palette.background.paper}`,
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        )}
        <Box
          sx={{
            width: `${(100 * row.hours) / axisMax}%`,
            height: BAR_HEIGHT,
            display: "flex",
            gap: "1px",
          }}
        >
          {pieces
            .filter((p) => p.hours > 0)
            .map((p) => {
              const piece = (
                <Box
                  key={p.key}
                  sx={{
                    flex: `0 0 calc(${
                      (100 * p.hours) / (row.hours || 1)
                    }% - 1px)`,
                    minWidth: "1px",
                    background: p.fill,
                    borderRadius: "2px",
                  }}
                />
              );
              return split && dollars
                ? lineTip(pieceDetail(p), piece, p.key)
                : piece;
            })}
        </Box>
      </Box>
    );
    return split && dollars ? barBox : lineTip(detail, barBox);
  };

  return (
    <Box>
      <CostFrame
        title={dollars ? "Cost by owner" : "Runner-hours by owner"}
        description={dollars ? COST_METHOD : method}
        keys={keys}
        open={open}
        onOpenChange={onOpenChange}
        legend={banner}
        loading={loading}
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              lg: `minmax(0, 1fr) ${dollars ? 440 : 400}px`,
            },
            columnGap: 4,
            rowGap: 2,
            opacity: loading ? 0.6 : 1,
            transition: "opacity 150ms",
          }}
        >
          <Box sx={{ typography: "body2", minWidth: 0 }}>
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
              {dollars
                ? amount(view.scopeTotal)
                : `${hoursLabel(view.scopeTotal)} runner-hours`}{" "}
              in {name}
              {view.scope.size > 0
                ? ` (${shareLabel(
                    view.scopeTotal / (prepared.total || 1)
                  )} of the window)`
                : ""}
              {` · ${dates}`}
              {highlight !== "" && (
                <>
                  {" · highlighted, "}
                  {highlight}:{" "}
                  <Box
                    component="span"
                    sx={{ color: "primary.main", fontWeight: 500 }}
                  >
                    {amount(view.highlightTotal)}
                  </Box>{" "}
                  ({shareLabel(view.highlightTotal / total)}){" "}
                  <TextButton
                    label="Clear the highlight"
                    onClick={onClearHighlight}
                  >
                    <Box component="span" sx={{ color: "primary.main" }}>
                      Clear highlight
                    </Box>
                  </TextButton>
                </>
              )}
            </Typography>
            {dollars && view.scopeTotal <= 0 ? (
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", py: 2 }}
              >
                No runner in {name} has a rate: set one under ▸ in the key.
              </Typography>
            ) : (
              <>
                {/* The axis: hours, and their share of the scope beneath. */}
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: columns,
                    columnGap: 1.5,
                    mb: 0.5,
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      textAlign: "right",
                      lineHeight: 1.25,
                    }}
                  >
                    {UNIT_NAMES[unit]}
                    <br />
                    share of{" "}
                    {dollars
                      ? amount(view.scopeTotal)
                      : hoursLabel(view.scopeTotal)}
                  </Typography>
                  <Box sx={{ position: "relative", height: 32 }}>
                    {ticks.map((tick) => (
                      <Typography
                        key={tick}
                        variant="caption"
                        sx={{
                          position: "absolute",
                          left: `${(tick / axisMax) * 100}%`,
                          transform: tick === 0 ? "none" : "translateX(-50%)",
                          color: "text.secondary",
                          lineHeight: 1.25,
                          textAlign: "center",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <Box
                          component="span"
                          sx={{ color: "text.primary", fontWeight: 500 }}
                        >
                          {tick === 0 ? "0" : amount(tick)}
                        </Box>
                        <br />
                        {tick === 0 ? "" : shareLabel(tick / total)}
                      </Typography>
                    ))}
                  </Box>
                  <Box />
                </Box>
                {rows.map((row, i) => {
                  const selected = row.owners.some((o) => view.owners.has(o));
                  const folding = row.kind === "more" || row.kind === "less";
                  const mix = machinesOn
                    ? rowMix(prepared, view, row.owners)
                    : null;
                  const onMachines =
                    mix === null ? 0 : highlightedHours(mix, view.machines);
                  // Highlighted owners have rows of their own, so a folded row
                  // is never highlighted and dims with the rest.
                  const dim = ownersOn && !selected;
                  const toggle = () =>
                    folding
                      ? setExpanded(!expanded)
                      : onToggleOwners(row.owners);
                  return (
                    <Box
                      key={row.key}
                      onClick={toggle}
                      sx={{
                        display: "grid",
                        gridTemplateColumns: columns,
                        columnGap: 1.5,
                        alignItems: "center",
                        cursor: "pointer",
                        opacity: dim ? DIMMED : 1,
                        transition: "opacity 150ms",
                        backgroundColor:
                          runnersKey === row.key
                            ? "action.selected"
                            : undefined,
                        borderTop:
                          i === firstBucket
                            ? `1px solid ${theme.palette.divider}`
                            : undefined,
                        mt: i === firstBucket ? 0.5 : 0,
                        pt: i === firstBucket ? 0.5 : 0,
                        "&:hover": { backgroundColor: "action.hover" },
                      }}
                    >
                      <Box
                        sx={{
                          textAlign: "right",
                          overflow: "hidden",
                          whiteSpace: "nowrap",
                          textOverflow: "ellipsis",
                          fontWeight: selected && !folding ? 600 : 400,
                        }}
                        title={row.kind === "bucket" ? undefined : row.label}
                      >
                        {selected && !folding ? "✓ " : ""}
                        {row.kind === "owner" ? (
                          <span onClick={(event) => event.stopPropagation()}>
                            <TextLink href={ownerTestsHref(repo, row.key)}>
                              {row.label}
                            </TextLink>
                          </span>
                        ) : (
                          <Box
                            component="span"
                            sx={{ color: "text.secondary" }}
                          >
                            {folding ? (
                              <TextButton
                                label={
                                  row.kind === "more"
                                    ? `List the ${row.owners.length} smaller owners`
                                    : "Fold the smaller owners back into one row"
                                }
                                onClick={() => setExpanded(!expanded)}
                              >
                                {row.label}
                                {row.kind === "more" ? " ▸" : " ▴"}
                              </TextButton>
                            ) : (
                              <>
                                {row.label}
                                {row.kind === "bucket" &&
                                  row.owners.some(
                                    (o) => bucketInfo(o) !== ""
                                  ) && (
                                    <InfoTip
                                      title={row.owners
                                        .map(bucketInfo)
                                        .filter(Boolean)
                                        .join("\n\n")}
                                    />
                                  )}
                              </>
                            )}
                          </Box>
                        )}
                      </Box>
                      {row.kind === "less" ? (
                        <Box />
                      ) : (
                        bar(row, toggle, selected)
                      )}
                      <Box
                        sx={{
                          display: "flex",
                          gap: 0.75,
                          justifyContent: "flex-end",
                          color: "text.secondary",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {row.kind === "less" ? null : (
                          <>
                            {mix !== null && (
                              <>
                                <Box
                                  component="span"
                                  sx={{
                                    color: "primary.main",
                                    fontWeight: 500,
                                  }}
                                >
                                  {amount(onMachines)}
                                </Box>
                                <span>of</span>
                              </>
                            )}
                            <span>{amount(row.hours)}</span>
                            <Box
                              component="span"
                              sx={{ width: "3.5ch", textAlign: "right" }}
                            >
                              {shareLabel(row.hours / total)}
                            </Box>
                            {dollars && (
                              <IconButton
                                size="small"
                                aria-label={`Machines and runners of ${row.label}`}
                                title="Machines and runners"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenRunners?.(row);
                                }}
                                sx={{
                                  p: 0.125,
                                  color:
                                    runnersKey === row.key
                                      ? "primary.main"
                                      : "text.secondary",
                                }}
                              >
                                <ChevronRightRoundedIcon fontSize="small" />
                              </IconButton>
                            )}
                          </>
                        )}
                      </Box>
                    </Box>
                  );
                })}
              </>
            )}
          </Box>
          {dollars ? (
            <CostMachineKey
              prepared={prepared}
              view={view}
              onToggleMachines={onToggleMachines}
              onClearMachines={onClearMachines}
              onRateChange={onRateChange}
              originalRates={originalRates}
            />
          ) : (
            <MachineKey
              prepared={prepared}
              view={view}
              onToggleMachines={onToggleMachines}
              onClearMachines={onClearMachines}
            />
          )}
        </Box>
      </CostFrame>
      <Typography
        variant="caption"
        component="p"
        sx={{
          mt: 0.75,
          color: "text.secondary",
          display: open === false ? "none" : undefined,
        }}
      >
        Machines from test reports; striped: estimated from runner labels; grey
        stripes: unknown.
        {dollars && (
          <>
            {" "}
            <Box
              component="span"
              aria-hidden
              sx={{
                display: "inline-block",
                width: "2px",
                height: "0.9em",
                mx: 0.25,
                verticalAlign: "-0.1em",
                borderRadius: "1px",
                backgroundColor: "text.primary",
              }}
            />{" "}
            share of runner-hours with a rate; a bar past it costs more per hour
            than average. › lists a row&apos;s runners.
          </>
        )}
      </Typography>
    </Box>
  );
}
