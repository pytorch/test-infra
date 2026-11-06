import { Box, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { paleColor } from "lib/tests/cost/colors";
import { fineAmountLabel } from "lib/tests/cost/query";
import { niceTicks } from "lib/tests/cost/ticks";
import {
  axisPeriods,
  isPartial,
  periodLabel,
  type PeriodRange,
  periodTitle,
  type PreparedTrend,
  type TrendSeries,
} from "lib/tests/cost/trend";
import { type PointerEvent, useRef, useState } from "react";

const PLOT_HEIGHT = 180;
const AXIS_WIDTH = 56;

export interface TrendChartProps {
  prepared: PreparedTrend;
  series: TrendSeries;
  // Owners are highlighted: their part of each bar is solid, the rest pale.
  highlighting: boolean;
  a: PeriodRange | null;
  b: PeriodRange | null;
  onRangeChange: (_which: "a" | "b", _range: PeriodRange) => void;
}

// The trend's bars, a period each, on the scale of the largest bar: the
// highlighted owners' part solid and the rest pale while owners are
// highlighted, and a period without every day of data faded with its days
// in its tooltip. Bars keep a gap at every count; past 20 days the axis labels Mondays. A and B are
// boxes behind the bars: dragging across the bars sets B, and with Shift
// held, A; a click sets one period.
export default function TrendChart({
  prepared,
  series,
  highlighting,
  a,
  b,
  onRangeChange,
}: TrendChartProps) {
  const theme = useTheme();
  const plot = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    which: "a" | "b";
    anchor: number;
    current: number;
  } | null>(null);
  const n = prepared.periods.length;
  const unit = series.unit;
  const ticks = niceTicks(Math.max(0, ...Array.from(series.value)));
  const axisMax = ticks[ticks.length - 1];
  const at = (event: PointerEvent) => {
    const rect = plot.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return 0;
    const i = Math.floor(((event.clientX - rect.left) / rect.width) * n);
    return Math.min(n - 1, Math.max(0, i));
  };
  const shown = (which: "a" | "b") =>
    drag?.which === which
      ? {
          from: Math.min(drag.anchor, drag.current),
          to: Math.max(drag.anchor, drag.current),
        }
      : which === "a"
      ? a
      : b;
  const box = (which: "a" | "b") => {
    const r = shown(which);
    if (r === null) return null;
    const color =
      which === "a" ? theme.palette.text.secondary : theme.palette.primary.main;
    return (
      <Box
        key={which}
        aria-hidden
        sx={{
          position: "absolute",
          top: -14,
          bottom: 0,
          left: `${(100 * r.from) / n}%`,
          width: `${(100 * (r.to - r.from + 1)) / n}%`,
          border: `1.5px solid ${color}`,
          borderRadius: "3px",
          backgroundColor: alpha(color, 0.08),
          pointerEvents: "none",
        }}
      >
        <Box
          component="span"
          sx={{
            position: "absolute",
            top: 0,
            left: 4,
            fontSize: "0.7rem",
            fontWeight: 600,
            lineHeight: "14px",
            color,
          }}
        >
          {which.toUpperCase()}
        </Box>
      </Box>
    );
  };
  const labelled = new Set(axisPeriods(prepared));
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: `${AXIS_WIDTH}px minmax(0, 1fr)`,
        columnGap: 1,
        pt: 2,
      }}
    >
      <Box sx={{ position: "relative", height: PLOT_HEIGHT }}>
        {ticks.map((t) => (
          <Typography
            key={t}
            variant="caption"
            sx={{
              position: "absolute",
              right: 0,
              bottom: `${(100 * t) / axisMax}%`,
              transform: "translateY(50%)",
              color: "text.secondary",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {t === 0 ? "0" : fineAmountLabel(unit, t)}
          </Typography>
        ))}
      </Box>
      {/* A plain element takes the pointer and is measured: its box is the
          plot's. */}
      <div
        ref={plot}
        role="group"
        aria-label="Trend bars: drag across them to set B, or Shift-drag to set A"
        onPointerDown={(event) => {
          if (event.button !== 0 || n === 0) return;
          const i = at(event);
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrag({ which: event.shiftKey ? "a" : "b", anchor: i, current: i });
        }}
        onPointerMove={(event) => {
          if (drag !== null) setDrag({ ...drag, current: at(event) });
        }}
        onPointerUp={() => {
          if (drag === null) return;
          onRangeChange(drag.which, {
            from: Math.min(drag.anchor, drag.current),
            to: Math.max(drag.anchor, drag.current),
          });
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        style={{
          cursor: "crosshair",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <Box
          sx={{
            position: "relative",
            height: PLOT_HEIGHT,
            display: "grid",
            gridTemplateColumns: `repeat(${Math.max(n, 1)}, minmax(0, 1fr))`,
            alignItems: "end",
            backgroundImage: `linear-gradient(${theme.palette.divider}, ${theme.palette.divider})`,
            backgroundSize: "100% 1px",
            backgroundPosition: "bottom",
            backgroundRepeat: "no-repeat",
          }}
        >
          {ticks.slice(1).map((t) => (
            <Box
              key={t}
              aria-hidden
              sx={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: `${(100 * t) / axisMax}%`,
                borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
                pointerEvents: "none",
              }}
            />
          ))}
          {box("a")}
          {box("b")}
          {prepared.periods.map((_, i) => {
            const value = series.value[i];
            const lit = series.highlighted[i];
            const partial = isPartial(prepared, i);
            const title = [
              `${periodTitle(prepared, i)}: ${fineAmountLabel(unit, value)}`,
              highlighting ? `highlighted: ${fineAmountLabel(unit, lit)}` : "",
              prepared.periodData[i] < prepared.periodDays[i]
                ? `${prepared.periodData[i]} of ${
                    prepared.periodDays[i]
                  } days ${prepared.periodData[i] === 1 ? "has" : "have"} data`
                : "",
              prepared.periodFilling[i] ? "incomplete, jobs still running" : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Box
                key={i}
                title={title}
                sx={{
                  position: "relative",
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-end",
                  px: "15%",
                  opacity: partial ? 0.5 : 1,
                }}
              >
                {highlighting && value - lit > 0 && (
                  <Box
                    sx={{
                      height: `${(100 * (value - lit)) / axisMax}%`,
                      backgroundColor: paleColor(theme),
                      borderRadius: lit > 0 ? "2px 2px 0 0" : "2px",
                    }}
                  />
                )}
                {(highlighting ? lit : value) > 0 && (
                  <Box
                    sx={{
                      height: `${
                        (100 * (highlighting ? lit : value)) / axisMax
                      }%`,
                      backgroundColor: theme.palette.primary.main,
                      borderRadius:
                        highlighting && value - lit > 0 ? 0 : "2px 2px 0 0",
                    }}
                  />
                )}
              </Box>
            );
          })}
        </Box>
      </div>
      <span />
      <Box
        aria-hidden
        sx={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.max(n, 1)}, minmax(0, 1fr))`,
          mt: 0.5,
        }}
      >
        {prepared.periods.map((_, i) => (
          <Typography
            key={i}
            variant="caption"
            sx={{
              color: "text.secondary",
              whiteSpace: "nowrap",
              overflow: "visible",
              textAlign: "left",
            }}
          >
            {labelled.has(i) ? periodLabel(prepared, i) : ""}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
