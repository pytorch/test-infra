import { Box, Tooltip, Typography, useTheme } from "@mui/material";
import CostFrame from "components/tests/cost/CostFrame";
import KeyButton from "components/tests/cost/KeyButton";
import MachineKey from "components/tests/cost/MachineKey";
import HeaderCheck from "components/tests/HeaderCheck";
import TextButton from "components/tests/TextButton";
import TextLink from "components/tests/TextLink";
import type { WorkflowPreset } from "lib/api/tests/cost/types";
import { paintFill, paleColor } from "lib/tests/cost/colors";
import { hoursLabel, ownerTestsHref, shareLabel } from "lib/tests/cost/query";
import {
  type CostView,
  highlightedHours,
  highlightName,
  isScope,
  type OwnerRow,
  ownerRows,
  type PreparedHours,
  rowMix,
  scopeName,
  segments,
} from "lib/tests/cost/runnerHours";
import { niceTicks } from "lib/tests/cost/ticks";
import { useState } from "react";

const ROW_HEIGHT = 24;
const BAR_HEIGHT = 14;
const COLUMNS = "200px minmax(0, 1fr) 178px";
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

// The scope's runner-hours by owner, largest first: the top owners, every
// highlighted one, the rest folded into "N more owners", then shared and
// unattributed hours, so the rows add up to the scope. Split by machine,
// each bar is its machines in a fixed order; highlighting machines moves
// their pieces to the start of every bar and paints the rest pale;
// highlighting owners dims the other rows. Only the scope moves the bars.
// The machine key to the right is the legend and the machine picker.
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
}: OwnerChartProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const rows = ownerRows(view, expanded, "grouped");
  const total = view.scopeTotal || 1;
  const ticks = niceTicks(Math.max(1, ...rows.map((r) => r.hours)));
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
      <ScopeKeys
        presets={presets}
        scope={scope}
        scopeLabel={name}
        onScopeChange={onScopeChange}
        showCustom
      />
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
    const pieces = split
      ? segments(prepared, mix, view.machines).map((s) => ({
          key: s.key,
          label: s.label,
          hours: s.hours,
          fill: paintFill(theme, prepared, s.paint),
        }))
      : machinesOn
      ? [
          {
            key: "on",
            label: "highlighted machines",
            hours: highlightedHours(mix, view.machines),
            fill: theme.palette.primary.main,
          },
          {
            key: "rest",
            label: "other machines",
            hours: row.hours - highlightedHours(mix, view.machines),
            fill: paleColor(theme),
          },
        ]
      : [
          {
            key: "all",
            label: row.label,
            hours: row.hours,
            fill:
              row.kind === "bucket" ? bucketGrey : theme.palette.primary.main,
          },
        ];
    const detail = [
      `${row.label}: ${hoursLabel(row.hours)} runner-hours, ${shareLabel(
        row.hours / total
      )} of ${name}`,
      ...pieces
        .filter((p) => p.hours > 0)
        .slice(0, 10)
        .map(
          (p) =>
            `${p.label}: ${hoursLabel(p.hours)} h (${shareLabel(
              p.hours / (row.hours || 1)
            )})`
        ),
      row.kind === "more" || row.kind === "less"
        ? "Click to list them"
        : "Click to highlight",
    ].join("\n");
    return (
      <Tooltip
        title={detail}
        followCursor
        enterDelay={150}
        slotProps={{
          tooltip: { sx: { whiteSpace: "pre-line", maxWidth: 420 } },
        }}
      >
        <Box
          role="button"
          tabIndex={0}
          aria-label={
            row.kind === "more"
              ? `List the ${row.owners.length} smaller owners`
              : `Highlight ${row.label}: ${hoursLabel(row.hours)} runner-hours`
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
            alignItems: "center",
            outline: "none",
            "&:focus-visible": {
              boxShadow: `inset 0 0 0 2px ${theme.palette.primary.main}`,
              borderRadius: "2px",
            },
            backgroundImage: `linear-gradient(to right, ${theme.palette.divider} 1px, transparent 1px)`,
            backgroundSize: `${(step / axisMax) * 100}% 100%`,
          }}
        >
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
              .map((p) => (
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
              ))}
          </Box>
        </Box>
      </Tooltip>
    );
  };

  return (
    <Box>
      <CostFrame
        title="Runner-hours by owner"
        description={method}
        keys={keys}
        loading={loading}
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              lg: "minmax(0, 1fr) 400px",
            },
            columnGap: 4,
            rowGap: 2,
            opacity: loading ? 0.6 : 1,
            transition: "opacity 150ms",
          }}
        >
          <Box sx={{ typography: "body2", minWidth: 0 }}>
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
              {hoursLabel(view.scopeTotal)} runner-hours in {name}
              {view.scope.size > 0
                ? ` (${shareLabel(
                    view.scopeTotal / (prepared.total || 1)
                  )} of the window)`
                : ""}
              {highlight !== "" && (
                <>
                  {" · highlighted, "}
                  {highlight}:{" "}
                  <Box
                    component="span"
                    sx={{ color: "primary.main", fontWeight: 500 }}
                  >
                    {hoursLabel(view.highlightTotal)} h
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
            {/* The axis: hours, and their share of the scope beneath. */}
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: COLUMNS,
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
                runner-hours
                <br />
                share of {hoursLabel(view.scopeTotal)}
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
                      {tick === 0 ? "0" : `${hoursLabel(tick)} h`}
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
                folding ? setExpanded(!expanded) : onToggleOwners(row.owners);
              return (
                <Box
                  key={row.key}
                  onClick={toggle}
                  sx={{
                    display: "grid",
                    gridTemplateColumns: COLUMNS,
                    columnGap: 1.5,
                    alignItems: "center",
                    cursor: "pointer",
                    opacity: dim ? DIMMED : 1,
                    transition: "opacity 150ms",
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
                    title={row.label}
                  >
                    {selected && !folding ? "✓ " : ""}
                    {row.kind === "owner" ? (
                      <span onClick={(event) => event.stopPropagation()}>
                        <TextLink href={ownerTestsHref(repo, row.key)}>
                          {row.label}
                        </TextLink>
                      </span>
                    ) : (
                      <Box component="span" sx={{ color: "text.secondary" }}>
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
                          row.label
                        )}
                      </Box>
                    )}
                  </Box>
                  {row.kind === "less" ? <Box /> : bar(row, toggle, selected)}
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
                              sx={{ color: "primary.main", fontWeight: 500 }}
                            >
                              {hoursLabel(onMachines)} h
                            </Box>
                            <span>of</span>
                          </>
                        )}
                        <span>{hoursLabel(row.hours)} h</span>
                        <Box
                          component="span"
                          sx={{ width: "3.5ch", textAlign: "right" }}
                        >
                          {shareLabel(row.hours / total)}
                        </Box>
                      </>
                    )}
                  </Box>
                </Box>
              );
            })}
          </Box>
          <MachineKey
            prepared={prepared}
            view={view}
            onToggleMachines={onToggleMachines}
            onClearMachines={onClearMachines}
          />
        </Box>
      </CostFrame>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          gap: 2,
          mt: 0.75,
          typography: "caption",
          color: "text.secondary",
        }}
      >
        <span>
          Machines come from each job&apos;s test reports, or its runner label&apos;s.
        </span>
        <span>
          {name.charAt(0).toUpperCase() + name.slice(1)} · {dates}
        </span>
      </Box>
    </Box>
  );
}
