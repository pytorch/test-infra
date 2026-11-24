import { Box, Skeleton, Tooltip, Typography, useTheme } from "@mui/material";
import { red } from "@mui/material/colors";
import { alpha, type Theme } from "@mui/material/styles";
import {
  NO_OWNER,
  NO_TEST_REPORTS,
  type ScopeBy,
  type Unit,
  UNKNOWN_MACHINE,
} from "lib/api/tests/cost/contracts";
import {
  hatch,
  machineHue,
  noOwnerColor,
  otherMachinesColor,
  ownerFill,
} from "lib/tests/cost/colors";
import {
  amount,
  arrowText,
  changeMetric,
  type ChangeScale,
  changeText,
  changeX,
  deltaText,
  type DrillRow,
  type HalfScale,
  segments,
  tickText,
  valueText,
} from "lib/tests/cost/drill";
import type { PreparedHours } from "lib/tests/cost/runnerHours";
import type { KeyboardEvent, ReactNode } from "react";

// The drill's colors, every one by the theme's mode: A in the live page's
// neutral grey, B in the accent, ▲ more hours in the error red and ▼ fewer in
// the success green. ghost is the green, faint, of what B lost against A: an
// absence, so quieter than the solid red of what it gained, and told apart
// from it by lightness as well as hue. upText is the red for text:
// a step darker in light and lighter in dark, so ▲ reads at 4.5:1 on the
// pill grey as ▼'s green does.
export function drillColors(theme: Theme) {
  const dark = theme.palette.mode === "dark";
  return {
    a: dark ? theme.palette.grey[500] : theme.palette.grey[600],
    b: theme.palette.primary.main,
    up: theme.palette.error.main,
    upText: dark ? red[200] : theme.palette.error.dark,
    down: dark ? theme.palette.success.light : theme.palette.success.dark,
    ghost: alpha(
      dark ? theme.palette.success.light : theme.palette.success.main,
      dark ? 0.26 : 0.22
    ),
    ghostEdge: alpha(
      dark ? theme.palette.success.light : theme.palette.success.dark,
      0.45
    ),
    grid: alpha(theme.palette.text.primary, dark ? 0.1 : 0.07),
    selected: alpha(theme.palette.primary.main, dark ? 0.16 : 0.08),
    hover: alpha(theme.palette.text.primary, dark ? 0.06 : 0.04),
    // A row opened in place: its children sit on a faint tint, over a
    // faint band of the parent's bar that ends in a thin edge.
    nest: alpha(theme.palette.primary.main, dark ? 0.04 : 0.025),
    track: alpha(theme.palette.text.primary, dark ? 0.08 : 0.055),
    trackEdge: alpha(theme.palette.text.primary, dark ? 0.45 : 0.38),
  };
}

// [A half | name | B half | change bar | Change | %]: name ~24% (room for
// the indent of rows opened in place and their keys), the change column
// ~27%.
export const BUTTERFLY_GRID =
  "minmax(0,25fr) minmax(0,24fr) minmax(0,25fr) minmax(0,11fr) minmax(0,8fr) minmax(0,8fr)";
// Room at each half's outer end for its value label.
const LABEL_W = 96;
const ROW_H = 26;
const NESTED_ROW_H = 24;
// A tree row's name: 8 px in, 16 px more a level, the caret's room kept
// on rows without one so names line up.
const INDENT_PX = 16;
const CARET_W = 10;
export const nameIndent = (depth: number) => 8 + depth * INDENT_PX;
const track = (f: number) => `calc((100% - ${LABEL_W}px) * ${f})`;

export function Swatch({ fill }: { fill: string | null | undefined }) {
  if (!fill) return null;
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        display: "inline-block",
        flex: "none",
        width: 10,
        height: 10,
        borderRadius: "2px",
        background: fill,
      }}
    />
  );
}

export function toneOf(v: number | null): "up" | "down" | null {
  if (v === null || Math.abs(v) < 1e-9) return null;
  return v > 0 ? "up" : "down";
}

// The change in its unit and in %, ▲ red or ▼ green.
export function ChangeTexts({
  row,
  unit,
  bold = false,
}: {
  row: DrillRow;
  unit: Unit;
  bold?: boolean;
}) {
  const theme = useTheme();
  const c = drillColors(theme);
  const tone = toneOf(row.delta);
  const color =
    tone === "up" ? c.upText : tone === "down" ? c.down : "text.secondary";
  return (
    <>
      <Box sx={{ ...num, color, fontWeight: bold ? 600 : 400 }}>
        {deltaText(unit, row.delta)}
      </Box>
      <Box sx={{ ...num, color, fontWeight: bold ? 600 : 400 }}>
        {changeText(row)}
      </Box>
    </>
  );
}

const num = {
  px: 0.75,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

function Gridlines({ scale, side }: { scale: HalfScale; side: "a" | "b" }) {
  const theme = useTheme();
  const c = drillColors(theme);
  return (
    <>
      {scale.ticks.map((t) => (
        <Box
          key={t}
          aria-hidden
          sx={{
            position: "absolute",
            top: 0,
            bottom: 0,
            width: "1px",
            backgroundColor: t === 0 ? theme.palette.divider : c.grid,
            [side === "a" ? "right" : "left"]: track(
              scale.top > 0 ? t / scale.top : 0
            ),
          }}
        />
      ))}
    </>
  );
}

// B's side as segments: kept solid in the accent, lost a faint green ghost
// out to where A ended, gained solid red, on a track of the given width.
export function BSegments({
  a,
  b,
  top,
  width = (f: number) => `${f * 100}%`,
  height = 10,
}: {
  a: number | null;
  b: number | null;
  top: number;
  width?: (_f: number) => string;
  height?: number;
}) {
  const theme = useTheme();
  const c = drillColors(theme);
  const s = segments(a, b, top);
  const bar = {
    position: "absolute",
    top: "50%",
    height,
    mt: `${-height / 2}px`,
  } as const;
  return (
    <>
      <Box sx={{ ...bar, left: 0, width: width(s.kept), bgcolor: c.b }} />
      {s.lost > 0 && (
        <Box
          sx={{
            ...bar,
            left: width(s.kept),
            width: width(s.lost),
            bgcolor: c.ghost,
            boxShadow: `inset 0 0 0 1px ${c.ghostEdge}`,
          }}
        />
      )}
      {s.gained > 0 && (
        <Box
          sx={{
            ...bar,
            left: width(s.kept),
            width: width(s.gained),
            bgcolor: c.up,
          }}
        />
      )}
    </>
  );
}

// A small A|B mark for a table cell (lanes, configurations): B's segments on
// a shared top.
export function MiniMark({
  a,
  b,
  top,
}: {
  a: number | null;
  b: number | null;
  top: number;
}) {
  return (
    <Box sx={{ position: "relative", height: 12, width: "100%" }}>
      <BSegments a={a} b={b} top={top} height={8} />
    </Box>
  );
}

export type RowKind = "row" | "selected" | "total" | "fold" | "more";

export interface ButterflyRowProps {
  row: DrillRow;
  kind: RowKind;
  scale: HalfScale;
  change: ChangeScale;
  chg: "h" | "pct";
  unit: Unit;
  per: "day" | "commit";
  swatch?: string | null;
  caret?: "open" | "closed" | null;
  label?: ReactNode; // in place of the row's name (fold line, "N more")
  tooltip?: ReactNode;
  onClick?: () => void;
  onHover?: (_on: boolean) => void;
  stale?: boolean; // a kept answer: numbers read "…"
  ariaLabel?: string;
  // The table's totals: each half's value then reads "11.8K h · 27%", its
  // share of that side's total (not on the total row itself). A row opened
  // in place passes its parent's, so its children read their share of it.
  totals?: { a: number | null; b: number | null };
  // A tree row (the drill table and canvas): the name left-aligned, indented
  // by depth; undefined keeps the name centered.
  depth?: number;
  // Beside the name: an open machine's Owners | Runners and the row's Drill in.
  actions?: ReactNode;
  // A child of a row opened in place: the parent's A and B as a faint band
  // behind its bars (on the same scale), the value labels just past it.
  parent?: { a: number | null; b: number | null } | null;
  expanded?: boolean; // aria-expanded on a row that opens in place
  title?: string; // the name's title in place of the default
}

// A share as the value labels write it: whole percent, "<1%" for a sliver.
function shareText(v: number | null, total: number | null): string {
  if (v === null || total === null || total <= 0) return "";
  const p = v / total;
  return ` · ${p > 0 && p < 0.01 ? "<1" : Math.round(p * 100)}%`;
}

// One row of the butterfly: A grows leftwards from the name, B
// rightwards with its change on B's side, then a diverging change bar and
// the change in the unit and in %. The total and fold lines carry numbers
// only.
export default function ButterflyRow({
  row,
  kind,
  scale,
  change,
  chg,
  unit,
  per,
  swatch,
  caret = null,
  label,
  tooltip,
  onClick,
  onHover,
  stale = false,
  ariaLabel,
  totals,
  depth,
  actions,
  parent = null,
  expanded,
  title,
}: ButterflyRowProps) {
  const theme = useTheme();
  const c = drillColors(theme);
  const bars = kind === "row" || kind === "selected";
  const s = segments(row.a, row.b, scale.top);
  const tree = depth !== undefined;
  const nested = tree && depth > 0;
  const barH = nested ? 8 : 10;
  const frac = (v: number | null) =>
    v === null || !(scale.top > 0)
      ? 0
      : Math.max(0, Math.min(1, v / scale.top));
  const band = bars && parent !== null && !stale;
  const bandA = band ? frac(parent.a) : 0;
  const bandB = band ? frac(parent.b) : 0;
  const notOnMain = per === "commit" && row.notOnMain && kind !== "total";
  const text = (v: number | null, approx: boolean) =>
    stale ? "…" : v === null ? "–" : `${approx ? "≈" : ""}${amount(unit, v)}`;
  const aText = stale
    ? "…"
    : row.a === null
    ? row.blankA
    : text(row.a, row.approxA);
  const bText = notOnMain
    ? "not on main"
    : row.b === null && !stale
    ? row.blankB
    : text(row.b, row.approxB);
  const showShare = totals !== undefined && kind !== "total" && !stale;
  const aShare = showShare ? shareText(row.a, totals.a) : "";
  const bShare = showShare && !notOnMain ? shareText(row.b, totals.b) : "";
  const metric = changeMetric(row, chg);
  const zero = change.zero;
  const x = changeX(change, metric);
  const tone = toneOf(metric);
  const strong = kind === "total" || kind === "selected";
  const valueSx = {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
    fontSize: theme.typography.caption.fontSize,
    color: kind === "fold" ? "text.secondary" : "text.primary",
    fontWeight: strong ? 600 : 400,
  } as const;
  const interactive = onClick !== undefined;
  const bandBox = {
    position: "absolute",
    top: "50%",
    height: 16,
    mt: "-8px",
    bgcolor: c.track,
  } as const;
  const content = (
    <Box
      role="row"
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      aria-current={kind === "selected" ? "true" : undefined}
      aria-expanded={expanded}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        onClick?.();
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (!interactive) return;
        if (e.key === "Enter" || e.key === " ") {
          if ((e.target as HTMLElement) !== e.currentTarget) return;
          e.preventDefault();
          onClick?.();
        }
      }}
      onMouseEnter={onHover ? () => onHover(true) : undefined}
      onMouseLeave={onHover ? () => onHover(false) : undefined}
      onFocus={onHover ? () => onHover(true) : undefined}
      onBlur={onHover ? () => onHover(false) : undefined}
      sx={{
        display: "grid",
        gridTemplateColumns: BUTTERFLY_GRID,
        alignItems: "center",
        minHeight: nested ? NESTED_ROW_H : ROW_H,
        typography: "body2",
        cursor: interactive ? "pointer" : "default",
        backgroundColor:
          kind === "selected" ? c.selected : nested ? c.nest : undefined,
        borderTop:
          kind === "total" || kind === "fold"
            ? `1px solid ${theme.palette.divider}`
            : undefined,
        borderBottom:
          kind === "total" ? `1px solid ${theme.palette.divider}` : undefined,
        "&:hover":
          interactive && kind !== "selected"
            ? { backgroundColor: c.hover }
            : undefined,
        "&:focus-visible": {
          outline: `2px solid ${theme.palette.primary.main}`,
          outlineOffset: -2,
        },
        // The row's "Drill in" key, one size everywhere: on open rows (a
        // reminder that the breadcrumb can go deeper) and on the row under
        // the pointer or holding keyboard focus; hidden (not faded) elsewhere.
        "& .drill-key": { visibility: expanded ? "visible" : "hidden" },
        "&:hover .drill-key, &:focus-within .drill-key": {
          visibility: "visible",
        },
      }}
    >
      {/* A half */}
      <Box role="cell" sx={{ position: "relative", alignSelf: "stretch" }}>
        {bars && <Gridlines scale={scale} side="a" />}
        {band && bandA > 0 && (
          <Box
            aria-hidden
            sx={{
              ...bandBox,
              right: 0,
              width: track(bandA),
              borderLeft: `1px solid ${c.trackEdge}`,
            }}
          />
        )}
        {bars && row.a !== null && !stale && (
          <Box
            sx={{
              position: "absolute",
              right: 0,
              top: "50%",
              height: barH,
              mt: `${-barH / 2}px`,
              width: track(s.a),
              bgcolor: c.a,
            }}
          />
        )}
        <Box
          sx={{
            ...valueSx,
            right: bars ? `calc(${track(Math.max(s.a, bandA))} + 4px)` : 8,
            color: row.a === null ? "text.disabled" : valueSx.color,
          }}
        >
          {aText}
          {aShare && (
            <Box component="span" sx={{ color: "text.secondary" }}>
              {aShare}
            </Box>
          )}
        </Box>
      </Box>
      {/* name */}
      <Box
        role="rowheader"
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: tree ? "flex-start" : "center",
          gap: tree ? 0.5 : 0.75,
          px: 1,
          pl: tree ? `${nameIndent(depth)}px` : undefined,
          pr: tree ? 0.5 : undefined,
          minWidth: 0,
          alignSelf: "stretch",
          borderLeft: `1px solid ${theme.palette.divider}`,
          borderRight: `1px solid ${theme.palette.divider}`,
          fontStyle: kind === "fold" ? "italic" : undefined,
          fontWeight: strong ? 600 : 400,
          color:
            kind === "fold" || kind === "more"
              ? "text.secondary"
              : "text.primary",
        }}
      >
        {(caret || tree) && (
          <Box
            component="span"
            aria-hidden
            sx={{
              color: "text.secondary",
              fontSize: 10,
              flex: "none",
              width: tree ? CARET_W : undefined,
              textAlign: "center",
            }}
          >
            {caret === "open" ? "▼" : caret === "closed" ? "▶" : ""}
          </Box>
        )}
        <Swatch fill={swatch} />
        <Box
          component="span"
          title={
            title ??
            (tooltip !== undefined
              ? undefined
              : typeof label === "string"
              ? label
              : row.detail
              ? `${row.detail}${row.name}`
              : row.name)
          }
          sx={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {label ?? row.name}
        </Box>
        {actions}
      </Box>
      {/* B half */}
      <Box role="cell" sx={{ position: "relative", alignSelf: "stretch" }}>
        {bars && <Gridlines scale={scale} side="b" />}
        {band && bandB > 0 && (
          <Box
            aria-hidden
            sx={{
              ...bandBox,
              left: 0,
              width: track(bandB),
              borderRight: `1px solid ${c.trackEdge}`,
            }}
          />
        )}
        {bars && !stale && !notOnMain && (
          <BSegments
            a={row.a}
            b={row.b}
            top={scale.top}
            width={track}
            height={barH}
          />
        )}
        <Box
          sx={{
            ...valueSx,
            left:
              bars && !notOnMain
                ? `calc(${track(Math.max(s.end, bandB))} + 4px)`
                : 8,
            color:
              notOnMain || row.b === null ? "text.disabled" : valueSx.color,
            fontStyle: notOnMain ? "italic" : undefined,
          }}
        >
          {bText}
          {bShare && (
            <Box component="span" sx={{ color: "text.secondary" }}>
              {bShare}
            </Box>
          )}
        </Box>
      </Box>
      {/* change bar */}
      <Box
        role="cell"
        sx={{ position: "relative", alignSelf: "stretch", mx: 0.5 }}
      >
        {bars && (
          <>
            <Box
              aria-hidden
              sx={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: `${zero * 100}%`,
                width: "1px",
                bgcolor: theme.palette.divider,
              }}
            />
            {!stale && tone && (
              <Box
                sx={{
                  position: "absolute",
                  top: "50%",
                  height: barH,
                  mt: `${-barH / 2}px`,
                  left: `${Math.min(zero, x) * 100}%`,
                  width: `${Math.abs(x - zero) * 100}%`,
                  bgcolor: tone === "up" ? c.up : c.down,
                }}
              />
            )}
          </>
        )}
      </Box>
      {stale ? (
        <>
          <Box sx={{ ...num, color: "text.disabled" }}>…</Box>
          <Box sx={{ ...num, color: "text.disabled" }}>…</Box>
        </>
      ) : notOnMain ? (
        <>
          <Box />
          <Box />
        </>
      ) : (
        <ChangeTexts row={row} unit={unit} bold={strong} />
      )}
    </Box>
  );
  if (tooltip === undefined || stale) return content;
  return (
    <Tooltip
      title={tooltip}
      enterDelay={600}
      enterNextDelay={300}
      placement="bottom-start"
      followCursor
    >
      {content}
    </Tooltip>
  );
}

// The axis row: tick labels on both halves and on the change column, none
// when no row has a value to measure.
export function AxisRow({
  scale,
  change,
  chg,
  unit,
}: {
  scale: HalfScale;
  change: ChangeScale;
  chg: "h" | "pct";
  unit: Unit;
}) {
  const theme = useTheme();
  const tick = {
    position: "absolute",
    top: 0,
    whiteSpace: "nowrap",
    fontSize: 11,
    color: "text.secondary",
    fontVariantNumeric: "tabular-nums",
  } as const;
  const ticks = scale.blank ? [] : scale.ticks;
  const changeTicks = scale.blank ? [] : change.ticks;
  return (
    <Box
      aria-hidden
      sx={{
        display: "grid",
        gridTemplateColumns: BUTTERFLY_GRID,
        height: 16,
        borderBottom: `1px solid ${theme.palette.divider}`,
      }}
    >
      <Box sx={{ position: "relative" }}>
        {ticks.map((t) => (
          <Box
            key={t}
            sx={{
              ...tick,
              right: track(scale.top > 0 ? t / scale.top : 0),
              transform: "translateX(50%)",
            }}
          >
            {tickText(t, "h", unit)}
          </Box>
        ))}
      </Box>
      <Box />
      <Box sx={{ position: "relative" }}>
        {ticks.map((t) => (
          <Box
            key={t}
            sx={{
              ...tick,
              left: track(scale.top > 0 ? t / scale.top : 0),
              transform: "translateX(-50%)",
            }}
          >
            {tickText(t, "h", unit)}
          </Box>
        ))}
      </Box>
      <Box sx={{ position: "relative", mx: 0.5 }}>
        {changeTicks.map((t) => (
          <Box
            key={t}
            sx={{
              ...tick,
              left: `${changeX(change, t) * 100}%`,
              transform: "translateX(-50%)",
            }}
          >
            {tickText(t, chg, unit)}
          </Box>
        ))}
      </Box>
      <Box />
      <Box />
    </Box>
  );
}

// What a row's tooltip says: A, B, change, kept and lost or gained,
// the share of its parent, the other per, co-owners.
export function rowTooltip(opts: {
  row: DrillRow;
  context: string;
  unit: Unit;
  per: "day" | "commit";
  parentB: number | null;
  parentName: string;
}): ReactNode {
  const { row, unit, per } = opts;
  const lines: [string, string][] = [
    ["A", valueText(unit, row.a, row.approxA)],
    ["B", valueText(unit, row.b, row.approxB)],
    ["Change", `${deltaText(unit, row.delta)} ${changeText(row)}`.trim()],
  ];
  if (row.a !== null && row.b !== null) {
    lines.push(["Kept", amount(unit, Math.min(row.a, row.b))]);
    if (row.a > row.b) lines.push(["Lost", amount(unit, row.a - row.b)]);
    if (row.b > row.a) lines.push(["Gained", amount(unit, row.b - row.a)]);
  }
  if (opts.parentB && row.b !== null) {
    lines.push([
      `Share of ${opts.parentName}`,
      `${Math.round((row.b / opts.parentB) * 100)}%`,
    ]);
  }
  lines.push([
    per === "day" ? "Per commit" : "Per day",
    row.notOnMain && per === "day"
      ? "not on main"
      : arrowText(unit, row.other.a, row.other.b, row.approxA, row.approxB),
  ]);
  if (row.info.coOwners && row.info.coOwners.length > 1) {
    lines.push(["Owners", `split evenly: ${row.info.coOwners.join(", ")}`]);
  }
  if (unit === "usd" && row.unpricedH > 0) {
    lines.push(["Unpriced", `${amount("hours", row.unpricedH)} not priced`]);
  }
  return (
    <Box sx={{ typography: "caption" }}>
      <Box sx={{ fontWeight: 600 }}>
        {row.detail && row.by === "f" ? `${row.detail}${row.name}` : row.name}
        {opts.context && (
          <Box component="span" sx={{ fontWeight: 400, opacity: 0.8 }}>
            {" "}
            · {opts.context}
          </Box>
        )}
      </Box>
      <Box component="table" sx={{ borderSpacing: "8px 0", ml: -1 }}>
        <tbody>
          {lines.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <Box
                component="td"
                sx={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
              >
                {v}
              </Box>
            </tr>
          ))}
        </tbody>
      </Box>
    </Box>
  );
}

// A row's swatch: a machine's hue as the bars paint it
// (Unknown machine grey stripes, the rest grey); an owner's hue where the
// rows are what the bars stack (namedOwners), else none.
export function swatchFor(
  theme: Theme,
  opts: {
    by: ScopeBy;
    key: string;
    prepared: PreparedHours | undefined;
    named: readonly string[] | null; // owners the bars name, when they stack owners
  }
): string | null {
  const { by, key, prepared, named } = opts;
  if (by === "m") {
    if (key === UNKNOWN_MACHINE) return hatch(theme.palette.grey[500]);
    const m = prepared?.machines.indexOf(key) ?? -1;
    return (
      (prepared && m >= 0 ? machineHue(theme, prepared, m) : undefined) ??
      otherMachinesColor(theme)
    );
  }
  if (by === "o" && named !== null) {
    if (key === NO_TEST_REPORTS) return hatch(theme.palette.grey[500]);
    if (key === NO_OWNER) return noOwnerColor(theme);
    const at = named.indexOf(key);
    return (
      (at >= 0 ? ownerFill(theme, at) : undefined) ?? otherMachinesColor(theme)
    );
  }
  return null;
}

const SKELETON_ROWS = 6;

// "Show fewer" under an expanded list: words only.
export function FewerRow({ onClick }: { onClick: () => void }) {
  return (
    <Box
      role="row"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        display: "grid",
        gridTemplateColumns: BUTTERFLY_GRID,
        minHeight: 26,
        alignItems: "center",
        typography: "body2",
        color: "text.secondary",
        cursor: "pointer",
      }}
    >
      <Box />
      <Box sx={{ pl: `${nameIndent(0) + CARET_W + 6}px` }}>Show fewer ▴</Box>
    </Box>
  );
}

// The band over a butterfly: what the rows are and their unit, "of" whose,
// then (in the table's band only) Change in [h|%] and Sort.
export function DrillBand({
  title,
  of,
  keys,
  small = false,
}: {
  title: string;
  of?: string;
  keys?: ReactNode;
  small?: boolean;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
        minHeight: 32,
      }}
    >
      <Typography
        variant="caption"
        component="h4"
        sx={{
          color: "text.secondary",
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          fontSize: small ? 11 : undefined,
        }}
      >
        {title}
      </Typography>
      {of && (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {of}
        </Typography>
      )}
      <Box sx={{ flex: 1 }} />
      {keys}
    </Box>
  );
}

export function SkeletonRows({ n = SKELETON_ROWS }: { n?: number }) {
  return (
    <Box aria-busy>
      {Array.from({ length: n }, (_, i) => (
        <Box key={i} sx={{ height: 26, display: "flex", alignItems: "center" }}>
          <Skeleton variant="rounded" height={12} sx={{ width: "100%" }} />
        </Box>
      ))}
    </Box>
  );
}
