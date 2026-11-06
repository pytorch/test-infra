import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import { Box, Typography, useTheme } from "@mui/material";
import CostFrame from "components/tests/cost/CostFrame";
import KeyButton from "components/tests/cost/KeyButton";
import TrendChanges from "components/tests/cost/TrendChanges";
import TrendChart from "components/tests/cost/TrendChart";
import TrendTable from "components/tests/cost/TrendTable";
import HeaderSelect from "components/tests/HeaderSelect";
import TextButton from "components/tests/TextButton";
import type { CostTrend } from "lib/api/tests/cost/types";
import {
  TREND_PERIODS,
  TREND_ROLLUPS,
  type TrendRollup,
} from "lib/api/tests/cost/windows";
import {
  amountLabel,
  costChangesApiUrl,
  fineAmountLabel,
  rateLabel,
  shareLabel,
} from "lib/tests/cost/query";
import { averageRate, type RatesFile } from "lib/tests/cost/rates";
import {
  isBucket,
  joinNames,
  ownerLabel,
  type PreparedHours,
} from "lib/tests/cost/runnerHours";
import {
  changeLabel,
  daysLabel,
  DEFAULT_TREND_SORT,
  defaultRanges,
  fillingIn,
  isPartial,
  nextTrendSort,
  ownerStep,
  paceCaveat,
  type PeriodRange,
  type PreparedTrend,
  prepareTrend,
  rangeDates,
  rangeDays,
  rangeElapsed,
  rangeLabel,
  rangePushes,
  rangeTotals,
  rollupReady,
  trendOwnerOrder,
  trendPace,
  type TrendPer,
  type TrendPreset,
  trendPresets,
  trendRows,
  trendSeries,
  type TrendSort,
  trendSortInForce,
  weekendDays,
  weekendMismatch,
} from "lib/tests/cost/trend";
import { useCostChanges } from "lib/tests/cost/useCost";
import { type ReactNode, useMemo, useState } from "react";

const ROLLUP_LABELS: Record<TrendRollup, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
};

const DESCRIPTION =
  "Runner-hours of test jobs by day, week or month (ci.test_cost), or $ with a rates file. Compare two periods, A and B, per day (averaged over days with data) or per commit: what one push to main costs, with every test running. B's daily average projects yearly and monthly totals.";

// The Owner key's values for every owner, and for several highlighted
// owners, which no one item stands for.
const ALL_OWNERS = "";
const SEVERAL_OWNERS = "\u0000";

export interface TrendPanelProps {
  answer: CostTrend | undefined;
  loading: boolean;
  rollup: TrendRollup;
  onRollupChange: (_rollup: TrendRollup) => void;
  // The rates file, in memory: $ once added.
  rates: RatesFile | null;
  // The page's workflow scope in words, null for every workflow.
  scope: string | null;
  // The page's owner highlight, which the panel shows and sets; what changed
  // is the highlighted owners'.
  highlighted: readonly string[];
  onToggleOwners: (_owners: string[]) => void;
  // Replaces the highlight: the Owner key's choice and its ‹ › steps.
  onOwnersChange: (_owners: string[]) => void;
  // The cost answer, for the machine key's machines and hues.
  runnerHours?: PreparedHours;
}

function Card({
  title,
  value,
  note,
  noteColor,
  detail,
}: {
  title: string;
  value: string;
  note?: ReactNode;
  noteColor?: string;
  // A second line, always in the secondary color.
  detail?: ReactNode;
}) {
  return (
    <Box
      sx={{
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "6px",
        px: 1.5,
        py: 1,
        minWidth: 0,
      }}
    >
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {title}
      </Typography>
      <Typography
        sx={{
          fontSize: "1.375rem",
          fontWeight: 600,
          lineHeight: 1.3,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </Typography>
      {note !== undefined && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: noteColor ?? "text.secondary" }}
        >
          {note}
        </Typography>
      )}
      {detail !== undefined && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "text.secondary" }}
        >
          {detail}
        </Typography>
      )}
    </Box>
  );
}

interface ComparedRanges {
  key: string;
  a: PeriodRange | null;
  b: PeriodRange | null;
}

// The periods compared: those chosen on this answer, else its defaults; null
// without periods.
function comparedRanges(
  prepared: PreparedTrend | undefined,
  chosen: ComparedRanges | null,
  answerKey: string
): ComparedRanges | null {
  if (prepared === undefined || prepared.periods.length === 0) return null;
  if (chosen !== null && chosen.key === answerKey) return chosen;
  return { key: answerKey, ...defaultRanges(prepared) };
}

// What changed needs both periods; its URL changes with either, the scope
// and the highlight.
function changesUrl(
  answer: CostTrend | undefined,
  prepared: PreparedTrend | undefined,
  ranges: ComparedRanges | null,
  highlighted: readonly string[]
): string | null {
  if (answer === undefined || prepared === undefined || ranges === null) {
    return null;
  }
  if (ranges.a === null || ranges.b === null) return null;
  return costChangesApiUrl(
    answer.repo,
    answer.workflows,
    highlighted,
    rangeDates(prepared, ranges.a),
    rangeDates(prepared, ranges.b)
  );
}

// The cost page's trend: runner-hours or $ by day, week or month over the
// last weeks or months, two periods compared (B, and A before it), the
// owners ranked by B or by their change per day (the top few, the rest
// folded), what changed for the highlighted owners (or every owner) by
// machine and runner label, runner-hours per push to main, and B's pace
// projected for a year and a month. It follows the page's workflow scope and
// owner highlight; the Owner key in its band picks one owner, or steps
// through them in the table's order, and a row's click toggles one, both
// across the page. Its own choices (rollup, unit, periods, order) are in
// its state.
// Reads GET /api/tests/cost/trend through lib/tests/cost/trend.ts, and GET
// /api/tests/cost/changes through lib/tests/cost/changes.ts.
export default function TrendPanel({
  answer,
  loading,
  rollup,
  onRollupChange,
  rates,
  scope,
  highlighted,
  onToggleOwners,
  onOwnersChange,
  runnerHours,
}: TrendPanelProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(true);
  const [unitChoice, setUnitChoice] = useState<"hours" | "cost" | null>(null);
  const [sort, setSort] = useState<TrendSort>(DEFAULT_TREND_SORT);
  const [expanded, setExpanded] = useState(false);
  const [per, setPer] = useState<TrendPer>("day");
  const prepared = useMemo(
    () => (answer === undefined ? undefined : prepareTrend(answer)),
    [answer]
  );
  // The rollup of the bars on screen: the last answer's while the next
  // loads.
  const shown = prepared?.rollup ?? rollup;
  // The periods chosen belong to the answer they were chosen on; a new
  // rollup or window starts from the defaults.
  const answerKey =
    prepared === undefined
      ? ""
      : `${prepared.rollup}|${prepared.periods[0]}|${prepared.periods.length}`;
  const [chosen, setChosen] = useState<ComparedRanges | null>(null);
  const dollars = rates !== null && unitChoice !== "hours";
  const unit = dollars ? "cost" : "hours";
  const priced = dollars ? rates : null;
  const lit = useMemo(() => new Set(highlighted), [highlighted]);
  const ranges = comparedRanges(prepared, chosen, answerKey);
  const changesRequest = useCostChanges(
    changesUrl(answer, prepared, ranges, highlighted)
  );

  // Every owner in the owners table's order, for the Owner key: those the
  // page can highlight, which are the cost answer's.
  const order = (
    prepared === undefined || ranges === null || ranges.b === null
      ? []
      : trendOwnerOrder(
          prepared,
          priced,
          ranges.a,
          ranges.b,
          trendSortInForce(sort, ranges.a),
          per
        )
  ).filter((o) => runnerHours === undefined || runnerHours.owners.includes(o));
  // The key's names: a bucket is hours no owner is given, not an owner.
  const keyName = (o: string) =>
    isBucket(o) ? `${ownerLabel(o)} (unattributed)` : o;
  const steps = {
    prev: ownerStep(order, lit, -1),
    next: ownerStep(order, lit, 1),
  };
  const stepTitle = (to: string[] | null, which: "Previous" | "Next") =>
    to === null
      ? which === "Previous"
        ? "Already at all owners"
        : "Already at the last owner"
      : to.length === 0
      ? "Back to all owners"
      : `${which} owner: ${keyName(to[0])}`;
  const keys = (
    <Box
      sx={{
        display: "flex",
        flexWrap: "wrap",
        gap: 0.75,
        alignItems: "center",
      }}
    >
      <HeaderSelect<string>
        label="Owner"
        display={
          lit.size === 0 ? "All owners" : joinNames(Array.from(lit, keyName))
        }
        active={lit.size > 0}
        options={[
          { value: ALL_OWNERS, label: "All owners" },
          ...order.map((o) => ({ value: o, label: keyName(o) })),
        ]}
        value={
          lit.size === 0
            ? ALL_OWNERS
            : lit.size === 1
            ? Array.from(lit)[0]
            : SEVERAL_OWNERS
        }
        onChange={(o) => onOwnersChange(o === ALL_OWNERS ? [] : [o])}
      />
      <KeyButton
        title={stepTitle(steps.prev, "Previous")}
        disabled={steps.prev === null}
        onClick={() => steps.prev !== null && onOwnersChange(steps.prev)}
      >
        <ChevronLeftRoundedIcon aria-hidden sx={{ fontSize: 18 }} />
      </KeyButton>
      <KeyButton
        title={stepTitle(steps.next, "Next")}
        disabled={steps.next === null}
        onClick={() => steps.next !== null && onOwnersChange(steps.next)}
      >
        <ChevronRightRoundedIcon aria-hidden sx={{ fontSize: 18 }} />
      </KeyButton>
      <Box sx={{ width: 8 }} />
      {TREND_ROLLUPS.map((r) => {
        const ready = prepared === undefined || rollupReady(prepared, r);
        return (
          <KeyButton
            key={r}
            title={
              ready
                ? `A bar per ${r}, the last ${TREND_PERIODS[r]} ${r}s`
                : `Needs two whole ${r}s of data; data starts ${daysLabel({
                    from: prepared.dailyDays[0] ?? prepared.end,
                    to: prepared.dailyDays[0] ?? prepared.end,
                  })}`
            }
            active={rollup === r}
            disabled={!ready}
            onClick={() => onRollupChange(r)}
          >
            {ROLLUP_LABELS[r]}
          </KeyButton>
        );
      })}
      <Box sx={{ width: 8 }} />
      <KeyButton
        title="Runner-hours"
        active={!dollars}
        onClick={() => setUnitChoice("hours")}
      >
        Hours
      </KeyButton>
      <KeyButton
        title={
          rates === null
            ? "Add a rates file in Cost by owner to see $"
            : `$ at ${rates.file}'s rates`
        }
        active={dollars}
        disabled={rates === null}
        onClick={() => setUnitChoice("cost")}
      >
        $
      </KeyButton>
      <Box sx={{ width: 8 }} />
      <KeyButton
        title="Compare per day: all runs, not just pushes to main, averaged over days with data"
        active={per === "day"}
        onClick={() => setPer("day")}
      >
        Per day
      </KeyButton>
      <KeyButton
        title="Compare per commit: what one push to main costs, its runner-hours ÷ pushes to main. Main runs every test (no target determination), so this is the full cost of a push, as if TD did not exist; quiet days do not skew it. One push can land a stack; CI runs once, on its top commit"
        active={per === "commit"}
        onClick={() => setPer("commit")}
      >
        Per commit
      </KeyButton>
    </Box>
  );
  const frame = (children: ReactNode) => (
    <CostFrame
      title="Trends"
      description={DESCRIPTION}
      note={`· ${scope ?? "all workflows"} · last ${
        TREND_PERIODS[shown]
      } ${shown}s`}
      keys={keys}
      open={open}
      onOpenChange={setOpen}
      loading={loading}
    >
      {children}
    </CostFrame>
  );
  if (prepared === undefined) {
    return frame(
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        Loading the trend…
      </Typography>
    );
  }
  if (prepared.periods.length === 0) {
    return frame(
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        No runner-hours in this window yet.
      </Typography>
    );
  }

  const { a, b } = ranges!;
  const setRange = (which: "a" | "b", range: PeriodRange | null) =>
    setChosen({ ...ranges!, [which]: range });
  // The days still filling in A or B.
  const filling = Array.from(
    new Set([
      ...(a === null ? [] : fillingIn(prepared, a)),
      ...(b === null ? [] : fillingIn(prepared, b)),
    ])
  ).sort();
  // The changes answer for these very periods and owners, not the one
  // shown last while they load.
  const changes = changesRequest.changes;
  const changesFresh =
    changes !== undefined &&
    a !== null &&
    b !== null &&
    changes.a.from === rangeDates(prepared, a).from &&
    changes.a.to === rangeDates(prepared, a).to &&
    changes.b.from === rangeDates(prepared, b).from &&
    changes.b.to === rangeDates(prepared, b).to &&
    changes.owners.join("\n") === [...highlighted].sort().join("\n");
  const presets = trendPresets(prepared);
  // What a preset compares, or why it is off.
  const presetTitle = (p: TrendPreset) => {
    if (p.available) {
      return `A: ${rangeLabel(prepared, p.a!)} · B: ${rangeLabel(
        prepared,
        p.b!
      )}`;
    }
    if (p.waitsFor.length === 0) {
      return "Not enough data yet: needs every day of both periods";
    }
    const days = p.waitsFor.map((d) => daysLabel({ from: d, to: d }));
    return `Waits for ${days.join(
      ", "
    )}: incomplete until the rollup reruns after 03:00 UTC`;
  };
  const faded = prepared.periods.some((_, i) => isPartial(prepared, i));
  const series = trendSeries(prepared, priced, lit, per);
  const focus = lit.size > 0 ? lit : null;
  const whose =
    focus === null ? "" : `${joinNames(Array.from(lit, ownerLabel))}: `;
  const amount = (v: number) => fineAmountLabel(unit, v);

  let cards: ReactNode = null;
  if (b !== null) {
    const bt = rangeTotals(prepared, priced, b, focus);
    const at = a === null ? null : rangeTotals(prepared, priced, a, focus);
    const bDays = rangeDays(prepared, b);
    const aDays = a === null ? 0 : rangeDays(prepared, a);
    const bPerDay = bDays > 0 ? bt.value / bDays : 0;
    const aPerDay = at !== null && aDays > 0 ? at.value / aDays : null;
    const change =
      aPerDay !== null && aPerDay > 0 ? (bPerDay - aPerDay) / aPerDay : null;
    const up = theme.palette.error.main;
    const down =
      theme.palette.mode === "dark"
        ? theme.palette.success.light
        : theme.palette.success.dark;
    // B against A as the tables write a change: "▲ +18% vs A ($24)".
    const vsA = (now: number | null, then: number | null) =>
      now === null || then === null || then === 0
        ? undefined
        : now === then
        ? `same as A (${amount(then)})`
        : `${changeLabel({
            change: (now - then) / then,
            delta: now - then,
          })} vs A (${amount(then)})`;
    const rateB = averageRate(bt.value, bt.runnerHours, bt.unpriced);
    const rateA =
      at === null ? null : averageRate(at.value, at.runnerHours, at.unpriced);
    const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
    // Days a period lacks data on, said only when it does.
    const missing = (r: PeriodRange | null, which: "A" | "B") => {
      if (r === null) return "";
      const have = rangeDays(prepared, r);
      const of = rangeElapsed(prepared, r);
      return have < of ? ` · ${which} has data on ${have} of ${days(of)}` : "";
    };
    // B's pace: the day card's per day kept up for a year and a month,
    // whichever the comparison, as spend is per day; none where B's hours
    // all lack a rate.
    const pace =
      bDays > 0 && !(dollars && bt.value === 0 && bt.unpriced > 0)
        ? trendPace(prepared, bPerDay)
        : null;
    const caveat = paceCaveat(prepared, b);
    // Hours without a rate add nothing to the $: the figures are at least
    // what they say.
    const unpricedNote =
      dollars && bt.unpriced > 0.5
        ? ` · ${shareLabel(bt.unpriced / bt.runnerHours)} of hours unpriced`
        : "";
    // Per commit: push:main runner time over the pushes to main.
    const bPushes = rangePushes(prepared, b);
    const aPushes = a === null ? 0 : rangePushes(prepared, a);
    const bMain = rangeTotals(prepared, priced, b, focus, "commit");
    const aMain =
      a === null ? null : rangeTotals(prepared, priced, a, focus, "commit");
    const bPerCommit = bPushes > 0 ? bMain.value / bPushes : null;
    const aPerCommit =
      aMain !== null && aPushes > 0 ? aMain.value / aPushes : null;
    const commitChange =
      aPerCommit !== null && bPerCommit !== null && aPerCommit > 0
        ? (bPerCommit - aPerCommit) / aPerCommit
        : null;
    const pushesADay = (bDays > 0 ? bPushes / bDays : 0).toFixed(0);
    const dayCard = (
      <Card
        key="day"
        title={`${whose}${dollars ? "$" : "Runner-hours"} per day in B`}
        value={amount(bPerDay)}
        note={vsA(bPerDay, aPerDay)}
        noteColor={
          change === null || change === 0 ? undefined : change > 0 ? up : down
        }
        detail={`${bDays > 1 ? `${amount(bt.value)} total, ` : ""}${rangeLabel(
          prepared,
          b
        )}${missing(b, "B")}${missing(a, "A")}${unpricedNote}`}
      />
    );
    const commitCard = bPerCommit !== null && (
      <Card
        key="commit"
        title={`${whose}${dollars ? "$" : "Runner-hours"} per commit in B`}
        value={amount(bPerCommit)}
        note={vsA(bPerCommit, aPerCommit)}
        noteColor={
          commitChange === null || commitChange === 0
            ? undefined
            : commitChange > 0
            ? up
            : down
        }
        detail={`What one push to main costs, with every test running (no target determination). ${pushesADay} ${
          pushesADay === "1" ? "push" : "pushes"
        } a day; their jobs are ${shareLabel(
          bt.runnerHours > 0 ? bMain.runnerHours / bt.runnerHours : 0
        )} of B's runner-hours${
          focus === null ? "" : ` for ${joinNames(Array.from(lit, ownerLabel))}`
        }.`}
      />
    );
    cards = (
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
          gap: 1,
          mt: 1.5,
        }}
      >
        {per === "day" ? [dayCard, commitCard] : [commitCard, dayCard]}
        {dollars && (
          <Card
            title={`${whose}$ per runner-hour`}
            value={rateB === null ? "—" : rateLabel(rateB)}
            note={
              rateA === null || rateB === null
                ? undefined
                : rateLabel(rateA) === rateLabel(rateB)
                ? `same as A`
                : `${rateB > rateA ? "▲" : "▼"} vs A (${rateLabel(rateA)}): ${
                    rateB > rateA ? "pricier" : "cheaper"
                  } machines`
            }
          />
        )}
        {pace !== null && (
          <Card
            title={`${whose}Projected ${
              dollars ? "$" : "runner-hours"
            } per year`}
            value={amountLabel(unit, pace.year)}
            detail={`${amountLabel(
              unit,
              pace.month
            )} per month at B's daily average${
              caveat === null ? "" : ` · B is ${caveat}`
            }${unpricedNote}`}
          />
        )}
      </Box>
    );
  }

  return frame(
    <>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 0.75,
          typography: "body2",
        }}
      >
        <Typography variant="body2" sx={{ color: "text.secondary", mr: 0.5 }}>
          Compare
        </Typography>
        {presets.map((p) => (
          <KeyButton
            key={p.key}
            title={presetTitle(p)}
            active={
              p.available &&
              a?.from === p.a?.from &&
              a?.to === p.a?.to &&
              b?.from === p.b?.from &&
              b?.to === p.b?.to
            }
            disabled={!p.available}
            onClick={() => setChosen({ key: answerKey, a: p.a, b: p.b })}
          >
            {p.label}
          </KeyButton>
        ))}
        <Box sx={{ mr: "auto" }} />
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          {a !== null && (
            <>
              <b>A</b> {rangeLabel(prepared, a)}{" "}
              <TextButton
                label="Clear A"
                tooltip="Clear A"
                onClick={() => setRange("a", null)}
              >
                <Box component="span" sx={{ color: "primary.main" }}>
                  ✕
                </Box>
              </TextButton>
              {" · "}
            </>
          )}
          {b !== null && (
            <>
              <Box component="b" sx={{ color: "primary.main" }}>
                B
              </Box>{" "}
              {rangeLabel(prepared, b)}
            </>
          )}
        </Typography>
      </Box>
      {filling.length > 0 && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "warning.main" }}
        >
          ⚠ {filling.map((d) => daysLabel({ from: d, to: d })).join(", ")}{" "}
          {filling.length === 1 ? "is" : "are"} incomplete: some of{" "}
          {filling.length === 1 ? "its" : "their"} jobs are still running, so{" "}
          {filling.length === 1 ? "it reads" : "they read"} low until the rollup
          reruns after 03:00 UTC.
        </Typography>
      )}
      {per === "commit" &&
        a !== null &&
        b !== null &&
        Math.min(rangeDays(prepared, a), rangeDays(prepared, b)) === 1 && (
          <Typography
            variant="caption"
            component="p"
            sx={{ color: "text.secondary" }}
          >
            Per commit varies about 5% from day to day (up to 13% for one
            owner); compare 7 days to spot smaller changes.
          </Typography>
        )}
      {per === "day" &&
        a !== null &&
        b !== null &&
        weekendMismatch(prepared, a, b) && (
          <Typography
            variant="caption"
            component="p"
            sx={{ color: "warning.main" }}
          >
            ⚠ A and B mix weekends differently (A:{" "}
            {weekendDays(prepared, a)!.weekend} of{" "}
            {weekendDays(prepared, a)!.days} days on a weekend, B:{" "}
            {weekendDays(prepared, b)!.weekend} of{" "}
            {weekendDays(prepared, b)!.days}). Weekends run far fewer jobs;
            compare matching weekdays, whole weeks, or per commit.
          </Typography>
        )}
      <TrendChart
        prepared={prepared}
        series={series}
        highlighting={lit.size > 0}
        a={a}
        b={b}
        onRangeChange={(which, range) => setRange(which, range)}
      />
      <Typography
        variant="caption"
        component="p"
        sx={{ color: "text.secondary", mt: 0.5 }}
      >
        {per === "day"
          ? `Each bar is a ${prepared.rollup}'s total.`
          : `Each bar is what a push to main cost that ${prepared.rollup}, on average.`}
        {lit.size > 0 &&
          ` Solid: ${joinNames(
            Array.from(lit, ownerLabel)
          )}; pale: the rest.`}{" "}
        Drag across the bars to set B, or Shift-drag to set A.
        {faded && " Faded bars have incomplete data."}
      </Typography>
      {cards}
      {b !== null && (
        <>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.75,
              mt: 2,
              mb: 0.5,
            }}
          >
            <Typography
              component="h3"
              sx={{
                fontSize: "0.75rem",
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "text.secondary",
                mr: "auto",
              }}
            >
              Owners · {dollars ? "$" : "runner-hours"} per {per}
            </Typography>
          </Box>
          <TrendTable
            rows={trendRows(
              prepared,
              priced,
              a,
              b,
              lit,
              sort,
              expanded,
              undefined,
              per
            )}
            unit={unit}
            per={per}
            rollup={prepared.rollup}
            periodsLabel={rangeLabel(prepared, {
              from: 0,
              to: prepared.periods.length - 1,
            })}
            highlighted={lit}
            aLabel={a === null ? null : rangeLabel(prepared, a)}
            bLabel={rangeLabel(prepared, b)}
            sort={trendSortInForce(sort, a)}
            onSort={(by) =>
              setSort((current) =>
                nextTrendSort(trendSortInForce(current, a), by)
              )
            }
            onToggleOwners={onToggleOwners}
            onExpandedChange={setExpanded}
          />
          <Typography
            variant="caption"
            component="p"
            sx={{ color: "text.secondary" }}
          >
            Click an owner to highlight it across the page and see what changed
            for it below; click again to clear. Click a header to sort.
          </Typography>
          {a === null ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 2 }}>
              Shift-drag across the bars, or pick a comparison, to set A and see
              what changed.
            </Typography>
          ) : (
            <TrendChanges
              changes={changes}
              loading={!changesFresh}
              error={changesRequest.error}
              onRetry={() => void changesRequest.retry()}
              rates={priced}
              per={per}
              onPerChange={setPer}
              prepared={runnerHours}
              highlighted={highlighted}
            />
          )}
        </>
      )}
    </>
  );
}
