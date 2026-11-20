import { Box, Tooltip, Typography, useTheme } from "@mui/material";
import CostFrame from "components/tests/cost/CostFrame";
import KeyButton from "components/tests/cost/KeyButton";
import { VISUALLY_HIDDEN } from "components/tests/cost/rates/RateStrip";
import PickRow from "components/tests/cost/trends/PickRow";
import QuickRow from "components/tests/cost/trends/QuickRow";
import TrendBars, {
  type BandTab,
} from "components/tests/cost/trends/TrendBars";
import {
  type BarsScope,
  costUnit,
  type DayRange,
  DEFAULT_SHOW,
  encodeTrail,
  type Rollup,
  type StripGeometry,
  type TrendsPanelProps,
  type TrendsQuery,
  type Unit,
} from "lib/api/tests/cost/contracts";
import { hatch } from "lib/tests/cost/colors";
import {
  type DayCells,
  foldBars,
  type Folded,
  seriesDayCells,
  trendDayCells,
} from "lib/tests/cost/fold";
import { fineAmountLabel } from "lib/tests/cost/query";
import { pricingNotes } from "lib/tests/cost/ratePeriods";
import { ownerLabel } from "lib/tests/cost/runnerHours";
import {
  calendarDays,
  comparePresets,
  dataDays,
  dayLabel,
  fillingDays,
  fitShow,
  lengthText,
  overlapDays,
  type PickAction,
  type PickEnv,
  type Picker,
  rangeText,
  reducePicker,
  type Selection,
  selectionPatch,
  shownRange,
  type Side,
  weekendShare,
} from "lib/tests/cost/select";
import {
  paintFill,
  spanTotals,
  type Stacks,
  trendStacks,
} from "lib/tests/cost/stacks";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// The Trends panel: the band's keys, the pick and quick
// rows, the drill's trail and head (slots), the stacked bars with A/B on them, one
// foot line (legend, one quiet hint), one disclosure line, then the drill's
// table. A and B, rollup, Show, per and unit live in the URL through
// onQueryChange; the armed side is the panel's own.

const ROLLUPS: { value: Rollup; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const DESCRIPTION = [
  "Runner-hours of test jobs (ci.test_cost) by day, week or month, stacked by what the scope lists; $ with a rates file, each day priced at its own rate period.",
  "Per day: a bar's hours over its days with data. Per commit: push-to-main hours over pushes to main (main runs every test).",
  "Owners are today's ownership map applied to every day (not kept per day yet). A machine is the job environment's, else the machine its runner label ran on most that week. No data before the first day shown.",
  "Picking periods: choose A or B (or press A, B), then click a bar to place it at its length, drag across bars to draw a longer one, drag an edge to stretch it or its label to move it. ← → move it, Shift+← → by its length, [ ] resize.",
].join("\n");

const scopeKey = (s: BarsScope) =>
  [
    encodeTrail(s.trail),
    s.root,
    s.by,
    s.fromTrend,
    s.hover === null ? "" : `${s.hover.by}:${s.hover.children.join("\u0001")}`,
  ].join("|");

const inField = (target: EventTarget) =>
  typeof Element !== "undefined" &&
  target instanceof Element &&
  target.closest("input, textarea, select, [contenteditable]") !== null;

// "3 of 7 days priced" when $ divides by fewer days than the
// side has data on (none priced reads "no rates" instead).
export function pricedNote(t: {
  days: number;
  pricedDays: number;
}): string | null {
  return t.pricedDays > 0 && t.pricedDays < t.days
    ? `${t.pricedDays} of ${t.days} days priced`
    : null;
}

// The disclosure line's items, most important first.
export function disclosures(input: {
  folded: Folded;
  stacks: Stacks;
  sel: Selection;
  per: TrendsQuery["per"];
  unit: Unit;
  pricer: TrendsPanelProps["pricer"];
  context: NonNullable<TrendsPanelProps["context"]>;
}): string[] {
  const { folded, stacks, sel, per, unit, pricer, context: ctx } = input;
  const items: string[] = [];
  const filling = [
    ...new Set([
      ...fillingDays(ctx, sel.a),
      ...fillingDays(ctx, sel.b),
      ...(folded.window === null ? [] : fillingDays(ctx, folded.window)),
    ]),
  ].sort();
  if (filling.length > 0) {
    items.push(
      `${filling.map(dayLabel).join(", ")} ${
        filling.length === 1 ? "is" : "are"
      } still filling (reads low until the 03:30 UTC rerun)`
    );
  }
  if (unit === "usd" && pricer !== null && folded.window !== null) {
    // Only the drawn days with data: a month bar's days before the data
    // starts would read as days without rates.
    const from =
      ctx.firstDay !== null && ctx.firstDay > folded.window.from
        ? ctx.firstDay
        : folded.window.from;
    const range = { from, to: folded.window.to };
    if (range.from <= range.to) {
      const t = spanTotals(folded, stacks, range);
      const line = pricer.coverageLine(range, t.unpriced);
      if (line !== null) items.push(line);
    }
  }
  if (unit === "usd" && pricer !== null) {
    const priced = (["a", "b"] as const).flatMap((s) => {
      const note = pricedNote(spanTotals(folded, stacks, sel[s]));
      return note === null ? [] : [`${s.toUpperCase()}: ${note}`];
    });
    if (priced.length > 0) items.push(priced.join(", "));
  }
  const partial = (["a", "b"] as const).flatMap((s) => {
    const r = sel[s];
    const data = dataDays(ctx, r);
    const calendar = calendarDays(sel.rollup, r);
    const name = s.toUpperCase();
    if (data === 0) {
      return [
        `${name} has no data${
          ctx.firstDay !== null && r.to < ctx.firstDay
            ? ` (test_cost starts ${dayLabel(ctx.firstDay)})`
            : ""
        }`,
      ];
    }
    return data < calendar
      ? [`${name} has data on ${data} of ${calendar} days`]
      : [];
  });
  if (partial.length > 0) items.push(partial.join(", "));
  if (sel.rollup === "day" && per === "day") {
    const wa = weekendShare(ctx, sel.a);
    const wb = weekendShare(ctx, sel.b);
    if (
      wa.days > 0 &&
      wb.days > 0 &&
      Math.abs(wa.weekend / wa.days - wb.weekend / wb.days) >= 0.25
    ) {
      items.push(
        `A and B mix weekends differently (A ${wa.weekend} of ${wa.days} days, B ${wb.weekend} of ${wb.days})`
      );
    }
  }
  const overlap = overlapDays(sel.a, sel.b);
  if (overlap > 0) {
    items.push(
      sel.a.from === sel.b.from && sel.a.to === sel.b.to
        ? "A and B are the same period"
        : `A and B overlap by ${overlap} day${overlap === 1 ? "" : "s"}`
    );
  }
  if (
    per === "commit" &&
    Math.min(dataDays(ctx, sel.a), dataDays(ctx, sel.b)) === 1
  ) {
    items.push(
      "per commit varies about 5% from day to day; compare 7 days to spot smaller changes"
    );
  }
  return items;
}

export default function TrendsPanel(props: TrendsPanelProps) {
  const {
    answer,
    context: ctx,
    loading,
    query,
    compare,
    onQueryChange,
    pricer,
    runnerHours,
    scope,
    series,
    seriesLoading,
    workflowScope,
    slots,
    renderStrip,
  } = props;
  const theme = useTheme();
  const rollup = query.rollup;
  const show = query.show ?? DEFAULT_SHOW[rollup];
  const unit: Unit = query.unit === "usd" && pricer !== null ? "usd" : "hours";
  const per = query.per;
  const repo = answer?.repo ?? "";
  const shown = ctx === null ? null : shownRange(rollup, show, ctx.end);

  // ── the bars' day cells: /trend at the owner root, else /series; while a
  // scope's series loads, the last bars drawn stay, dimmed ──
  const trendCells = useMemo(
    () => (answer?.rollup === "day" ? trendDayCells(answer) : null),
    [answer]
  );
  const seriesCells = useMemo(
    () => (series === undefined ? null : seriesDayCells(series)),
    [series]
  );
  const kept = useRef<{ cells: DayCells; scope: BarsScope } | null>(null);
  let cells: DayCells | null;
  let barsScope: BarsScope = scope;
  let stale = loading;
  if (scope.fromTrend) cells = trendCells;
  else if (seriesCells !== null && !seriesLoading) cells = seriesCells;
  else {
    stale = true;
    if (kept.current !== null) {
      cells = kept.current.cells;
      barsScope = kept.current.scope;
    } else {
      cells = trendCells;
      barsScope = {
        ...scope,
        trail: [],
        by: "o",
        fromTrend: true,
        hover: null,
      };
    }
  }
  useEffect(() => {
    if (!stale && cells !== null) kept.current = { cells, scope: barsScope };
  });
  const colored = useMemo(
    () =>
      runnerHours === undefined
        ? []
        : runnerHours.colored.map((m) => runnerHours.machines[m]),
    [runnerHours]
  );
  const folded = useMemo(
    () =>
      cells === null || shown === null || ctx === null
        ? null
        : foldBars(cells, rollup, shown, ctx),
    // shown is rebuilt from its days each render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells, rollup, shown?.from, shown?.to, ctx]
  );
  const barsKey = scopeKey(barsScope);
  const stacks = useMemo(
    () =>
      folded === null
        ? null
        : trendStacks(folded, {
            repo,
            unit,
            per,
            pricer,
            scope: barsScope,
            colored,
          }),
    // barsScope is read through its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folded, repo, unit, per, pricer, barsKey, colored]
  );

  // ── the picker: A/B from the URL (live while a drag runs) ──
  const [armed, setArmed] = useState<Side>("b");
  const [live, setLive] = useState<Selection | null>(null);
  const liveRef = useRef<Selection | null>(null);
  const [pending, setPending] = useState<Selection | null>(null);
  const origin = useRef<Picker | null>(null);
  const [legendFocus, setLegendFocus] = useState<number | null>(null);
  const [hoverSpan, setHoverSpan] = useState<DayRange | null>(null);
  const showMemory = useRef<Partial<Record<Rollup, number | null>>>({});
  const compareKey =
    compare === null
      ? ""
      : `${compare.rollup}|${compare.a.from}|${compare.a.to}|${compare.b.from}|${compare.b.to}`;
  useEffect(() => setPending(null), [compareKey]);
  const base: Selection | null =
    compare === null
      ? null
      : {
          rollup: compare.rollup,
          a: compare.a,
          b: compare.b,
          preset: compare.preset,
        };
  const sel = live ?? pending ?? base;
  const picker: Picker | null = sel === null ? null : { sel, armed };
  const env: PickEnv | null =
    folded?.window && ctx ? { window: folded.window, ctx } : null;

  const write = (next: Selection) => {
    if (ctx === null) return;
    const patch: Partial<TrendsQuery> = selectionPatch(next, ctx);
    if (next.rollup !== rollup) {
      showMemory.current[rollup] = query.show;
      patch.show = showMemory.current[next.rollup] ?? null;
    }
    onQueryChange(patch);
    setPending(next.rollup === rollup ? next : null);
  };
  const dispatch = (action: PickAction) => {
    if (picker === null || ctx === null) return;
    const e: PickEnv = env ?? { window: shown!, ctx };
    const next = reducePicker(picker, action, e);
    if (next === picker) return;
    if (next.armed !== armed) setArmed(next.armed);
    if (next.sel !== picker.sel) write(next.sel);
  };
  const onKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (event.defaultPrevented || inField(event.target)) return false;
    const key = event.key;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (key === "a" || key === "b" || key === "A" || key === "B") {
      dispatch({ type: "arm", side: key.toLowerCase() as Side });
      event.preventDefault();
      return true;
    }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      dispatch({
        type: "move",
        by: key === "ArrowLeft" ? -1 : 1,
        whole: event.shiftKey,
      });
      event.preventDefault();
      return true;
    }
    if (key === "[" || key === "]") {
      dispatch({ type: "resize", by: key === "[" ? -1 : 1 });
      event.preventDefault();
      return true;
    }
    return false;
  };
  // A and B keys anywhere in the panel (never in fields); the rest only on
  // the chart, which hands them to onKey itself.
  const onPanelKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || inField(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (["a", "b", "A", "B"].includes(event.key)) onKey(event);
  };

  const keys = (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 0.75,
        alignItems: "center",
      }}
    >
      {ROLLUPS.map((r) => (
        <KeyButton
          key={r.value}
          title={`A bar per ${r.value}`}
          active={rollup === r.value}
          onClick={() => dispatch({ type: "rollup", rollup: r.value })}
        >
          {r.label}
        </KeyButton>
      ))}
      <Box sx={{ width: 8 }} />
      <KeyButton
        title="Runner-hours"
        active={unit === "hours"}
        onClick={() => onQueryChange({ unit: "hours" })}
      >
        Hours
      </KeyButton>
      <KeyButton
        title={
          pricer === null
            ? "Add a rates file to see $"
            : `$ at ${pricer.set.file}'s rates`
        }
        active={unit === "usd"}
        disabled={pricer === null}
        onClick={() => onQueryChange({ unit: "usd" })}
      >
        $
      </KeyButton>
      <Box sx={{ width: 8 }} />
      <KeyButton
        title="Per day: a bar's hours over its days with data"
        active={per === "day"}
        onClick={() => onQueryChange({ per: "day" })}
      >
        Per day
      </KeyButton>
      <KeyButton
        title="Per commit: push-to-main hours over pushes to main"
        active={per === "commit"}
        onClick={() => onQueryChange({ per: "commit" })}
      >
        Per commit
      </KeyButton>
    </Box>
  );
  const note = `· ${workflowScope ?? "all workflows"}`;
  const frame = (children: ReactNode) => (
    <CostFrame
      title="Trends"
      description={DESCRIPTION}
      note={note}
      keys={keys}
      loading={loading || seriesLoading}
    >
      <Box onKeyDown={onPanelKey}>{children}</Box>
    </CostFrame>
  );

  if (ctx === null || answer === undefined) {
    return frame(
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Loading the trend…
      </Typography>
    );
  }
  if (
    ctx.firstDay === null ||
    folded === null ||
    stacks === null ||
    sel === null ||
    picker === null
  ) {
    return frame(
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {ctx.firstDay === null
          ? "No runner-hours in this window yet."
          : "Loading the trend…"}
      </Typography>
    );
  }

  const cu = costUnit(unit);
  const perText = per === "day" ? "a day" : "per commit";
  const sideFacts = (s: Side) => {
    const r = sel[s];
    const t = spanTotals(folded, stacks, r);
    const usd = unit === "usd" && pricer !== null;
    const notes = usd
      ? pricingNotes(
          pricer,
          folded.cells.days.filter((d) => d >= r.from && d <= r.to)
        )
      : { approx: false, lines: [] };
    return { t, approx: notes.approx, priced: usd ? pricedNote(t) : null };
  };
  const facts = { a: sideFacts("a"), b: sideFacts("b") };
  const tabOf = (s: Side): BandTab => {
    const { t, approx, priced } = facts[s];
    const name = s.toUpperCase();
    const range = `${name} · ${rangeText(sel[s], false)}`;
    const grip = "drag to move it, click to pick it";
    if (t.days === 0) {
      return {
        label: `${name} · no data`,
        title: `${range} · no data · ${grip}`,
        value: null,
      };
    }
    // $ over days without rates reads blank, never $0.
    if (unit === "usd" && (per === "day" ? t.pricedDays : t.pricedPushes) === 0)
      return {
        label: `${name} · no rates`,
        title: `${range} · no rates · ${grip}`,
        value: null,
      };
    const amount = `${approx ? "≈" : ""}${fineAmountLabel(cu, t.value)}`;
    const value = `${amount} ${perText}${
      priced === null ? "" : ` · ${priced}`
    }`;
    return {
      label: `${name} · ${value}`,
      short: `${name} · ${amount.replace(/ h$/, "")}`,
      title: `${range} · ${value} · ${grip}`,
      value: t.value,
    };
  };
  const tabs = { a: tabOf("a"), b: tabOf("b") };
  const items = disclosures({
    folded,
    stacks,
    sel,
    per,
    unit,
    pricer,
    context: ctx,
  });
  const disclosure = items.join(" · ");
  const ta = facts.a.t;
  const tb = facts.b.t;
  // Only between two figures: a side with no data or no rates is no $0.
  const change =
    tabs.a.value !== null && tabs.b.value !== null && ta.value > 0
      ? (tb.value - ta.value) / ta.value
      : null;
  const status = `B: ${rangeText(sel.b)}, ${lengthText(
    sel.rollup,
    sel.b
  )}, ${tabs.b.label.split(" · ").slice(1).join(", ")}${
    change === null
      ? ""
      : Math.abs(change) < 0.005
      ? ", ±0% vs A"
      : `, ${change > 0 ? "▲" : "▼"} ${Math.abs(
          Math.round(change * 100)
        )}% vs A`
  }`;
  const focus = legendFocus ?? stacks.lit;
  const legendKeys = stacks.keys
    .map((key, k) => ({ key, k }))
    .filter(({ k }) => stacks.keyTotals[k] > 0);
  const strip =
    renderStrip !== undefined && unit === "usd" && folded.window !== null
      ? renderStrip({
          bars: folded.bars.map((b) => ({ start: b.start, days: b.calendar })),
          last: folded.window.to,
          priceSpan: (range) => {
            const t = spanTotals(folded, stacks, range);
            return { usd: t.usd, hours: t.hours, unpriced: t.unpriced };
          },
          onHoverSpan: setHoverSpan,
        } satisfies StripGeometry)
      : null;
  const presets = comparePresets(ctx);

  return frame(
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <PickRow
        rollup={sel.rollup}
        a={sel.a}
        b={sel.b}
        armed={armed}
        context={ctx}
        show={show}
        priced={{ a: facts.a.priced, b: facts.b.priced }}
        onArm={(side) => dispatch({ type: "arm", side })}
        onSwap={() => dispatch({ type: "swap" })}
        onShow={(n) => {
          showMemory.current[rollup] = n;
          onQueryChange({ show: n === DEFAULT_SHOW[rollup] ? null : n });
        }}
      />
      <QuickRow
        presets={presets}
        active={sel.preset}
        onPreset={(id) => dispatch({ type: "preset", id })}
      />
      {slots.trail}
      {slots.head}
      <TrendBars
        folded={folded}
        stacks={stacks}
        picker={picker}
        env={env ?? { window: shown!, ctx }}
        tabs={tabs}
        focus={focus}
        dimmed={stale}
        preview={scope.preview}
        hoverSpan={hoverSpan}
        strip={strip}
        pricer={unit === "usd" ? pricer : null}
        ariaLabel={`Period picker. A: ${rangeText(
          sel.a,
          false
        )}. B: ${rangeText(
          sel.b,
          false
        )}. Keys: A or B picks, arrows move, Shift+arrows move by the period's length, brackets resize.`}
        onAction={dispatch}
        onDragStart={() => {
          origin.current = picker;
        }}
        onDrag={(action) => {
          const o = origin.current;
          if (o === null || env === null) return;
          const next = reducePicker(o, action, env);
          const s = next.sel === o.sel ? null : next.sel;
          liveRef.current = s;
          setLive(s);
        }}
        onDragEnd={(commit) => {
          const o = origin.current;
          const s = liveRef.current;
          origin.current = null;
          liveRef.current = null;
          if (commit && o !== null && s !== null) write(s);
          setLive(null);
        }}
        onKey={onKey}
        onWiden={(side) => {
          const n = fitShow(rollup, sel[side], ctx.end);
          if (n !== null) {
            showMemory.current[rollup] = n;
            onQueryChange({ show: n === DEFAULT_SHOW[rollup] ? null : n });
          }
        }}
      />
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          columnGap: 2,
          rowGap: 0.5,
        }}
      >
        <Box
          component="ul"
          aria-label="Legend"
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 1.5,
            m: 0,
            p: 0,
            listStyle: "none",
          }}
        >
          {legendKeys.map(({ key, k }) => {
            const fill = paintFill(theme, key.paint);
            return (
              <Box
                component="li"
                key={key.id}
                onMouseEnter={() => setLegendFocus(k)}
                onMouseLeave={() => setLegendFocus(null)}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  typography: "caption",
                  color: "text.secondary",
                  cursor: "default",
                }}
              >
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: "2px",
                    background: fill.hatch ? hatch(fill.color) : fill.color,
                  }}
                />
                {ownerLabel(key.label)}
              </Box>
            );
          })}
        </Box>
        <Box sx={{ ml: "auto" }} />
        {/* What the bars can't say on their own (a day still filling, days
            without data or rates), on the legend's line; how to pick
            periods is behind the band's (i). */}
        {disclosure !== "" && (
          <Tooltip
            title={disclosure}
            enterDelay={600}
            slotProps={{ tooltip: { sx: { maxWidth: 520 } } }}
          >
            <Typography
              variant="caption"
              component="p"
              noWrap
              sx={{ color: "text.secondary", m: 0, maxWidth: "50%" }}
            >
              {disclosure.charAt(0).toUpperCase() + disclosure.slice(1)}
            </Typography>
          </Tooltip>
        )}
      </Box>
      <Box role="status" aria-live="polite" sx={VISUALLY_HIDDEN}>
        {status}
      </Box>
      {slots.table}
    </Box>
  );
}
