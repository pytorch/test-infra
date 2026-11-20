import { Box, ButtonBase, Tooltip, useTheme } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import TrendTooltip from "components/tests/cost/trends/TrendTooltip";
import {
  costUnit,
  type Day,
  type DayRange,
  type Pricer,
} from "lib/api/tests/cost/contracts";
import type { Folded } from "lib/tests/cost/fold";
import { daysNote, isPartialBar } from "lib/tests/cost/fold";
import { amountLabel } from "lib/tests/cost/query";
import {
  dayLabel,
  DRAG_PX,
  ghostFor,
  type PickAction,
  type PickEnv,
  type Picker,
  rangeText,
  type Side,
} from "lib/tests/cost/select";
import { paintFill, type Stacks } from "lib/tests/cost/stacks";
import { niceTicks } from "lib/tests/cost/ticks";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

// The stacked bars with the A/B picker on them: one SVG holding the A/B
// bands and their tabs, the ghost of what a click places, the stacked bars,
// each band's average line and its edge knobs; the rate strip (when given) sits
// between the plot and the axis. Every gesture is a PickAction the panel
// reduces; a drag reports each frame from its origin and commits on release.

export const GUTTER = 56; // y-axis labels
const RIGHT = 8;
const TAB_H = 20;
const PLOT_H = 220;
const AXIS_H = 34;

export function sideColor(theme: Theme, side: Side): string {
  if (side === "b") return theme.palette.primary.main;
  return theme.palette.mode === "dark"
    ? theme.palette.grey[400]
    : theme.palette.grey[700];
}
export function sideText(theme: Theme, side: Side): string {
  if (side === "b") return theme.palette.primary.contrastText;
  return theme.palette.mode === "dark" ? theme.palette.grey[900] : "#fff";
}

export interface BandTab {
  label: string; // "B · 43.9K h a day"
  short?: string; // "B · 43.9K": what a crowded tab reads before its letter
  title?: string; // the tab's plain tooltip
  value: number | null; // the band's average, for its line
}

export interface TrendBarsProps {
  folded: Folded;
  stacks: Stacks;
  picker: Picker; // live during a drag
  env: PickEnv;
  tabs: Record<Side, BandTab>;
  focus: number | null; // the key drawn at the baseline, the rest faded
  dimmed: boolean;
  preview: boolean;
  hoverSpan: DayRange | null;
  strip: ReactNode;
  pricer?: Pricer | null; // $ mode: the tooltip's ≈ and provisional lines
  ariaLabel: string;
  onAction(_action: PickAction): void;
  onDragStart(): void;
  onDrag(_action: PickAction): void;
  onDragEnd(_commit: boolean): void;
  onKey(_event: KeyboardEvent<HTMLElement>): boolean; // true when handled
  onWiden(_side: Side): void;
}

type Role =
  | { kind: "draw" }
  | { kind: "tab"; side: Side }
  | { kind: "edge"; side: Side; edge: "from" | "to" };

interface Drag {
  role: Role;
  side: Side;
  x0: number;
  bar0: number;
  moved: boolean;
  pointerId: number;
}

interface Hover {
  bar: number;
  role: Role;
  shift: boolean;
  touch: boolean;
}

// Whether a bar's days fall in a range.
const inRange = (r: DayRange, start: Day, last: Day) =>
  r.from <= last && r.to >= start;

export default function TrendBars(props: TrendBarsProps) {
  const {
    folded,
    stacks,
    picker,
    env,
    tabs,
    focus,
    dimmed,
    preview,
    hoverSpan,
    strip,
    pricer = null,
    ariaLabel,
  } = props;
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const id = useId().replace(/:/g, "");
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(960);
  const [hover, setHover] = useState<Hover | null>(null);
  const [keyTip, setKeyTip] = useState(false);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Role | null>(null);
  // A tab's plain tooltip, after the pointer rests on it 600 ms.
  const [tabTip, setTabTip] = useState<Side | null>(null);
  const restingTab =
    hover !== null && hover.role.kind === "tab" && dragging === null
      ? hover.role.side
      : null;
  useEffect(() => {
    if (restingTab === null) {
      setTabTip(null);
      return;
    }
    const timer = setTimeout(() => setTabTip(restingTab), 600);
    return () => clearTimeout(timer);
  }, [restingTab]);

  useEffect(() => {
    const el = boxRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const { bars } = folded;
  const n = bars.length;
  const plotW = Math.max(40, width - GUTTER - RIGHT);
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(1, Math.min(24, 0.7 * slot));
  const X = (i: number) => GUTTER + i * slot;
  const plotTop = TAB_H;
  const plotBottom = TAB_H + PLOT_H;

  const values = Array.from(stacks.total);
  for (const s of ["a", "b"] as const) {
    if (tabs[s].value !== null) values.push(tabs[s].value!);
  }
  const ticks = niceTicks(Math.max(0, ...values), 4);
  const yMax = ticks[ticks.length - 1] || 1;
  const Y = (v: number) => plotBottom - (v / yMax) * PLOT_H;

  const barIndex = (day: Day): number => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].start <= day) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // A range's drawn bars, or null when it lies wholly before them.
  const spanOf = (r: DayRange) => {
    if (n === 0 || r.to < bars[0].start) return null;
    const clipped = r.from < bars[0].start;
    const s = clipped ? 0 : barIndex(r.from);
    const e = barIndex(r.to);
    return { s, e, clipped, x0: X(s), x1: X(e + 1) };
  };
  const spans = { a: spanOf(picker.sel.a), b: spanOf(picker.sel.b) };
  const ghostSide =
    hover !== null && hover.role.kind === "draw" && !hover.touch
      ? hover.shift
        ? "a"
        : picker.armed
      : null;
  const ghost =
    ghostSide !== null && dragging === null && hover !== null
      ? ghostFor(picker, ghostSide, bars[hover.bar].start, env)
      : null;
  const ghostSpan = ghost === null ? null : spanOf(ghost);

  // ── off-chart pills ("◂ A · Oct 20 – 26") sit in the tab lane at the
  // plot's left edge; band tabs start right of them ──
  const charW = 6.4;
  const offPills = (["a", "b"] as const).filter(
    (s) => n > 0 && picker.sel[s].to < bars[0].start
  );
  const offText = (s: Side) =>
    `◂ ${s.toUpperCase()} · ${rangeText(picker.sel[s])}`;
  const offLeft: Partial<Record<Side, number>> = {};
  let laneStart = GUTTER;
  for (const s of offPills) {
    offLeft[s] = laneStart;
    laneStart += offText(s).length * charW + 12 + 4;
  }

  // ── tabs: "B · 43.9K h a day". Crowded tabs shorten together ("A · 61.3K",
  // "B · 63.2K"), then A's, then both, drop to their letters; the left tab
  // steps left of the right one rather than covering it ──
  const tabWidth = (text: string) => text.length * charW + 14;
  const tabBox = (s: Side, text: string) => {
    const span = spans[s];
    if (span === null) return null;
    const w = tabWidth(text);
    const x = Math.min(Math.max(span.x0, laneStart), GUTTER + plotW - w);
    return { x, w };
  };
  const overlap = (
    p: { x: number; w: number } | null,
    q: { x: number; w: number } | null
  ) => p !== null && q !== null && p.x < q.x + q.w + 2 && q.x < p.x + p.w + 2;
  const layTabs = (ta: string, tb: string) => {
    const boxes = { a: tabBox("a", ta), b: tabBox("b", tb) };
    if (!overlap(boxes.a, boxes.b)) return boxes;
    // A on the left unless B starts first.
    const [l, r]: [Side, Side] =
      spans.a !== null && spans.b !== null && spans.b.x0 < spans.a.x0
        ? ["b", "a"]
        : ["a", "b"];
    const left = boxes[l]!;
    const right = boxes[r]!;
    const x = right.x - left.w - 2;
    if (x < laneStart) return null;
    return { ...boxes, [l]: { ...left, x } } as typeof boxes;
  };
  const short = (s: Side) => tabs[s].short ?? s.toUpperCase();
  const letter = (s: Side) => s.toUpperCase();
  const tabTexts = { a: tabs.a.label, b: tabs.b.label };
  let laid = layTabs(tabTexts.a, tabTexts.b);
  for (const [ta, tb] of [
    [short("a"), short("b")],
    [letter("a"), short("b")],
    [letter("a"), letter("b")],
  ]) {
    if (laid !== null) break;
    tabTexts.a = ta;
    tabTexts.b = tb;
    laid = layTabs(ta, tb);
  }
  // A and B on the same first bars: the letters may still touch; draw them.
  const tabBoxes = laid ?? {
    a: tabBox("a", tabTexts.a),
    b: tabBox("b", tabTexts.b),
  };

  // ── hit testing ──
  const local = (event: PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  const barAtX = (x: number) =>
    Math.max(0, Math.min(n - 1, Math.floor((x - GUTTER) / slot)));
  const roleAt = (x: number, y: number, touch: boolean): Role => {
    const inside = touch ? 12 : 8;
    const outside = touch ? 12 : 2;
    const order: Side[] = picker.armed === "a" ? ["a", "b"] : ["b", "a"];
    if (y < plotTop) {
      for (const s of order) {
        const t = tabBoxes[s];
        if (t !== null && x >= t.x && x <= t.x + t.w)
          return { kind: "tab", side: s };
      }
      return { kind: "draw" };
    }
    for (const s of order) {
      const span = spans[s];
      if (span === null) continue;
      if (!span.clipped && x >= span.x0 - outside && x <= span.x0 + inside) {
        return { kind: "edge", side: s, edge: "from" };
      }
      if (x >= span.x1 - inside && x <= span.x1 + outside) {
        return { kind: "edge", side: s, edge: "to" };
      }
    }
    return { kind: "draw" };
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || n === 0) return;
    const { x, y } = local(event);
    const touch = event.pointerType === "touch";
    const role = roleAt(x, y, touch);
    const side =
      role.kind === "draw" ? (event.shiftKey ? "a" : picker.armed) : role.side;
    drag.current = {
      role,
      side,
      x0: event.clientX,
      bar0: barAtX(x),
      moved: false,
      pointerId: event.pointerId,
    };
    svgRef.current?.setPointerCapture?.(event.pointerId);
    boxRef.current?.focus({ preventScroll: true });
    if (!touch) event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const { x, y } = local(event);
    const d = drag.current;
    if (d !== null) {
      if (!d.moved) {
        if (Math.abs(event.clientX - d.x0) < DRAG_PX) return;
        d.moved = true;
        setDragging(d.role);
        setHover(null);
        props.onDragStart();
      }
      const bar = barAtX(x);
      const at = bars[bar].start;
      if (d.role.kind === "draw") {
        props.onDrag({
          type: "draw",
          side: d.side,
          from: bars[d.bar0].start,
          to: at,
        });
      } else if (d.role.kind === "edge") {
        props.onDrag({ type: "stretch", side: d.side, edge: d.role.edge, at });
      } else {
        props.onDrag({ type: "slide", side: d.side, by: bar - d.bar0 });
      }
      return;
    }
    const touch = event.pointerType === "touch";
    const next: Hover = {
      bar: barAtX(x),
      role: roleAt(x, y, touch),
      shift: event.shiftKey,
      touch,
    };
    setKeyTip(false);
    setHover((h) =>
      h !== null &&
      h.bar === next.bar &&
      h.shift === next.shift &&
      h.touch === next.touch &&
      JSON.stringify(h.role) === JSON.stringify(next.role)
        ? h
        : next
    );
  };

  const endDrag = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d === null) return;
    if (d.moved) {
      props.onDragEnd(commit);
      return;
    }
    if (!commit) return;
    if (d.role.kind === "tab")
      props.onAction({ type: "arm", side: d.role.side });
    else {
      const side = d.role.kind === "draw" ? d.side : picker.armed;
      props.onAction({ type: "place", side, at: bars[d.bar0].start });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (drag.current !== null) {
        const moved = drag.current.moved;
        drag.current = null;
        setDragging(null);
        if (moved) props.onDragEnd(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (keyTip) {
        setKeyTip(false);
        event.preventDefault();
      }
      return;
    }
    if (props.onKey(event)) {
      if (["ArrowLeft", "ArrowRight", "[", "]"].includes(event.key)) {
        setHover(null);
        setKeyTip(true);
      }
    }
  };

  // ── the tooltip's bar: hovered over the bars (never over a tab or an
  // edge knob, which have their own gestures), or with keys the armed
  // period's first ──
  const armedSpan = spans[picker.armed];
  const tipBar =
    dragging !== null
      ? -1
      : hover !== null
      ? hover.role.kind === "draw"
        ? hover.bar
        : -1
      : keyTip && armedSpan !== null
      ? armedSpan.s
      : -1;
  const tipSides: Side[] =
    tipBar < 0
      ? []
      : (["a", "b"] as const).filter((s) =>
          inRange(picker.sel[s], bars[tipBar].start, bars[tipBar].last)
        );
  const placeRight = tipBar < n * 0.55;
  const tipAnchor =
    tipBar < 0
      ? null
      : {
          getBoundingClientRect: () => {
            const r = svgRef.current?.getBoundingClientRect();
            const far =
              ghostSpan === null
                ? null
                : placeRight
                ? ghostSpan.x1
                : ghostSpan.x0;
            const x = placeRight
              ? Math.max(X(tipBar + 1), far ?? 0)
              : Math.min(X(tipBar), far ?? Infinity);
            const left = (r?.left ?? 0) + x;
            const top = (r?.top ?? 0) + plotTop;
            return new DOMRect(left, top, 0, 0);
          },
        };
  const click =
    ghost !== null && ghostSide !== null
      ? `Click: ${ghostSide.toUpperCase()} → ${rangeText(ghost, false)}`
      : null;

  // ── marks ──
  const paper = theme.palette.background.paper;
  const faded = dark ? 0.26 : 0.2;
  const hatchColor = theme.palette.grey[500];
  const drawOrder =
    focus === null
      ? stacks.keys.map((_, k) => k)
      : [focus, ...stacks.keys.map((_, k) => k).filter((k) => k !== focus)];
  const gap = barW >= 4 ? 1 : 0;
  const usd = stacks.unit === "usd";

  const barMarks = bars.map((bar, i) => {
    const inBand =
      inRange(picker.sel.a, bar.start, bar.last) ||
      inRange(picker.sel.b, bar.start, bar.last);
    const underGhost =
      ghostSpan !== null && i >= ghostSpan.s && i <= ghostSpan.e;
    const opacity = inBand ? 1 : underGhost ? 0.8 : 0.5;
    const bx = X(i) + (slot - barW) / 2;
    const total = stacks.total[i];
    const segs: ReactNode[] = [];
    let cum = 0;
    const visible = drawOrder.filter((k) => stacks.value[k][i] > 0);
    visible.forEach((k, j) => {
      const v = stacks.value[k][i];
      const y0 = Y(cum);
      const y1 = Y(cum + v);
      cum += v;
      const fill = paintFill(theme, stacks.keys[k].paint);
      const top = j === visible.length - 1;
      const h = Math.max(0, y0 - y1 - (top ? 0 : gap));
      const yTop = y0 - h;
      const r = top ? Math.min(3, barW / 2, h) : 0;
      const d =
        r > 0
          ? `M${bx},${y0}V${yTop + r}Q${bx},${yTop} ${bx + r},${yTop}H${
              bx + barW - r
            }Q${bx + barW},${yTop} ${bx + barW},${yTop + r}V${y0}Z`
          : `M${bx},${y0}V${yTop}H${bx + barW}V${y0}Z`;
      segs.push(
        <path
          key={k}
          d={d}
          fill={fill.hatch ? `url(#${id}-hatch)` : fill.color}
          opacity={
            // The grey rest under a hovered row is already muted.
            focus !== null &&
            k !== focus &&
            stacks.keys[k].paint.kind !== "pale"
              ? faded
              : 1
          }
        />
      );
    });
    const partial = isPartialBar(bar) && bar.data > 0 && total > 0;
    const stub = usd && bar.data > 0 && stacks.pricedDays[i] === 0;
    return (
      <g key={bar.start} opacity={opacity}>
        {segs}
        {partial && (
          <path
            d={`M${bx - 1},${plotBottom}V${Y(total) - 1}H${
              bx + barW + 1
            }V${plotBottom}`}
            fill="none"
            stroke={theme.palette.text.secondary}
            strokeWidth={1}
            strokeDasharray="3 2"
          />
        )}
        {stub && (
          <rect
            x={bx}
            y={plotBottom - 5}
            width={barW}
            height={5}
            fill={`url(#${id}-gap)`}
          />
        )}
      </g>
    );
  });

  const bandMarks = (["a", "b"] as const).map((s) => {
    const span = spans[s];
    if (span === null) return null;
    const color = sideColor(theme, s);
    return (
      <g key={s}>
        <rect
          x={span.x0}
          y={0}
          width={span.x1 - span.x0}
          height={plotBottom}
          fill={alpha(color, dark ? 0.14 : 0.08)}
        />
        <rect
          x={span.x0}
          y={plotTop}
          width={span.x1 - span.x0}
          height={2}
          fill={color}
        />
      </g>
    );
  });

  // A band's average line, only over two bars or more: over one bar it is
  // that bar's own top and says nothing.
  const avgMarks = (["a", "b"] as const).map((s) => {
    const span = spans[s];
    const v = tabs[s].value;
    if (span === null || v === null || v <= 0 || span.e <= span.s) return null;
    return (
      <line
        key={s}
        x1={span.x0 + 1}
        x2={span.x1 - 1}
        y1={Y(v)}
        y2={Y(v)}
        stroke={sideColor(theme, s)}
        strokeWidth={2}
      />
    );
  });

  const tabMarks = (["a", "b"] as const).map((s) => {
    const box = tabBoxes[s];
    if (box === null) return null;
    const sliding = dragging?.kind === "tab" && dragging.side === s;
    const hot = hover?.role.kind === "tab" && hover.role.side === s;
    return (
      <Tooltip
        key={s}
        open={tabTip === s && dragging === null}
        title={
          tabs[s].title ??
          `${s.toUpperCase()} · ${rangeText(picker.sel[s], false)}`
        }
        placement="top"
        disableInteractive
        disableHoverListener
        disableFocusListener
        disableTouchListener
      >
        <g style={{ cursor: sliding ? "grabbing" : "grab" }}>
          <rect
            x={box.x}
            y={2}
            width={box.w}
            height={TAB_H - 4}
            rx={3}
            fill={sideColor(theme, s)}
          />
          <text
            x={box.x + 7}
            y={TAB_H - 6}
            fontSize={11}
            fontWeight={700}
            fill={sideText(theme, s)}
          >
            {tabTexts[s]}
          </text>
          {(hot || sliding) && (
            <text
              x={box.x + box.w - 9}
              y={TAB_H - 6}
              fontSize={10}
              fill={sideText(theme, s)}
              opacity={0.8}
            >
              ⋮
            </text>
          )}
        </g>
      </Tooltip>
    );
  });

  // Edge knobs: hidden at rest, shown while the pointer is over the chart.
  const showKnobs = hover !== null || dragging !== null;
  const knobMarks = (["a", "b"] as const).flatMap((s) => {
    const span = spans[s];
    if (span === null || !showKnobs) return [];
    const color = sideColor(theme, s);
    const mid = (plotTop + plotBottom) / 2;
    return (["from", "to"] as const)
      .filter((edge) => edge === "to" || !span.clipped)
      .map((edge) => {
        const hot =
          (hover?.role.kind === "edge" &&
            hover.role.side === s &&
            hover.role.edge === edge) ||
          (dragging?.kind === "edge" &&
            dragging.side === s &&
            dragging.edge === edge);
        const ex = edge === "from" ? span.x0 : span.x1;
        const w = hot ? 6 : 4;
        const h = hot ? 36 : 24;
        return (
          <g key={`${s}-${edge}`}>
            {hot && (
              <rect
                x={ex - 1}
                y={plotTop}
                width={2}
                height={PLOT_H}
                fill={color}
              />
            )}
            <rect
              x={edge === "from" ? ex + 1 : ex - w - 1}
              y={mid - h / 2}
              width={w}
              height={h}
              rx={2}
              fill={color}
              opacity={hot ? 1 : 0.8}
            />
          </g>
        );
      });
  });

  const ghostMark =
    ghostSpan === null || ghostSide === null ? null : (
      <g pointerEvents="none">
        <rect
          x={ghostSpan.x0 + 1}
          y={plotTop + 1}
          width={ghostSpan.x1 - ghostSpan.x0 - 2}
          height={PLOT_H - 2}
          fill="none"
          stroke={sideColor(theme, ghostSide)}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        <rect
          x={ghostSpan.x0 + 1}
          y={plotTop + 1}
          width={14}
          height={14}
          rx={2}
          fill={sideColor(theme, ghostSide)}
          opacity={0.85}
        />
        <text
          x={ghostSpan.x0 + 4.5}
          y={plotTop + 12}
          fontSize={10}
          fontWeight={700}
          fill={sideText(theme, ghostSide)}
        >
          {ghostSide.toUpperCase()}
        </text>
      </g>
    );

  // Days of a strip span tinted on the bars (rate strip hover).
  const dayX = (day: Day) => {
    const i = Math.min(n - 1, barIndex(day));
    const bar = bars[i];
    const off =
      (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${bar.start}T00:00:00Z`)) /
      86_400_000;
    return X(i) + (slot * Math.max(0, off)) / bar.calendar;
  };
  const tint =
    hoverSpan === null || n === 0 || hoverSpan.to < bars[0].start ? null : (
      <rect
        x={dayX(
          hoverSpan.from < bars[0].start ? bars[0].start : hoverSpan.from
        )}
        y={plotTop}
        width={Math.max(
          1,
          dayX(hoverSpan.to) +
            slot / bars[barIndex(hoverSpan.to)].calendar -
            dayX(
              hoverSpan.from < bars[0].start ? bars[0].start : hoverSpan.from
            )
        )}
        height={PLOT_H}
        fill={alpha(theme.palette.text.primary, 0.08)}
        pointerEvents="none"
      />
    );

  // ── axis ──
  const labelEvery = (() => {
    if (folded.rollup === "day" && n > 20) return "monday";
    return Math.max(1, Math.ceil(n / 10));
  })();
  const labeled = (i: number) =>
    labelEvery === "monday"
      ? new Date(`${bars[i].start}T00:00:00Z`).getUTCDay() === 1
      : i % labelEvery === 0;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const axisLabel = (i: number) => {
    const day = bars[i].start;
    if (folded.rollup !== "month") return dayLabel(day);
    const m = Number(day.slice(5, 7)) - 1;
    return m === 0 ? `${MONTHS[m]} ${day.slice(0, 4)}` : MONTHS[m];
  };

  const cursor =
    dragging?.kind === "draw"
      ? "col-resize"
      : dragging?.kind === "edge" || hover?.role.kind === "edge"
      ? "ew-resize"
      : dragging?.kind === "tab"
      ? "grabbing"
      : hover?.role.kind === "tab"
      ? "grab"
      : "pointer";
  const muted = theme.palette.text.secondary;

  return (
    <Box
      ref={boxRef}
      role="group"
      aria-roledescription="period picker"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setKeyTip(false)}
      sx={{
        position: "relative",
        outline: "none",
        borderRadius: "4px",
        "&:focus-visible": {
          boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.5)}`,
        },
        "@media (prefers-reduced-motion: no-preference)": {
          "& svg path, & svg rect": { transition: "opacity 120ms" },
        },
      }}
    >
      <svg
        ref={svgRef}
        data-bars={n}
        width="100%"
        height={plotBottom + 6}
        style={{
          display: "block",
          cursor,
          touchAction: "pan-y",
          userSelect: "none",
          opacity: dimmed ? 0.5 : 1,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
        onPointerLeave={() => {
          if (drag.current === null) setHover(null);
        }}
      >
        <defs>
          <pattern
            id={`${id}-hatch`}
            patternUnits="userSpaceOnUse"
            width={4}
            height={4}
            patternTransform="rotate(45)"
          >
            <rect width={4} height={4} fill={paper} />
            <rect width={2} height={4} fill={hatchColor} />
          </pattern>
          <pattern
            id={`${id}-gap`}
            patternUnits="userSpaceOnUse"
            width={4}
            height={4}
            patternTransform="rotate(45)"
          >
            <rect width={2} height={4} fill={theme.palette.text.disabled} />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={GUTTER}
              x2={GUTTER + plotW}
              y1={Y(t)}
              y2={Y(t)}
              stroke={theme.palette.divider}
              strokeWidth={1}
            />
            <text
              x={GUTTER - 6}
              y={Y(t) + 4}
              fontSize={11}
              textAnchor="end"
              fill={muted}
            >
              {amountLabel(costUnit(stacks.unit), t).replace("<1 h", "0")}
            </text>
          </g>
        ))}
        {bandMarks}
        {tint}
        <g pointerEvents="none">{barMarks}</g>
        {ghostMark}
        <g pointerEvents="none">{avgMarks}</g>
        {knobMarks}
        {tabMarks}
        {folded.clipped && folded.dataStart !== null && (
          <text
            x={GUTTER + 4}
            y={plotTop + 14}
            fontSize={11}
            fill={muted}
            stroke={paper}
            strokeWidth={3}
            paintOrder="stroke"
            pointerEvents="none"
          >
            Data starts {dayLabel(folded.dataStart)}
          </text>
        )}
        {preview && (
          <rect
            x={GUTTER + 0.5}
            y={plotTop + 0.5}
            width={plotW - 1}
            height={PLOT_H - 1}
            fill="none"
            stroke={muted}
            strokeDasharray="5 4"
            pointerEvents="none"
          />
        )}
      </svg>
      {offPills.map((s) => {
        const r = picker.sel[s];
        const beforeData = folded.dataStart !== null && r.to < folded.dataStart;
        const title = beforeData
          ? `${s.toUpperCase()} · ${rangeText(
              r,
              false
            )} is before the data starts (${dayLabel(
              folded.dataStart!
            )}); history before then is not tracked yet`
          : `${s.toUpperCase()} · ${rangeText(
              r,
              false
            )} is off the chart · show it`;
        return (
          <Tooltip key={s} title={title} enterDelay={600}>
            <ButtonBase
              onClick={beforeData ? undefined : () => props.onWiden(s)}
              aria-disabled={beforeData || undefined}
              sx={{
                position: "absolute",
                left: offLeft[s],
                top: 1,
                px: 0.75,
                height: TAB_H - 2,
                borderRadius: "9px",
                fontSize: 11,
                fontWeight: 600,
                color: sideText(theme, s),
                backgroundColor: sideColor(theme, s),
                opacity: beforeData ? 0.7 : 0.9,
                cursor: beforeData ? "default" : "pointer",
              }}
            >
              {offText(s)}
            </ButtonBase>
          </Tooltip>
        );
      })}
      {strip !== null && strip !== undefined && strip !== false && (
        <Box sx={{ display: "flex", mr: `${RIGHT}px` }}>
          <Box
            aria-hidden
            sx={{
              flex: "none",
              width: GUTTER,
              pr: "6px",
              boxSizing: "border-box",
              textAlign: "right",
              fontSize: 11,
              lineHeight: "14px",
              color: "text.secondary",
            }}
          >
            rates
          </Box>
          <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>{strip}</Box>
        </Box>
      )}
      <svg
        width="100%"
        height={AXIS_H}
        style={{ display: "block" }}
        aria-hidden
      >
        {bars.map((bar, i) => {
          const note = daysNote(bar);
          const cx = X(i) + slot / 2;
          return (
            <g key={bar.start}>
              {labeled(i) && (
                <text
                  x={cx}
                  y={13}
                  fontSize={11}
                  textAnchor="middle"
                  fill={muted}
                >
                  {axisLabel(i)}
                </text>
              )}
              {note !== null && (
                <text
                  x={cx}
                  y={27}
                  fontSize={10}
                  textAnchor="middle"
                  fill={muted}
                  fontStyle="italic"
                >
                  {note.replace(" days", "").replace(" so far", "")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <TrendTooltip
        open={tipBar >= 0}
        anchor={tipAnchor}
        placement={placeRight ? "right-start" : "left-start"}
        folded={folded}
        stacks={stacks}
        bar={tipBar}
        sides={tipSides}
        click={click}
        pricer={pricer}
      />
    </Box>
  );
}
