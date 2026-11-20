import { Box, Paper, Popper, Typography, useTheme } from "@mui/material";
import {
  costUnit,
  type Per,
  type Pricer,
  type Unit,
} from "lib/api/tests/cost/contracts";
import { hatch } from "lib/tests/cost/colors";
import { daysNote, type Folded } from "lib/tests/cost/fold";
import { amountLabel, fineAmountLabel, shareLabel } from "lib/tests/cost/query";
import { pricingNotes } from "lib/tests/cost/ratePeriods";
import { ownerLabel } from "lib/tests/cost/runnerHours";
import { dayLabel, rangeText, type Side } from "lib/tests/cost/select";
import {
  barValue,
  keyMembers,
  paintFill,
  type Stacks,
} from "lib/tests/cost/stacks";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// A bar as the tooltip heads it: "Wed, Nov 18"; "Week of Nov 2 · Nov 2 – 8";
// "November 2026 · so far".
export function barTitle(folded: Folded, i: number): string {
  const bar = folded.bars[i];
  const d = new Date(`${bar.start}T00:00:00Z`);
  if (folded.rollup === "day") {
    return `${WEEKDAYS[d.getUTCDay()]}, ${dayLabel(bar.start)}`;
  }
  const soFar = bar.elapsed < bar.calendar ? " · so far" : "";
  if (folded.rollup === "week") {
    return `Week of ${dayLabel(bar.start)} · ${rangeText({
      from: bar.start,
      to: bar.last,
    })}${soFar}`;
  }
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}${soFar}`;
}

// A bar's value in its unit and per, as the tooltip heads it: Total is the
// bar's sum.
export function perLabel(unit: Unit, per: Per, value: number): string {
  const amount = fineAmountLabel(costUnit(unit), value);
  return per === "commit" ? `${amount} per commit` : amount;
}

export interface TrendTooltipProps {
  open: boolean;
  anchor: { getBoundingClientRect: () => DOMRect } | null;
  placement: "left-start" | "right-start";
  folded: Folded;
  stacks: Stacks;
  bar: number;
  sides: Side[]; // A and/or B hold this bar
  click: string | null; // "Click: B → Oct 23 – 29", only when a click would change it
  pricer?: Pricer | null; // $ mode: borrowed (≈) and provisional days
}

// The bars' hover breakdown: one card level with the plot top, the
// bar's every series in legend order with its value and share, "Other owners"
// with its next few owners, then muted lines only when they apply (per day
// under a Week or Month total, its days with data, the other per).
export default function TrendTooltip({
  open,
  anchor,
  placement,
  folded,
  stacks,
  bar,
  sides,
  click,
  pricer = null,
}: TrendTooltipProps) {
  const theme = useTheme();
  if (!open || anchor === null || bar < 0 || bar >= folded.bars.length) {
    return null;
  }
  const b = folded.bars[bar];
  const unit = stacks.unit;
  const cu = costUnit(unit);
  const total = stacks.total[bar];
  const rows = stacks.keys
    .map((key, k) => ({ key, k, value: stacks.value[k][bar] }))
    .filter((r) => r.value > 0);
  const lines: string[] = [];
  // Borrowed days read ≈ and say whose rates; provisional ones
  // say what the rates were made from.
  const notes =
    unit === "usd" && pricer !== null
      ? pricingNotes(
          pricer,
          folded.cells.days.filter((_, d) => folded.dayBar[d] === bar)
        )
      : { approx: false, lines: [] };
  const other = stacks.per === "day" ? "commit" : "day";
  const otherValue = barValue(folded, stacks, bar, other);
  const daily =
    stacks.per === "day" && folded.rollup !== "day"
      ? barValue(folded, stacks, bar, "day")
      : null;
  if (daily !== null) lines.push(`Per day ${fineAmountLabel(cu, daily)}`);
  if (otherValue !== null) {
    const pushes =
      folded.rollup === "day" || b.data === 0
        ? `${b.pushes} pushes`
        : `${Math.round(b.pushes / b.data)} pushes a day`;
    lines.push(
      other === "commit"
        ? `Per commit ${fineAmountLabel(cu, otherValue)} · ${pushes}`
        : `Per day ${fineAmountLabel(cu, otherValue)}`
    );
  }
  const note = daysNote(b);
  if (note !== null) {
    lines.push(
      stacks.per === "day"
        ? `${note} with data`
        : `${note} with data · ${amountLabel(
            cu,
            total * stacks.divisor[bar]
          )} total`
    );
  }
  if (b.filling) lines.push("Includes a day still filling (reads low)");
  if (unit === "usd") {
    if (b.data > 0 && stacks.pricedDays[bar] === 0) {
      lines.push(
        `No rates · ${amountLabel("hours", stacks.unpriced[bar])} unpriced`
      );
    } else {
      if (stacks.pricedDays[bar] < b.data) {
        lines.push(`${stacks.pricedDays[bar]} of ${b.data} days priced`);
      }
      const share =
        stacks.hours[bar] > 0 ? stacks.unpriced[bar] / stacks.hours[bar] : 0;
      if (share >= 0.005) lines.push(`${shareLabel(share)} of hours unpriced`);
      lines.push(...notes.lines);
    }
  }
  if (click !== null) lines.push(click);
  const sideColor = (s: Side) =>
    s === "b"
      ? theme.palette.primary.main
      : theme.palette.mode === "dark"
      ? theme.palette.grey[400]
      : theme.palette.grey[700];

  return (
    <Popper
      open
      anchorEl={anchor}
      placement={placement}
      modifiers={[{ name: "offset", options: { offset: [0, 10] } }]}
      sx={{ pointerEvents: "none", zIndex: theme.zIndex.tooltip }}
    >
      <Paper
        elevation={4}
        sx={{
          px: 1.5,
          py: 1,
          minWidth: 250,
          maxWidth: 340,
          border: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, mb: 0.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {barTitle(folded, bar)}
          </Typography>
          {sides.map((s) => (
            <Box
              key={s}
              component="span"
              sx={{
                px: 0.5,
                borderRadius: "3px",
                fontSize: 11,
                fontWeight: 700,
                lineHeight: "16px",
                color:
                  s === "b"
                    ? theme.palette.primary.contrastText
                    : theme.palette.background.paper,
                backgroundColor: sideColor(s),
              }}
            >
              {s.toUpperCase()}
            </Box>
          ))}
          <Box sx={{ ml: "auto" }} />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {b.data === 0
              ? "no data"
              : unit === "usd" && stacks.pricedDays[bar] === 0
              ? "no rates"
              : `${notes.approx ? "≈" : ""}${perLabel(
                  unit,
                  stacks.per,
                  total
                )}`}
          </Typography>
        </Box>
        {rows.map(({ key, k, value }) => {
          const fill = paintFill(theme, key.paint);
          const members =
            key.id === "other_owners" || key.id === "other_machines"
              ? keyMembers(folded, stacks, k, bar)
              : [];
          return (
            <Box key={key.id}>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "12px 1fr auto 36px",
                  alignItems: "center",
                  columnGap: 1,
                  typography: "caption",
                  lineHeight: "18px",
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
                <Box
                  component="span"
                  sx={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {ownerLabel(key.label)}
                </Box>
                <Box
                  component="span"
                  sx={{ fontWeight: 600, textAlign: "right" }}
                >
                  {fineAmountLabel(cu, value)}
                </Box>
                <Box
                  component="span"
                  sx={{ color: "text.secondary", textAlign: "right" }}
                >
                  {total > 0 ? shareLabel(value / total) : ""}
                </Box>
              </Box>
              {members.length > 0 && (
                <Typography
                  variant="caption"
                  component="div"
                  sx={{
                    color: "text.secondary",
                    pl: "20px",
                    lineHeight: "16px",
                  }}
                >
                  {members
                    .slice(0, 4)
                    .map(
                      (m) =>
                        `${ownerLabel(m.name || "the rest")} ${amountLabel(
                          cu,
                          m.value
                        )}`
                    )
                    .join(" · ")}
                  {members.length > 4 && ` · +${members.length - 4} more`}
                </Typography>
              )}
            </Box>
          );
        })}
        {lines.length > 0 && (
          <Box
            sx={{
              mt: 0.5,
              pt: 0.5,
              borderTop: `1px solid ${theme.palette.divider}`,
            }}
          >
            {lines.map((line) => (
              <Typography
                key={line}
                variant="caption"
                component="div"
                sx={{ color: "text.secondary", lineHeight: "16px" }}
              >
                {line}
              </Typography>
            ))}
          </Box>
        )}
      </Paper>
    </Popper>
  );
}
