import { Box, ButtonBase, Tooltip, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import KeyButton from "components/tests/cost/KeyButton";
import { sideColor, sideText } from "components/tests/cost/trends/TrendBars";
import HeaderSelect from "components/tests/HeaderSelect";
import {
  DEFAULT_SHOW,
  SHOW_OPTIONS,
  type DayRange,
  type Rollup,
  type TrendContext,
} from "lib/api/tests/cost/contracts";
import {
  calendarDays,
  dataDays,
  dayLabel,
  lengthText,
  rangeText,
  shownRange,
  type Side,
} from "lib/tests/cost/select";

const UNIT: Record<Rollup, string> = {
  day: "days",
  week: "weeks",
  month: "months",
};

export interface PickRowProps {
  rollup: Rollup;
  a: DayRange;
  b: DayRange;
  armed: Side;
  context: TrendContext;
  show: number;
  priced?: Partial<Record<Side, string | null>>; // $: "3 of 7 days priced"
  onArm(_side: Side): void;
  onSwap(): void;
  onShow(_show: number): void;
}

// A chip's words: "Nov 2 – 8 · 1 week · 4 of 7 days", or "· no data".
export function chipText(
  rollup: Rollup,
  r: DayRange,
  ctx: TrendContext
): { range: string; length: string; note: string | null } {
  const data = dataDays(ctx, r);
  const calendar = calendarDays(rollup, r);
  return {
    range: rangeText(r, false),
    length: lengthText(rollup, r),
    note:
      data === 0
        ? "no data"
        : data < calendar
        ? `${data} of ${calendar} days`
        : null,
  };
}

// The pick row: Pick [A][B] (an exclusive toggle choosing what the bars act
// on), Swap as a static key, and Show (the lookback) at the right.
export default function PickRow(props: PickRowProps) {
  const { rollup, a, b, armed, context: ctx, show } = props;
  const theme = useTheme();
  const options = [...SHOW_OPTIONS[rollup]];
  if (!options.includes(show)) options.push(show);
  options.sort((x, y) => x - y);
  const chip = (side: Side, r: DayRange) => {
    const text = chipText(rollup, r, ctx);
    const on = armed === side;
    const color = sideColor(theme, side);
    return (
      <Tooltip
        key={side}
        title={`Bars act on ${side.toUpperCase()} (key ${side.toUpperCase()})`}
        enterDelay={600}
      >
        <ButtonBase
          aria-pressed={on}
          onClick={() => props.onArm(side)}
          sx={{
            gap: 0.75,
            height: 28,
            pl: 0.5,
            pr: 1,
            borderRadius: "6px",
            border: `${on ? 2 : 1}px solid ${
              on ? color : theme.palette.divider
            }`,
            m: on ? 0 : "1px",
            backgroundColor: on
              ? alpha(color, theme.palette.mode === "dark" ? 0.16 : 0.07)
              : "transparent",
            typography: "body2",
            whiteSpace: "nowrap",
            "&.Mui-focusVisible": {
              outline: `2px solid ${theme.palette.primary.main}`,
            },
          }}
        >
          <Box
            component="span"
            sx={{
              width: 18,
              height: 18,
              borderRadius: "3px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              color: sideText(theme, side),
              backgroundColor: color,
            }}
          >
            {side.toUpperCase()}
          </Box>
          <Box component="span" sx={{ fontWeight: on ? 600 : 400 }}>
            {text.range}
          </Box>
          <Box component="span" sx={{ color: "text.secondary" }}>
            · {text.length}
            {text.note !== null && ` · ${text.note}`}
            {text.note !== "no data" &&
              props.priced?.[side] &&
              ` · ${props.priced[side]}`}
          </Box>
        </ButtonBase>
      </Tooltip>
    );
  };
  return (
    <Box
      sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 }}
    >
      <Typography
        variant="body2"
        sx={{ color: "text.secondary", minWidth: 40 }}
      >
        Pick
      </Typography>
      {chip("a", a)}
      {chip("b", b)}
      <KeyButton title="Swap A and B" onClick={props.onSwap}>
        ⇄ Swap
      </KeyButton>
      <Box sx={{ ml: "auto" }} />
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Show
      </Typography>
      <HeaderSelect<string>
        label="Bars shown"
        display={`Last ${show} ${UNIT[rollup]}`}
        value={String(show)}
        options={options.map((o) => {
          const before =
            ctx.firstDay !== null &&
            shownRange(rollup, o, ctx.end).from < ctx.firstDay;
          return {
            value: String(o),
            label: `Last ${o} ${UNIT[rollup]}${
              o === DEFAULT_SHOW[rollup] ? " (default)" : ""
            }${before ? ` · data from ${dayLabel(ctx.firstDay!)}` : ""}`,
          };
        })}
        onChange={(v) => props.onShow(Number(v))}
      />
    </Box>
  );
}
