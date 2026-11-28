import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import { Box, IconButton, Tooltip, Typography, useTheme } from "@mui/material";
import InfoTip from "components/tests/cost/InfoTip";
import MachineKey from "components/tests/cost/owners/MachineKey";
import RunnersDrawer from "components/tests/cost/owners/RunnersDrawer";
import TextButton from "components/tests/TextButton";
import { costUnit, type Pill } from "lib/api/tests/cost/contracts";
import { barFill } from "lib/tests/cost/colors";
import {
  bucketInfo,
  highlightedHours,
  type OwnerBarsModel,
  type OwnerRow,
  ownerRows,
  rowMix,
  segments,
} from "lib/tests/cost/ownerBars";
import {
  amountLabel,
  hoursLabel,
  shareLabel,
  UNIT_NAMES,
} from "lib/tests/cost/query";
import { highlightName, isBucket } from "lib/tests/cost/runnerHours";
import { niceTicks } from "lib/tests/cost/ticks";
import { type ReactElement, useEffect, useState } from "react";

const ROW_HEIGHT = 24;
const BAR_HEIGHT = 14;
const DIMMED = 0.35;
const COLUMNS = "200px minmax(0, 1fr) 204px";

export interface OwnerBarsProps {
  model: OwnerBarsModel;
  // The answer drawn is not B's yet: drawn dimmed until it is.
  stale: boolean;
  scopeLabel: string;
  onTogglePill: (_pill: Pill) => void;
  onClear: () => void;
}

// A tooltip that follows the pointer, its lines kept.
function lineTip(title: string, child: ReactElement) {
  return (
    <Tooltip
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

// B's runner-hours (or $) by owner, largest first: the top owners, every
// pinned one, the rest folded into "N more owners", then the unattributed
// hours (its two buckets listed under it on a click), so the rows add up to
// B. Each bar is its machines in a fixed order; a pinned machine moves its
// pieces to the start of every bar and paints the rest pale; a pinned owner
// dims the other rows. A click on an owner or a machine drills into it
// below; a row's › lists its machines and runners (RunnersDrawer). The
// machine key to the right is the legend.
export default function OwnerBars({
  model,
  stale,
  scopeLabel,
  onTogglePill,
  onClear,
}: OwnerBarsProps) {
  const theme = useTheme();
  const { prepared, view, hours, total: sideTotal } = model;
  const unit = costUnit(model.unit);
  const dollars = model.unit === "usd";
  const amount = (v: number) => amountLabel(unit, v);
  const [expanded, setExpanded] = useState(false);
  const [bucketsChoice, setBucketsOpen] = useState<boolean | null>(null);
  // The row whose runners the drawer lists, by key.
  const [runnersKey, setRunnersKey] = useState<string | null>(null);
  const bucketsOpen =
    bucketsChoice ?? Array.from(view.owners).some((o) => isBucket(o));
  const rows = ownerRows(view, {
    expanded,
    bucketsOpen,
    ran: (o) => (hours.ownerScope.get(o) ?? 0) > 0,
  });
  const totalValue = sideTotal.value ?? view.scopeTotal;
  const total = view.scopeTotal || 1;
  const ticks = niceTicks(Math.max(1e-9, ...rows.map((r) => r.hours)));
  const axisMax = ticks[ticks.length - 1] || 1;
  const step = ticks[1] ?? axisMax;
  const highlight = highlightName(prepared, view);
  const machinesOn = view.machines.size > 0;
  const ownersOn = view.owners.size > 0;
  const firstBucket = rows.findIndex((r) => r.kind === "bucket");
  // Looked up in the rows as drawn now, so its figures follow B and the
  // unit; an owner listed under "N more owners" keeps it open once folded,
  // and a row gone closes it.
  const runnersRow =
    runnersKey === null
      ? null
      : rows.find((r) => r.key === runnersKey && r.kind !== "less") ??
        ((hours.ownerScope.get(runnersKey) ?? 0) > 0 && !isBucket(runnersKey)
          ? {
              key: runnersKey,
              label: runnersKey,
              owners: [runnersKey],
              hours: view.ownerScope.get(runnersKey) ?? 0,
              kind: "owner" as const,
            }
          : null);
  const runnersGone = runnersKey !== null && runnersRow === null;
  useEffect(() => {
    if (runnersGone) setRunnersKey(null);
  }, [runnersGone]);
  const unpriced =
    dollars && model.unpricedH >= 0.5
      ? `${hoursLabel(model.unpricedH)} h unpriced`
      : null;
  const notes = [
    dollars ? model.divisors.pricedNote : null,
    unpriced,
    model.answer.filling.length > 0 ? "includes a day still filling" : null,
  ].filter((n): n is string => n !== null);

  // A row's bar, which is also its keyboard control: Enter or Space does
  // what a click on the row does.
  const bar = (row: OwnerRow, act: () => void, pressed: boolean) => {
    const mix = rowMix(prepared, view, row.owners);
    const estimated = rowMix(prepared, view, row.owners, true);
    const pieces = segments(prepared, mix, view.machines, estimated).map(
      (s) => ({
        key: s.key,
        label: s.label,
        hours: s.hours,
        fill: barFill(theme, prepared, s.paint),
      })
    );
    const drills = row.kind === "owner" || row.kind === "member";
    const detail = [
      `${row.label}: ${amount(row.hours)} · ${shareLabel(
        row.hours / total
      )} of ${scopeLabel}`,
      ...machineLines(pieces)
        .slice(0, 10)
        .map(
          (l) =>
            `${l.label}: ${amount(l.hours)}${
              l.estimated > 0 ? `, ${amount(l.estimated)} est.` : ""
            } (${shareLabel(l.hours / (row.hours || 1))})`
        ),
      drills ? "Click to drill in" : "Click to list them",
    ].join("\n");
    return lineTip(
      detail,
      <Box
        role="button"
        tabIndex={0}
        aria-label={
          row.kind === "more"
            ? `List the ${row.owners.length} smaller owners`
            : row.kind === "bucket"
            ? `List the unattributed hours: ${amount(row.hours)}`
            : `Drill into ${row.label}: ${amount(row.hours)}`
        }
        aria-pressed={drills ? pressed : undefined}
        aria-expanded={row.kind === "bucket" ? bucketsOpen : undefined}
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
    );
  };

  return (
    <>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "minmax(0, 1fr)",
            // Wider in $, as V1's: room for $/h without cutting names.
            lg: `minmax(0, 1fr) ${dollars ? 460 : 400}px`,
          },
          columnGap: 4,
          rowGap: 2,
          opacity: stale ? 0.6 : 1,
          transition: "opacity 150ms",
        }}
      >
        <Box sx={{ typography: "body2", minWidth: 0 }}>
          <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
            <Box
              component="span"
              title={
                sideTotal.notes.length > 0
                  ? sideTotal.notes.join("\n")
                  : undefined
              }
            >
              {dollars
                ? `${sideTotal.approx ? "≈ " : ""}${amount(totalValue)}`
                : `${hoursLabel(totalValue)} runner-hours`}
            </Box>{" "}
            in {scopeLabel}
            {notes.map((n) => ` · ${n}`).join("")}
            {highlight !== "" && (
              <>
                {" · "}
                {highlight}:{" "}
                <Box
                  component="span"
                  sx={{ color: "primary.main", fontWeight: 500 }}
                >
                  {amount(view.highlightTotal)}
                </Box>{" "}
                ({shareLabel(view.highlightTotal / total)}){" "}
                <TextButton label="Clear the drill-down" onClick={onClear}>
                  <Box component="span" sx={{ color: "primary.main" }}>
                    Clear
                  </Box>
                </TextButton>
              </>
            )}
          </Typography>
          {/* The axis: the amount, and its share of B beneath. */}
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
              {UNIT_NAMES[unit]}
              <br />
              share of{" "}
              {dollars ? amount(view.scopeTotal) : hoursLabel(view.scopeTotal)}
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
            const folding = row.kind === "more" || row.kind === "less";
            const drills = row.kind === "owner" || row.kind === "member";
            const selected = row.owners.some((o) => view.owners.has(o));
            const mix = machinesOn ? rowMix(prepared, view, row.owners) : null;
            const onMachines =
              mix === null ? 0 : highlightedHours(mix, view.machines);
            // Pinned owners have rows of their own, so a folded row is never
            // pinned and dims with the rest.
            const dim = ownersOn && !selected;
            const act = () =>
              folding
                ? setExpanded(!expanded)
                : row.kind === "bucket"
                ? setBucketsOpen(!bucketsOpen)
                : onTogglePill({ dim: "o", value: row.key });
            return (
              <Box
                key={`${row.kind}:${row.key}`}
                onClick={act}
                sx={{
                  display: "grid",
                  gridTemplateColumns: COLUMNS,
                  columnGap: 1.5,
                  alignItems: "center",
                  cursor: "pointer",
                  opacity: dim ? DIMMED : 1,
                  transition: "opacity 150ms",
                  backgroundColor:
                    runnersRow?.key === row.key ? "action.selected" : undefined,
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
                    fontWeight: selected && drills ? 600 : 400,
                    color:
                      row.kind === "owner" ? "text.primary" : "text.secondary",
                    pr: row.kind === "member" ? 1.5 : 0,
                  }}
                  title={
                    row.kind === "owner" || row.kind === "member"
                      ? row.label
                      : undefined
                  }
                >
                  {selected && drills ? "✓ " : ""}
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
                  ) : row.kind === "bucket" ? (
                    <>
                      {row.label} {bucketsOpen ? "▾" : "▸"}
                      <InfoTip
                        title={row.owners
                          .map(bucketInfo)
                          .filter(Boolean)
                          .join("\n\n")}
                      />
                    </>
                  ) : (
                    row.label
                  )}
                </Box>
                {row.kind === "less" ? <Box /> : bar(row, act, selected)}
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
                      <IconButton
                        size="small"
                        aria-label={`Machines and runners of ${row.label}`}
                        aria-expanded={runnersRow?.key === row.key}
                        title="Machines and runners"
                        onClick={(event) => {
                          event.stopPropagation();
                          setRunnersKey(
                            runnersRow?.key === row.key ? null : row.key
                          );
                        }}
                        sx={{
                          p: 0.125,
                          color:
                            runnersRow?.key === row.key
                              ? "primary.main"
                              : "text.secondary",
                        }}
                      >
                        <ChevronRightRoundedIcon fontSize="small" />
                      </IconButton>
                    </>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
        <MachineKey model={model} onTogglePill={onTogglePill} />
      </Box>
      <RunnersDrawer
        model={model}
        row={runnersRow}
        scopeLabel={scopeLabel}
        onClose={() => setRunnersKey(null)}
      />
    </>
  );
}
