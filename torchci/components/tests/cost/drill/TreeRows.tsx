import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import {
  Box,
  ButtonBase,
  LinearProgress,
  type Theme,
  useTheme,
} from "@mui/material";
import { encodeTrail, type Pill, rootOf } from "lib/api/tests/cost/contracts";
import {
  amount,
  appendPill,
  byNoun,
  type ChangeScale,
  type DrillRow,
  environmentText,
  type Expansion,
  expansionOf,
  expansionRows,
  type HalfScale,
  type MachineOpens,
  machineSwitches,
  scopeName,
} from "lib/tests/cost/drill";
import { apiErrorMessage } from "lib/tests/table";
import { type ReactNode, useState } from "react";
import ButterflyRow, {
  BUTTERFLY_GRID,
  drillColors,
  nameIndent,
  swatchFor,
} from "./ButterflyRow";
import { LabelChip } from "./FileLevel";
import { type DrillModel, useLevel } from "./useDrill";

// ── Which rows are open (component state, per view; not the URL) ──
// A row's id is its own scope, encodeTrail'd; the rows under it extend it
// with ";", and its "N more" is id#more. Each view (root and trail) keeps its
// own, so climbing back finds the rows as they were left.
interface ViewOpen {
  open: string[];
  opens: Record<string, MachineOpens>; // a machine's Owners | Runners
  more: string[];
}
const NONE: ViewOpen = { open: [], opens: {}, more: [] };

export interface ExpandState {
  isOpen: (_id: string) => boolean;
  toggle: (_id: string) => void;
  opens: (_id: string) => MachineOpens;
  setOpens: (_id: string, _opens: MachineOpens) => void;
  moreOpen: (_id: string) => boolean;
  toggleMore: (_id: string) => void;
  any: boolean; // a row of this view is open
  collapseAll: () => void;
}

// Everything under a row (and the row itself with self): closing a row
// closes what was open inside it.
function closeUnder(v: ViewOpen, id: string, self: boolean): ViewOpen {
  const under = (k: string) =>
    (self && k === id) || k.startsWith(`${id};`) || k === `${id}#more`;
  return {
    open: v.open.filter((k) => !under(k)),
    opens: v.opens,
    more: v.more.filter((k) => !under(k)),
  };
}

export function useExpandState(viewKey: string): ExpandState {
  const [views, setViews] = useState<Record<string, ViewOpen>>({});
  const v = views[viewKey] ?? NONE;
  const update = (f: (_v: ViewOpen) => ViewOpen) =>
    setViews((prev) => ({ ...prev, [viewKey]: f(prev[viewKey] ?? NONE) }));
  return {
    isOpen: (id) => v.open.includes(id),
    toggle: (id) =>
      update((w) =>
        w.open.includes(id)
          ? closeUnder(w, id, true)
          : { ...w, open: [...w.open, id] }
      ),
    opens: (id) => v.opens[id] ?? "o",
    setOpens: (id, opens) =>
      update((w) => ({
        ...closeUnder(w, id, false),
        opens: { ...w.opens, [id]: opens },
      })),
    moreOpen: (id) => v.more.includes(id),
    toggleMore: (id) =>
      update((w) => ({
        ...w,
        more: w.more.includes(id)
          ? w.more.filter((k) => k !== id)
          : [...w.more, id],
      })),
    any: v.open.length > 0,
    collapseAll: () => update((w) => ({ ...NONE, opens: w.opens })),
  };
}

// ── Keys on a row ──
// Drill in: pins the row's whole scope as the trail (a file's: its file
// view, environments and "Load configurations and test cases"). Shown on
// open rows and on the row under the pointer or holding keyboard focus
// (ButterflyRow's .drill-key); no tooltip.
function FocusKey({ name, onFocus }: { name: string; onFocus: () => void }) {
  const theme = useTheme();
  return (
    <ButtonBase
      className="drill-key"
      aria-label={`Drill in to ${name}`}
      onClick={onFocus}
      sx={{
        ml: "auto",
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        height: 20,
        px: 0.625,
        borderRadius: "10px",
        typography: "caption",
        color: "primary.main",
        border: `1px solid ${theme.palette.primary.main}`,
        backgroundColor: "background.paper",
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: 1,
        },
      }}
    >
      <OpenInFullRoundedIcon sx={{ fontSize: 12 }} />
      <Box component="span">Drill in</Box>
    </ButtonBase>
  );
}

// An open machine at the machine root: list its owners (the default) or its
// runner labels. Quiet words, on the open row only.
function MachineSwitch({
  name,
  value,
  onChange,
}: {
  name: string;
  value: MachineOpens;
  onChange: (_v: MachineOpens) => void;
}) {
  const theme = useTheme();
  const option = (v: MachineOpens, words: string, title: string) => (
    <ButtonBase
      aria-pressed={value === v}
      title={title}
      onClick={() => value !== v && onChange(v)}
      sx={{
        typography: "caption",
        px: "3px",
        borderRadius: 0.5,
        color: value === v ? "text.primary" : "text.secondary",
        fontWeight: value === v ? 600 : 400,
        "&:hover": { textDecoration: "underline" },
        "&.Mui-focusVisible": {
          outline: `2px solid ${theme.palette.primary.main}`,
        },
      }}
    >
      {words}
    </ButtonBase>
  );
  return (
    <Box
      role="group"
      aria-label={`What ${name} lists`}
      sx={{ display: "inline-flex", alignItems: "center", flex: "none" }}
    >
      {option("o", "Owners", `${name}'s owners`)}
      <Box
        component="span"
        aria-hidden
        sx={{ color: "text.disabled", typography: "caption" }}
      >
        |
      </Box>
      {option("label", "Runners", `${name}'s runner labels`)}
    </Box>
  );
}

// A slim line under an open row while its children load, or why they
// didn't.
function StatusRow({
  depth,
  loading,
  children,
}: {
  depth: number;
  loading: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  const c = drillColors(theme);
  return (
    <Box
      role="row"
      aria-busy={loading || undefined}
      sx={{
        display: "grid",
        gridTemplateColumns: BUTTERFLY_GRID,
        alignItems: "center",
        minHeight: 22,
        backgroundColor: c.nest,
      }}
    >
      <Box />
      <Box
        role="cell"
        sx={{
          gridColumn: "2 / -1",
          display: "flex",
          alignItems: "center",
          gap: 1,
          pl: `${nameIndent(depth) + 16}px`,
          typography: "caption",
          color: "text.secondary",
          borderLeft: `1px solid ${theme.palette.divider}`,
          alignSelf: "stretch",
        }}
      >
        {children}
        {loading && <LinearProgress sx={{ width: 120, height: 2 }} />}
      </Box>
    </Box>
  );
}

// A lane of a file opened in place: its environment (the tokens its
// siblings don't share) and workflow, its runner labels as chips under it.
function LaneName({ row }: { row: DrillRow }) {
  return (
    <Box component="span" sx={{ display: "block", whiteSpace: "normal" }}>
      <Box
        component="span"
        sx={{
          display: "block",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.name}
        {row.detail && (
          <Box component="span" sx={{ color: "text.secondary" }}>
            {` · ${row.detail}`}
          </Box>
        )}
      </Box>
      {row.labels.length > 0 && (
        <Box
          component="span"
          sx={{ display: "flex", flexWrap: "wrap", gap: "2px 4px", pb: "3px" }}
        >
          {row.labels.map((l) => (
            <LabelChip
              key={l.label}
              dense
              label={l.label}
              hours={l.b}
              title={`${l.label}: ${amount("hours", l.b)} a day in B`}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// A row's title where it has no tooltip: a runner label's workflows, a
// lane's whole environment.
function rowTitle(row: DrillRow): string | undefined {
  if (row.by === "label")
    return `${row.name}${row.detail ? ` · workflows: ${row.detail}` : ""}`;
  if (row.by === "lane") {
    const env = row.info.environment;
    const name = env ? environmentText(env) : row.name;
    return `${name}${row.detail ? ` · ${row.detail}` : ""}`;
  }
  return undefined;
}

// A child row's swatch: machines in their hue; owners none (the bars name
// owners only at the owner root's top level).
const childSwatch = (theme: Theme, drill: DrillModel, r: DrillRow) =>
  swatchFor(theme, {
    by: r.by,
    key: r.key,
    prepared: drill.input.runnerHours,
    named: null,
  });

export interface TreeRowProps {
  drill: DrillModel;
  exp: ExpandState;
  row: DrillRow;
  scope: readonly Pill[]; // the trail of the level listing this row
  depth: number;
  scale: HalfScale; // the table's (or canvas's): children are never rescaled
  change: ChangeScale;
  totals: { a: number | null; b: number | null }; // share base
  parent: { a: number | null; b: number | null } | null;
  swatch: string | null;
  stale: boolean;
  // Top rows keep theirs while closed (open, it would cover the children
  // just opened); children have a title only.
  tooltip?: ReactNode;
}

// One row of the drill table or canvas: clicking an owner,
// machine or file row opens it in place onto its children (expansionOf)
// and its Drill in key pins its scope; runner labels and lanes open
// nothing (a lane's labels are its chips) and have a title only.
export function TreeRow(props: TreeRowProps) {
  const { drill, exp, row, scope, depth } = props;
  const { unit, per } = drill.input;
  const dim =
    row.by === "o" || row.by === "m" || row.by === "f" ? row.by : null;
  const id = dim ? encodeTrail(appendPill(scope, { dim, value: row.key })) : "";
  const expansion = dim
    ? expansionOf(scope, row.by, row.key, exp.opens(id))
    : null;
  const open = expansion !== null && exp.isOpen(id);
  const switches = open && machineSwitches(scope, row.by);
  return (
    <>
      <ButterflyRow
        row={row}
        kind="row"
        depth={depth}
        totals={props.totals}
        parent={props.parent}
        scale={props.scale}
        change={props.change}
        chg="h"
        unit={unit}
        per={per}
        swatch={props.swatch}
        caret={expansion ? (open ? "open" : "closed") : null}
        label={row.by === "lane" ? <LaneName row={row} /> : undefined}
        tooltip={open ? undefined : props.tooltip}
        title={rowTitle(row)}
        stale={props.stale}
        expanded={expansion ? open : undefined}
        ariaLabel={
          expansion
            ? `${row.name}: ${open ? "close" : "open"} its ${byNoun(
                expansion.by,
                true
              )}`
            : undefined
        }
        actions={
          expansion ? (
            <>
              {switches && (
                <MachineSwitch
                  name={row.name}
                  value={exp.opens(id)}
                  onChange={(v) => exp.setOpens(id, v)}
                />
              )}
              <FocusKey
                name={row.name}
                onFocus={() => drill.focus(expansion.trail)}
              />
            </>
          ) : undefined
        }
        onClick={expansion ? () => exp.toggle(id) : undefined}
        onHover={(on) =>
          drill.setHover(on ? { by: row.by, children: [row.key] } : null)
        }
      />
      {open && expansion && (
        <Children
          drill={drill}
          exp={exp}
          id={id}
          expansion={expansion}
          parentRow={row}
          depth={depth + 1}
          scale={props.scale}
          change={props.change}
        />
      )}
    </>
  );
}

// An open row's children: one /scope (SWR keeps it per URL, so closing and
// opening again asks nothing), on the parent's scale, each value's share of
// the open row; the first NESTED_TOP, "N more" opening the rest in place,
// then the buckets.
function Children({
  drill,
  exp,
  id,
  expansion,
  parentRow,
  depth,
  scale,
  change,
}: {
  drill: DrillModel;
  exp: ExpandState;
  id: string;
  expansion: Expansion;
  parentRow: DrillRow;
  depth: number;
  scale: HalfScale;
  change: ChangeScale;
}) {
  const theme = useTheme();
  const { unit, per, pricer, rollup, query } = drill.input;
  const level = useLevel(
    drill.scopeUrl(expansion.trail, expansion.by),
    drill.fetchScope,
    { unit, per, pricer, rollup }
  );
  const what = `${byNoun(expansion.by, true)} of ${scopeName(
    expansion.trail,
    rootOf(expansion.trail, drill.root)
  )}`;
  const view = level.view;
  if (!view) {
    return level.error ? (
      <StatusRow depth={depth} loading={false}>
        Could not load the {what}: {apiErrorMessage(level.error)}
        <ButtonBase
          onClick={level.retry}
          sx={{ typography: "caption", color: "primary.main", px: 0.5 }}
        >
          Retry
        </ButtonBase>
      </StatusRow>
    ) : (
      <StatusRow depth={depth} loading>
        Loading the {what}
      </StatusRow>
    );
  }
  const { shown, rest, more, buckets, total } = expansionRows(view, query.sort);
  const moreId = `${id}#more`;
  const moreOpen = exp.moreOpen(moreId);
  const totals = { a: total.a, b: total.b };
  const parent = { a: parentRow.a, b: parentRow.b };
  const child = (r: DrillRow) => (
    <TreeRow
      key={r.key}
      drill={drill}
      exp={exp}
      row={r}
      scope={expansion.trail}
      depth={depth}
      scale={scale}
      change={change}
      totals={totals}
      parent={parent}
      swatch={childSwatch(theme, drill, r)}
      stale={level.stale}
    />
  );
  const noun = byNoun(expansion.by, rest.length !== 1);
  return (
    <>
      {shown.map(child)}
      {more && (
        <ButterflyRow
          row={more}
          kind="more"
          depth={depth}
          totals={totals}
          label={`${rest.length} more ${noun}`}
          caret={moreOpen ? "open" : "closed"}
          scale={scale}
          change={change}
          chg="h"
          unit={unit}
          per={per}
          stale={level.stale}
          expanded={moreOpen}
          ariaLabel={`${rest.length} more ${noun}: ${
            moreOpen ? "fold them" : "list them"
          }`}
          onClick={() => exp.toggleMore(moreId)}
        />
      )}
      {moreOpen && rest.map(child)}
      {buckets.map(child)}
      {shown.length + rest.length + buckets.length === 0 && (
        <StatusRow depth={depth} loading={false}>
          No {byNoun(expansion.by, true)} with runner-hours here in A or B.
        </StatusRow>
      )}
    </>
  );
}
