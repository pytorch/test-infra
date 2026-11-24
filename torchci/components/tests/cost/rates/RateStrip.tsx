import { Box, Tooltip, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import {
  addDays,
  type Day,
  type Pricer,
  type RateDayKind,
  type RateStripProps,
  type StripGeometry,
} from "lib/api/tests/cost/contracts";
import { hatch } from "lib/tests/cost/colors";
import { hoursLabel, rateLabel } from "lib/tests/cost/query";
import {
  dayLabel,
  daySpanLabel,
  periodLabel,
} from "lib/tests/cost/ratePeriods";
import { headerBandColor, headerRuleColor } from "lib/tests/headerColors";
import { useEffect, useMemo, useRef, useState } from "react";

// A thin row under the trend bars in $ mode, one segment per
// rate period of the file (provisional ones dashed "prov.") and gaps hatched
// "no rates": days no period lists, after the file's end included. On the
// bars' own day axis.
// The segments are the file's and never move with the trail; their $/h
// labels come from priceSpan, so they follow the bars' scope and per.

export const STRIP_HEIGHT = 14;
// Read by screen readers, never seen (the strip itself is aria-hidden).
// Sizes are strings: MUI reads a bare 1 as 100%.
export const VISUALLY_HIDDEN = {
  position: "absolute",
  width: "1px",
  height: "1px",
  m: "-1px",
  p: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;
// Caption text at 11 px: about this many px a character, plus padding.
const CHAR_PX = 6.1;
const LABEL_PAD = 8;

export interface StripSegment {
  from: Day;
  to: Day; // clipped to the drawn days
  kind: RateDayKind;
  period: number | null;
  left: number; // 0..1 of the strip's width
  width: number;
  usd: number;
  hours: number;
  unpriced: number;
  rate: number | null; // $ ÷ priced hours in view
  labels: string[]; // candidates, the first that fits wins
  title: string; // the tooltip's first line
  lines: string[]; // the tooltip's other lines
  spoken: string; // the visually hidden list's item
}

const dayMs = (day: Day) => Date.parse(`${day}T00:00:00Z`);

// Where a day's left edge sits, 0..1: bar i spans [i, i+1)/n and its days
// divide it evenly.
function dayX(bars: StripGeometry["bars"]): (_day: Day) => number {
  const n = bars.length;
  const starts = bars.map((b) => dayMs(b.start));
  return (day: Day) => {
    const t = dayMs(day);
    if (n === 0 || t <= starts[0]) return 0;
    for (let i = 0; i < n; i++) {
      const offset = (t - starts[i]) / 86_400_000;
      if (offset < bars[i].days) return (i + offset / bars[i].days) / n;
    }
    return 1;
  };
}

// The first label that fits px, or null.
export function fitLabel(
  candidates: readonly string[],
  px: number
): string | null {
  return candidates.find((c) => c.length * CHAR_PX + LABEL_PAD <= px) ?? null;
}

// The strip's segments: the file's periods and gaps over the days the bars
// draw, from the first day the bars' scope has hours (days before the data
// draw nothing) through `last`.
export function stripModel(
  pricer: Pricer,
  geometry: Pick<StripGeometry, "bars" | "last" | "priceSpan">
): StripSegment[] {
  const { bars, last, priceSpan } = geometry;
  const set = pricer.set;
  if (set.legacy || bars.length === 0) return [];
  const first = bars[0].start;
  const end = bars[bars.length - 1];
  const lastDrawn = addDays(end.start, end.days - 1);
  const to = last < lastDrawn ? last : lastDrawn;
  if (to < first) return [];
  // The first day with hours: hours from `first` through a day only grow, so
  // a binary search asks priceSpan about log2(days) times.
  const days = Math.round((dayMs(to) - dayMs(first)) / 86_400_000) + 1;
  if (priceSpan({ from: first, to }).hours <= 0) return [];
  let lo = 0;
  let hi = days - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (priceSpan({ from: first, to: addDays(first, mid) }).hours > 0) hi = mid;
    else lo = mid + 1;
  }
  const from = addDays(first, lo);
  const x = dayX(bars);
  return pricer.segments({ from, to }).map((s) => {
    const span = priceSpan({ from: s.from, to: s.to });
    const pricedHours = span.hours - span.unpriced;
    const rate = pricedHours > 0 ? span.usd / pricedHours : null;
    const r = rate === null ? null : rateLabel(rate);
    const days = daySpanLabel(s.from, s.to);
    const rateLine =
      r === null
        ? "No priced hours in view"
        : `${r} over ${hoursLabel(pricedHours)} h in view`;
    const unpricedLine =
      span.unpriced >= 0.5
        ? `${hoursLabel(span.unpriced)} h on labels without a rate`
        : null;
    let labels: string[];
    let title: string;
    let lines: (string | null)[];
    let spoken: string;
    if (s.kind === "gap") {
      labels = ["no rates"];
      title = `No rates · ${days}`;
      lines = [
        "Not in the rates file: only the days it lists are priced.",
        span.hours >= 0.5
          ? `${hoursLabel(span.hours)} h unpriced, left out of $`
          : "Left out of $",
      ];
      spoken = `${days}, no rates`;
    } else {
      const p = set.periods[s.period!];
      const name = periodLabel(set, s.period!);
      const provisional = s.kind === "provisional";
      labels =
        r === null
          ? [provisional ? `${name} prov.` : name, dayLabel(s.from)]
          : provisional
          ? [`${name} · ${r} prov.`, `${r} prov.`, r, "prov."]
          : [`${name} · ${r}`, r, dayLabel(s.from)];
      title = `${name} rates${
        provisional
          ? " · provisional"
          : p.status === null && set.metaFile !== null
          ? " · no status"
          : ""
      }`;
      lines = [
        `From ${set.file}${
          p.window === null
            ? ""
            : ` · made from ${daySpanLabel(p.window.start, p.window.end)}`
        }`,
        rateLine,
        unpricedLine,
      ];
      spoken = `${days}, ${name} rates${provisional ? ", provisional" : ""}${
        r === null ? "" : `, ${r.replace("/h", " per hour")}`
      }`;
    }
    const left = x(s.from);
    return {
      from: s.from,
      to: s.to,
      kind: s.kind,
      period: s.period,
      left,
      width: x(addDays(s.to, 1)) - left,
      usd: span.usd,
      hours: span.hours,
      unpriced: span.unpriced,
      rate,
      labels,
      title,
      lines: lines.filter((l): l is string => l !== null),
      spoken,
    };
  });
}

// The strip fills its container's width, which must be the plot's (no
// y-axis gutter) unless `gutter` px are given for a "rates" caption.
export default function RateStrip({
  pricer,
  bars,
  last,
  priceSpan,
  onHoverSpan,
  gutter = 0,
}: RateStripProps & { gutter?: number }) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width)
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const segments = useMemo(
    () => stripModel(pricer, { bars, last, priceSpan }),
    [pricer, bars, last, priceSpan]
  );
  if (pricer.set.legacy) return null;

  const rule = headerRuleColor(theme);
  const dashed = `1px dashed ${theme.palette.text.secondary}`;
  const look = (kind: RateDayKind) => {
    switch (kind) {
      case "provisional":
        return {
          backgroundColor: alpha(headerBandColor(theme), 0.6),
          border: dashed,
        };
      case "gap":
        return {
          backgroundImage: hatch(
            alpha(theme.palette.text.primary, dark ? 0.3 : 0.24)
          ),
          border: `1px solid ${rule}`,
        };
      default:
        return {
          backgroundColor: headerBandColor(theme),
          border: `1px solid ${rule}`,
        };
    }
  };
  const leave = () => {
    setHovered(null);
    onHoverSpan(null);
  };
  return (
    <Box sx={{ display: "flex", alignItems: "stretch" }}>
      {gutter > 0 && (
        <Box
          aria-hidden
          sx={{
            flex: "none",
            width: gutter,
            pr: 0.75,
            textAlign: "right",
            fontSize: 11,
            lineHeight: `${STRIP_HEIGHT}px`,
            color: "text.secondary",
          }}
        >
          rates
        </Box>
      )}
      <Box
        ref={ref}
        aria-hidden
        onMouseLeave={leave}
        sx={{ position: "relative", flex: "1 1 auto", height: STRIP_HEIGHT }}
      >
        {segments.map((s, i) => {
          const label = fitLabel(s.labels, s.width * width - 2);
          return (
            <Tooltip
              key={`${s.from}:${s.kind}`}
              enterDelay={300}
              enterNextDelay={300}
              disableInteractive
              placement="top"
              title={
                <Box sx={{ fontSize: 12, lineHeight: 1.45 }}>
                  <Box sx={{ fontWeight: 600 }}>{s.title}</Box>
                  {s.lines.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </Box>
              }
            >
              <Box
                onMouseEnter={() => {
                  setHovered(i);
                  onHoverSpan({ from: s.from, to: s.to });
                }}
                sx={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: `${s.left * 100}%`,
                  // A hairline apart, so neighbours read as two periods.
                  width: `calc(${s.width * 100}% - 1px)`,
                  boxSizing: "border-box",
                  borderRadius: "2px",
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  ...look(s.kind),
                  ...(hovered === i
                    ? { borderColor: theme.palette.text.primary }
                    : {}),
                }}
              >
                {label !== null && (
                  <Box
                    component="span"
                    sx={{
                      px: "3px",
                      fontSize: 11,
                      lineHeight: "12px",
                      whiteSpace: "nowrap",
                      color: "text.secondary",
                      ...(s.kind === "gap"
                        ? {
                            backgroundColor: theme.palette.background.paper,
                            borderRadius: "2px",
                          }
                        : {}),
                    }}
                  >
                    {label}
                  </Box>
                )}
              </Box>
            </Tooltip>
          );
        })}
      </Box>
      <Box component="ul" sx={VISUALLY_HIDDEN}>
        {segments.map((s) => (
          <li key={`${s.from}:${s.kind}`}>{s.spoken}</li>
        ))}
      </Box>
    </Box>
  );
}
