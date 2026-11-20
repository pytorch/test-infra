import {
  Box,
  ButtonBase,
  LinearProgress,
  TableSortLabel,
  tableSortLabelClasses,
  Typography,
  useTheme,
} from "@mui/material";
import LoadError from "components/tests/LoadError";
import {
  type Dim,
  type DrillSort,
  encodeTrail,
} from "lib/api/tests/cost/contracts";
import {
  byNoun,
  byTitle,
  changeMetric,
  changeScale,
  cutRows,
  type DrillRow,
  halfScale,
  parentName,
  rangeText,
  rowByKey,
  sortRows,
  sumRows,
  TOP_N,
  totalRowName,
  unitWords,
} from "lib/tests/cost/drill";
import { useState } from "react";
import ButterflyRow, {
  AxisRow,
  BUTTERFLY_GRID,
  DrillBand,
  drillColors,
  FewerRow,
  nameIndent,
  rowTooltip,
  SkeletonRows,
  Swatch,
  swatchFor,
} from "./ButterflyRow";
import Canvas from "./Canvas";
import { drillKeys, menuRows } from "./ScopeTrail";
import SiblingMenu from "./SiblingMenu";
import { TreeRow, useExpandState } from "./TreeRows";
import type { DrillModel, LevelState } from "./useDrill";

// A column header that sorts the rows, as HUD's tables do: MUI's sort
// arrow beside the label, faint on every sortable column, solid with the
// label bold on the one setting the order. The arrow always points down:
// biggest first, in the column's sense.
function SortHead({
  label,
  active,
  title,
  align,
  disabled = false,
  onClick,
}: {
  label: string;
  active: boolean;
  title: string;
  align: "center" | "right";
  disabled?: boolean;
  onClick: () => void;
}) {
  const theme = useTheme();
  const icon = `.${tableSortLabelClasses.icon}`;
  return (
    <TableSortLabel
      active={active}
      direction="desc"
      disabled={disabled}
      onClick={onClick}
      title={title}
      sx={{
        // A right-aligned label keeps its text flush over the numbers.
        flexDirection: align === "right" ? "row-reverse" : "row",
        maxWidth: "100%",
        whiteSpace: "nowrap",
        color: "text.secondary",
        fontWeight: 500,
        borderRadius: 0.5,
        [`& ${icon}`]: { opacity: 0.4, fontSize: 16, mx: 0.25 },
        "&:hover, &:focus": { color: "text.primary" },
        [`&:hover ${icon}`]: { opacity: 0.8 },
        [`&.${tableSortLabelClasses.active}`]: {
          color: "text.primary",
          fontWeight: 700,
          [`& ${icon}`]: { opacity: 1, color: "text.primary" },
        },
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 2,
        },
        "&.Mui-disabled": {
          color: "text.disabled",
          [`& ${icon}`]: { opacity: 0 },
        },
      }}
    >
      {label}
    </TableSortLabel>
  );
}

// Each change column's cycle, one click each: either way, grew, shrank.
const CHANGE_CYCLE: readonly DrillSort[] = ["change", "grew", "shrank"];
const PCT_CYCLE: readonly DrillSort[] = ["pct", "pctgrew", "pctshrank"];
const next = (cycle: readonly DrillSort[], sort: DrillSort): DrillSort => {
  const i = cycle.indexOf(sort);
  return i < 0 ? cycle[0] : cycle[(i + 1) % cycle.length];
};
const CHANGE_LABEL: Partial<Record<DrillSort, string>> = {
  change: "Change",
  grew: "Grew",
  shrank: "Shrank",
};
const PCT_LABEL: Partial<Record<DrillSort, string>> = {
  pct: "%",
  pctgrew: "% grew",
  pctshrank: "% shrank",
};
const CYCLE_TITLE =
  "biggest either way, then grew most, then shrank most; click for the next";

// The table's column headers, one per column (Change over its bar and its
// number): A and B with their dates, the rows' noun, Change and %. A, B,
// Change and % sort the rows; the bar colours live in DrillLegend.
export function HeadRow({
  noun,
  a,
  b,
  sort,
  onSort,
  aSorts = true,
}: {
  noun: string;
  a: string;
  b: string;
  sort: DrillSort;
  onSort: (_sort: DrillSort) => void;
  aSorts?: boolean; // false while A has no data: only B can order the rows
}) {
  const theme = useTheme();
  const order = aSorts ? sort : "b";
  const cell = {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    px: 0.75,
  } as const;
  const ariaSort = (on: boolean) => (on ? "descending" : "none");
  const changeOn = CHANGE_CYCLE.includes(order);
  const pctOn = PCT_CYCLE.includes(order);
  return (
    <Box
      role="row"
      sx={{
        display: "grid",
        gridTemplateColumns: BUTTERFLY_GRID,
        minHeight: 36,
        typography: "body2",
        borderBottom: `1px solid ${theme.palette.divider}`,
      }}
    >
      <Box
        role="columnheader"
        aria-sort={ariaSort(order === "a")}
        sx={{ ...cell, justifyContent: "center" }}
      >
        <SortHead
          label={`A · ${a}`}
          active={order === "a"}
          align="center"
          disabled={!aSorts}
          title={`Sort by A (${a}), largest first`}
          onClick={() => onSort("a")}
        />
      </Box>
      <Box
        role="columnheader"
        sx={{
          ...cell,
          pl: `${nameIndent(0)}px`,
          color: "text.secondary",
          fontWeight: 500,
          borderLeft: `1px solid ${theme.palette.divider}`,
          borderRight: `1px solid ${theme.palette.divider}`,
        }}
      >
        {noun}
      </Box>
      <Box
        role="columnheader"
        aria-sort={ariaSort(order === "b")}
        sx={{ ...cell, justifyContent: "center" }}
      >
        <SortHead
          label={`B · ${b}`}
          active={order === "b"}
          align="center"
          title={`Sort by B (${b}), largest first`}
          onClick={() => onSort("b")}
        />
      </Box>
      <Box
        role="columnheader"
        aria-sort={ariaSort(changeOn)}
        sx={{ ...cell, gridColumn: "4 / 6", justifyContent: "flex-end" }}
      >
        <SortHead
          label={CHANGE_LABEL[order] ?? "Change"}
          active={changeOn}
          align="right"
          disabled={!aSorts}
          title={`Sort by change, B minus A: ${CYCLE_TITLE}`}
          onClick={() => onSort(next(CHANGE_CYCLE, order))}
        />
      </Box>
      <Box
        role="columnheader"
        aria-sort={ariaSort(pctOn)}
        sx={{ ...cell, justifyContent: "flex-end" }}
      >
        <SortHead
          label={PCT_LABEL[order] ?? "%"}
          active={pctOn}
          align="right"
          disabled={!aSorts}
          title={`Sort by % change from A: ${CYCLE_TITLE}`}
          onClick={() => onSort(next(PCT_CYCLE, order))}
        />
      </Box>
    </Box>
  );
}

// The bars' colours, out of the headers: A grey, B blue, what B lost against
// A a faint ghost, what it gained red; with a row open, the parent's band.
export function DrillLegend({ parent = false }: { parent?: boolean }) {
  const theme = useTheme();
  const c = drillColors(theme);
  const item = {
    display: "inline-flex",
    alignItems: "center",
    gap: 0.5,
    whiteSpace: "nowrap",
  } as const;
  const chip = (sx: object) => (
    <Box
      component="span"
      aria-hidden
      sx={{ display: "inline-block", flex: "none", ...sx }}
    />
  );
  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        columnGap: 1.25,
        typography: "caption",
        color: "text.secondary",
      }}
    >
      <Box component="span" sx={item}>
        <Swatch fill={c.a} />A
      </Box>
      <Box component="span" sx={item}>
        <Swatch fill={c.b} />B
      </Box>
      <Box
        component="span"
        sx={item}
        title="What B lost against A, out to where A ended"
      >
        {chip({
          width: 10,
          height: 10,
          borderRadius: "2px",
          bgcolor: c.ghost,
          boxShadow: `inset 0 0 0 1px ${c.ghostEdge}`,
        })}
        lost
      </Box>
      <Box component="span" sx={item} title="What B gained over A">
        <Swatch fill={c.up} />
        gained
      </Box>
      {parent && (
        <Box
          component="span"
          sx={item}
          title="Under an open row, the band behind each child's bars is the open row's own bar, on the same scale"
        >
          {chip({
            width: 14,
            height: 12,
            bgcolor: c.track,
            borderRight: `1px solid ${c.trackEdge}`,
          })}
          parent
        </Box>
      )}
    </Box>
  );
}

// "N other owners and buckets", "12 more machines".
function countWord(
  n: number,
  by: DrillRow["by"],
  rows: readonly DrillRow[],
  other: boolean
): string {
  const buckets = rows.some((r) => r.bucket) && by === "o";
  const noun = byNoun(by, n !== 1);
  return `${n} ${other ? "other " : "more "}${noun}${
    buckets ? " and buckets" : ""
  }`;
}

// The drill table: the root's rows, each opening in place
// onto its children (several at once, nested, on the table's scale) with
// Drill in to pin one as the trail; under a trail, the last pill's row
// opened onto its children (the canvas, on its own scale, whose owner,
// machine and file rows open in place too), the siblings folded into one
// line, and one caption.
export default function DrillTable({ drill }: { drill: DrillModel }) {
  const theme = useTheme();
  const { query } = drill.input;
  const unit = drill.input.unit;
  const per = drill.input.per;
  const table: LevelState = drill.table;
  const view = table.view;
  const n = drill.trail.length;
  const [foldAnchor, setFoldAnchor] = useState<HTMLElement | null>(null);
  const exp = useExpandState(`${drill.root}|${encodeTrail(drill.trail)}`);
  const by = view?.answer.by ?? (n === 0 ? drill.root : drill.trail[n - 1].dim);
  const parent = n === 0 ? null : parentName(drill.trail, drill.root);
  const band = (
    <DrillBand
      title={`${byTitle(by)} · ${unitWords(unit, per, drill.input.rollup)}`}
      of={parent ? `of ${parent}` : undefined}
      keys={
        <>
          <DrillLegend parent={exp.any} />
          {exp.any && (
            <ButtonBase
              onClick={exp.collapseAll}
              sx={{
                typography: "body2",
                color: "primary.main",
                px: 0.5,
                borderRadius: 0.5,
                "&:hover": { textDecoration: "underline" },
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                },
              }}
            >
              Collapse all
            </ButtonBase>
          )}
        </>
      }
    />
  );

  if (table.error && !view) {
    return (
      <Box onKeyDown={drillKeys(drill)}>
        {band}
        <LoadError
          what={`the ${byNoun(by, true)}`}
          error={table.error}
          onRetry={table.retry}
        />
      </Box>
    );
  }
  if (!view) {
    return (
      <Box onKeyDown={drillKeys(drill)}>
        {band}
        <SkeletonRows />
      </Box>
    );
  }

  const sorted = sortRows(view.rows, query.sort, "h", view.aHasDays);
  const selectedKey = n === 0 ? null : drill.trail[n - 1].value;
  const selected = selectedKey === null ? null : rowByKey(view, selectedKey);
  const prepared = drill.input.runnerHours;
  const rowsAreBarsChildren = n === 0;
  const swatch = (r: DrillRow) =>
    swatchFor(theme, {
      by: r.by,
      key: r.key,
      prepared,
      named: rowsAreBarsChildren ? drill.namedOwners : null,
    });
  const expanded = query.more.includes(by as Dim);
  const { shown, more } =
    n === 0
      ? cutRows(sorted, { top: TOP_N[by], expanded, keep: null })
      : { shown: selected ? [selected] : [], more: [] };
  const scale = halfScale(shown);
  const change = changeScale(shown.map((r) => changeMetric(r, "h")));
  const others =
    n === 0 ? [] : sorted.filter((r) => r.key !== selectedKey && !r.hidden);
  const fold =
    others.length > 0
      ? sumRows(
          view,
          others.map((r) => r.key)
        )
      : null;
  const moreRow =
    more.length > 0
      ? sumRows(
          view,
          more.map((r) => r.key)
        )
      : null;
  const dim = table.stale || drill.preview !== null;
  const toggleMore = () =>
    drill.set({
      more: expanded
        ? query.more.filter((d) => d !== by)
        : [...query.more, by as Dim],
    });
  const tip = (r: DrillRow) =>
    rowTooltip({
      row: r,
      context: parent ? `in ${parent}` : "",
      unit,
      per,
      parentB: view.total.b,
      parentName: parent ?? "all test jobs",
    });

  const rowEl = (r: DrillRow) => (
    <TreeRow
      key={r.key}
      drill={drill}
      exp={exp}
      row={r}
      scope={[]}
      depth={0}
      scale={scale}
      change={change}
      totals={view.total}
      parent={null}
      swatch={swatch(r)}
      tooltip={tip(r)}
      stale={table.stale}
    />
  );
  return (
    <Box onKeyDown={drillKeys(drill)} sx={{ position: "relative" }}>
      {band}
      <Box sx={{ position: "relative", height: 2 }}>
        {table.stale && <LinearProgress sx={{ height: 2 }} />}
      </Box>
      <Box
        role="table"
        aria-label={`${byTitle(by)} of ${parent ?? "all test jobs"}`}
      >
        <Box sx={{ opacity: dim ? 0.5 : 1, transition: "opacity 120ms" }}>
          <HeadRow
            noun={byTitle(by).replace(/s$/, "")}
            a={rangeText(view.answer.a)}
            b={rangeText(view.answer.b)}
            sort={query.sort}
            onSort={(sort) => drill.set({ sort })}
            aSorts={view.aHasDays}
          />
          <AxisRow scale={scale} change={change} chg={"h"} unit={unit} />
          <ButterflyRow
            row={view.total}
            kind="total"
            depth={0}
            label={totalRowName(drill.trail, drill.root)}
            scale={scale}
            change={change}
            chg={"h"}
            unit={unit}
            per={per}
            stale={table.stale}
          />
          {n === 0 && shown.filter((r) => !r.bucket).map(rowEl)}
          {n === 0 && moreRow && (
            <ButterflyRow
              row={moreRow}
              kind="more"
              depth={0}
              totals={view.total}
              label={`${countWord(more.length, by, more, false)} ▸`}
              scale={scale}
              change={change}
              chg={"h"}
              unit={unit}
              per={per}
              stale={table.stale}
              onClick={toggleMore}
            />
          )}
          {n === 0 && expanded && sorted.length > TOP_N[by] && (
            <FewerRow onClick={toggleMore} />
          )}
          {n === 0 && shown.filter((r) => r.bucket).map(rowEl)}
          {n > 0 && selected && (
            <ButterflyRow
              row={selected}
              kind="selected"
              depth={0}
              totals={view.total}
              scale={scale}
              change={change}
              chg={"h"}
              unit={unit}
              per={per}
              swatch={swatch(selected)}
              caret="open"
              tooltip={tip(selected)}
              stale={table.stale}
              ariaLabel={`${selected.name}: climb one`}
              onClick={() => drill.climbOne()}
            />
          )}
        </Box>
        {n > 0 && <Canvas drill={drill} exp={exp} />}
        {n > 0 && fold && (
          <Box sx={{ opacity: dim ? 0.5 : 1 }}>
            <ButterflyRow
              row={fold}
              kind="fold"
              depth={0}
              totals={view.total}
              label={countWord(others.length, by, others, true)}
              scale={scale}
              change={change}
              chg={"h"}
              unit={unit}
              per={per}
              stale={table.stale}
              ariaLabel={`${countWord(
                others.length,
                by,
                others,
                true
              )}: list them`}
              onClick={() =>
                setFoldAnchor(document.activeElement as HTMLElement)
              }
            />
          </Box>
        )}
      </Box>
      {/* One caption under the table: at a file the cases' caption speaks. */}
      {!drill.trail.some((p) => p.dim === "f") && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "text.secondary", mt: 0.75 }}
        >
          Owners: today&apos;s owners list, split evenly between co-owners.
          Machine: the environment&apos;s, else the runner label&apos;s that
          week.
        </Typography>
      )}
      {foldAnchor && n > 0 && (
        <SiblingMenu
          open
          anchorEl={foldAnchor}
          onClose={() => setFoldAnchor(null)}
          title={`${byTitle(by)} of ${parent}`}
          rows={menuRows(table, drill)}
          currentKey={selectedKey}
          unit={unit}
          swatchOf={(r) =>
            swatchFor(theme, { by: r.by, key: r.key, prepared, named: null })
          }
          onPreview={(key) =>
            drill.setPreview(key === null ? null : { k: n - 1, value: key })
          }
          onPick={(key) => drill.swap(n - 1, key)}
        />
      )}
    </Box>
  );
}
