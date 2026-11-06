import { Box, ButtonBase, TableSortLabel, useTheme } from "@mui/material";
import type { TrendRollup } from "lib/api/tests/cost/windows";
import { amountLabel, fineAmountLabel, shareLabel } from "lib/tests/cost/query";
import type { CostUnit } from "lib/tests/cost/runnerHours";
import {
  changeLabel,
  deltaLabel,
  TREND_TOP_OWNERS,
  type TrendPer,
  type TrendRow,
  type TrendSort,
  type TrendSortKey,
} from "lib/tests/cost/trend";

export interface TrendTableProps {
  rows: TrendRow[];
  unit: CostUnit;
  // What the rows compare by: per day with data, or per commit.
  per: TrendPer;
  // The trend's periods, for the Trend column's header: each a day, week or
  // month, from first to last in words.
  rollup: TrendRollup;
  periodsLabel: string;
  highlighted: ReadonlySet<string>;
  // The periods in words, for the column titles: "Oct 28", "Oct 28 – Nov 3".
  aLabel: string | null;
  bLabel: string;
  // The column the owners are sorted by, and a header's click.
  sort: TrendSort;
  onSort: (_by: TrendSortKey) => void;
  onToggleOwners: (_owners: string[]) => void;
  // The folded row lists every owner; Show fewer folds them back.
  onExpandedChange: (_expanded: boolean) => void;
}

const EVERY: Record<TrendRollup, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

// The Trend column's header: a point a period, "Weekly trend"; what each
// point is, in its title.
export function trendHeader(rollup: TrendRollup): string {
  return `${EVERY[rollup]} trend`;
}

// A row's values over the periods as a line, the last period's a dot.
function Sparkline({ values, color }: { values: Float64Array; color: string }) {
  const max = Math.max(1e-9, ...Array.from(values));
  const n = values.length;
  if (n === 0) return null;
  const x = (i: number) => (n === 1 ? 50 : (100 * i) / (n - 1));
  const y = (v: number) => 22 - (20 * v) / max;
  const points = Array.from(values, (v, i) => `${x(i)},${y(v)}`).join(" ");
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      width="100%"
      height="24"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x(n - 1)} cy={y(values[n - 1])} r="2.2" fill={color} />
    </svg>
  );
}

// The owners in B, every owner together first, then the top owners sorted
// by the column whose header was clicked (B, largest first, until then),
// every highlighted one wherever it ranks, the rest folded into "N more
// owners" until listed, with "Show fewer" to fold them back, then the
// buckets.
// Figures are per day with data, or per commit (push:main over pushes to
// main); per day, each row's per commit in A and B too. A rise is ▲ in the
// error color, a fall ▼ in the success color, so the sign never rests on
// color alone. With a budget, B's pace a year against the row's. A row's
// click highlights its owners across the page.
export default function TrendTable({
  rows,
  unit,
  per,
  rollup,
  periodsLabel,
  highlighted,
  aLabel,
  bLabel,
  sort,
  onSort,
  onToggleOwners,
  onExpandedChange,
}: TrendTableProps) {
  const theme = useTheme();
  const budgets = rows.some((r) => r.budget !== null);
  // Per commit as a column of its own while the table compares per day.
  const perCommit = per === "day" && rows.some((r) => r.bPerCommit !== null);
  const amount = (v: number) => fineAmountLabel(unit, v);
  const up = theme.palette.error.main;
  const down =
    theme.palette.mode === "dark"
      ? theme.palette.success.light
      : theme.palette.success.dark;
  const columns = [
    "minmax(140px, 1.6fr)",
    "minmax(56px, 0.6fr)",
    ...(aLabel === null ? [] : ["minmax(72px, 0.8fr)"]),
    "minmax(72px, 0.8fr)",
    ...(aLabel === null ? [] : ["minmax(80px, 0.8fr)", "minmax(64px, 0.7fr)"]),
    ...(perCommit ? ["minmax(112px, 1fr)"] : []),
    "minmax(104px, 1fr)",
    ...(budgets ? ["minmax(84px, 0.8fr)"] : []),
  ].join(" ");
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
  // A header that sorts by its column, its arrow showing which way, as the
  // tests page's tables do: ▲ and ▼ in the cells mean a rise and a fall.
  const sortable = (by: TrendSortKey, label: string, title: string) => {
    const active = sort.by === by;
    return (
      <Box
        role="columnheader"
        aria-sort={
          active ? (sort.dir === "desc" ? "descending" : "ascending") : "none"
        }
        sx={head}
        title={`${title} · click to sort, ${
          active && sort.dir === "desc" ? "smallest" : "largest"
        } first`}
      >
        <TableSortLabel
          active={active}
          direction={active ? sort.dir : "desc"}
          onClick={() => onSort(by)}
          sx={{ flexDirection: "row-reverse", color: "inherit" }}
        >
          {label}
        </TableSortLabel>
      </Box>
    );
  };
  return (
    <Box role="table" sx={{ typography: "body2" }}>
      <Box
        role="row"
        sx={{
          display: "grid",
          gridTemplateColumns: columns,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Box role="columnheader" sx={{ ...head, textAlign: "left" }}>
          Owner
        </Box>
        <Box role="columnheader" sx={head}>
          Share of B
        </Box>
        {aLabel !== null && sortable("a", `A / ${per}`, `A: ${aLabel}`)}
        {sortable("b", `B / ${per}`, `B: ${bLabel}`)}
        {aLabel !== null &&
          sortable("delta", "Change", `B minus A, per ${per}`)}
        {aLabel !== null && sortable("change", "%", "Change from A, in %")}
        {perCommit && (
          <Box
            role="columnheader"
            sx={head}
            title="What one push to main costs, A → B: its runner-hours ÷ pushes to main, with every test running (no target determination)"
          >
            Per commit A → B
          </Box>
        )}
        <Box
          role="columnheader"
          sx={{ ...head, textAlign: "center" }}
          title={`${unit === "cost" ? "$" : "Runner-hours"} ${
            per === "commit"
              ? `per push to main, each ${rollup}`
              : rollup === "day"
              ? "each day"
              : `per day with data, each ${rollup}`
          }, ${periodsLabel}; the dot is the latest`}
        >
          {trendHeader(rollup)}
        </Box>
        {budgets && (
          <Box role="columnheader" sx={head}>
            vs budget
          </Box>
        )}
      </Box>
      {rows.map((row) => {
        if (row.kind === "less") {
          return (
            <ButtonBase
              key={row.key}
              component="div"
              role="row"
              aria-expanded
              title={`Fold the owners past the top ${TREND_TOP_OWNERS} back into one row`}
              onClick={() => onExpandedChange(false)}
              sx={{
                display: "grid",
                gridTemplateColumns: columns,
                width: "100%",
                font: "inherit",
                textAlign: "inherit",
                color: "text.secondary",
                borderBottom: `1px solid ${theme.palette.divider}`,
                "&:hover": { backgroundColor: "action.hover" },
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                },
              }}
            >
              <Box
                role="cell"
                sx={{ ...cell, textAlign: "left", gridColumn: "1 / -1" }}
              >
                {row.label} ▴
              </Box>
            </ButtonBase>
          );
        }
        const lit =
          row.kind !== "all" &&
          row.owners.length > 0 &&
          row.owners.every((o) => highlighted.has(o));
        const color =
          row.delta === null || row.delta === 0
            ? "text.secondary"
            : row.delta > 0
            ? up
            : down;
        const clickable = row.kind !== "all";
        return (
          <ButtonBase
            key={row.key}
            component="div"
            role="row"
            disabled={!clickable}
            aria-selected={clickable && row.kind !== "more" ? lit : undefined}
            aria-expanded={row.kind === "more" ? false : undefined}
            onClick={() =>
              row.kind === "more"
                ? onExpandedChange(true)
                : onToggleOwners(row.owners)
            }
            title={
              row.kind === "more"
                ? `List the ${row.owners.length} other owners`
                : clickable
                ? lit
                  ? `Stop highlighting ${row.label}`
                  : `Highlight ${row.label} across the page`
                : undefined
            }
            sx={{
              display: "grid",
              gridTemplateColumns: columns,
              width: "100%",
              alignItems: "center",
              font: "inherit",
              textAlign: "inherit",
              borderBottom: `1px solid ${theme.palette.divider}`,
              fontWeight: row.kind === "all" || lit ? 600 : 400,
              color:
                row.kind === "bucket" || row.kind === "more"
                  ? "text.secondary"
                  : "text.primary",
              "&:hover": clickable ? { backgroundColor: "action.hover" } : {},
              "&.Mui-disabled": { color: "text.primary" },
              "&.Mui-focusVisible": {
                outline: `2px solid ${theme.palette.primary.main}`,
              },
            }}
          >
            <Box role="cell" sx={{ ...cell, textAlign: "left" }}>
              {lit ? "✓ " : ""}
              {row.label}
              {row.kind === "more" ? " ▸" : ""}
            </Box>
            <Box role="cell" sx={cell}>
              {shareLabel(row.share)}
            </Box>
            {aLabel !== null && (
              <Box role="cell" sx={cell}>
                {row.aPer === null ? "—" : amount(row.aPer)}
              </Box>
            )}
            <Box role="cell" sx={cell}>
              {amount(row.bPer)}
            </Box>
            {aLabel !== null && (
              <Box role="cell" sx={{ ...cell, color }}>
                {row.delta === null || row.delta === 0
                  ? "—"
                  : deltaLabel(row.delta, amount)}
              </Box>
            )}
            {aLabel !== null && (
              <Box role="cell" sx={{ ...cell, color }}>
                {changeLabel(row)}
              </Box>
            )}
            {perCommit && (
              <Box role="cell" sx={{ ...cell, color: "text.secondary" }}>
                {`${row.aPerCommit === null ? "—" : amount(row.aPerCommit)} → ${
                  row.bPerCommit === null ? "—" : amount(row.bPerCommit)
                }`}
              </Box>
            )}
            <Box role="cell" sx={{ px: 1 }}>
              <Sparkline
                values={row.series}
                color={
                  row.kind === "all" || lit
                    ? theme.palette.primary.main
                    : theme.palette.text.secondary
                }
              />
            </Box>
            {budgets && (
              <Box role="cell" sx={cell}>
                {row.budget === null ? (
                  ""
                ) : (
                  <Box
                    component="span"
                    title={`Projected: ${amountLabel(
                      "cost",
                      row.budget.pace
                    )} a year at B's daily average; budget ${amountLabel(
                      "cost",
                      row.budget.annual
                    )}${
                      row.budget.unpriced > 0.5
                        ? ". Some of B's runner-hours have no rate, so the projection is at least this"
                        : ""
                    }`}
                    sx={{
                      px: 0.75,
                      py: 0.25,
                      borderRadius: "999px",
                      fontSize: "0.75rem",
                      color:
                        row.budget.ratio > 1
                          ? up
                          : row.budget.unpriced > 0.5
                          ? "text.secondary"
                          : down,
                      border: "1px solid currentColor",
                    }}
                  >
                    {row.budget.annual <= 0
                      ? "▲ Over"
                      : row.budget.ratio > 1
                      ? `▲ Over ${shareLabel(row.budget.ratio - 1)}`
                      : row.budget.unpriced > 0.5
                      ? "Partly unpriced"
                      : `✓ Under ${shareLabel(1 - row.budget.ratio)}`}
                  </Box>
                )}
              </Box>
            )}
          </ButtonBase>
        );
      })}
    </Box>
  );
}
