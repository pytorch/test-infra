import { Box, Typography, useTheme } from "@mui/material";
import CostFrame from "components/tests/cost/CostFrame";
import KeyButton from "components/tests/cost/KeyButton";
import TrendChanges from "components/tests/cost/TrendChanges";
import TrendChart from "components/tests/cost/TrendChart";
import TrendTable from "components/tests/cost/TrendTable";
import TextButton from "components/tests/TextButton";
import type { CostTrend } from "lib/api/tests/cost/types";
import { TREND_ROLLUPS, type TrendRollup } from "lib/api/tests/cost/windows";
import {
  amountLabel,
  costChangesApiUrl,
  fineAmountLabel,
  rateLabel,
  shareLabel,
} from "lib/tests/cost/query";
import { averageRate, type RatesFile } from "lib/tests/cost/rates";
import {
  joinNames,
  ownerLabel,
  type PreparedHours,
} from "lib/tests/cost/runnerHours";
import {
  budgetFacts,
  daysLabel,
  DEFAULT_TREND_SORT,
  defaultRanges,
  fillingIn,
  nextTrendSort,
  ownersBudget,
  type PeriodRange,
  type PreparedTrend,
  prepareTrend,
  rangeDates,
  rangeDays,
  rangeLabel,
  rangePushes,
  rangeTotals,
  rollupReady,
  type TrendPer,
  trendPresets,
  trendRows,
  trendSeries,
  type TrendSort,
  trendSortInForce,
  trendYear,
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
  "Runner-hours by period from the test_cost rollup, by owner, or $ at your rates file's prices. Periods compare per day with data; the year to date reads against the budget in your rates file.";

export interface TrendPanelProps {
  answer: CostTrend | undefined;
  loading: boolean;
  rollup: TrendRollup;
  onRollupChange: (_rollup: TrendRollup) => void;
  // The rates file, in memory: $ and its budget once added.
  rates: RatesFile | null;
  // The page's workflow scope in words, null for every workflow.
  scope: string | null;
  // The page's owner highlight, which the panel shows and sets; what changed
  // is the highlighted owners'.
  highlighted: readonly string[];
  onToggleOwners: (_owners: string[]) => void;
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

// The share of a range's runner-hours that pushes to main ran: what per
// commit counts.
function mainShare(p: PreparedTrend, r: PeriodRange): number {
  const all = rangeTotals(p, null, r).runnerHours;
  return all > 0
    ? rangeTotals(p, null, r, null, "commit").runnerHours / all
    : 0;
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
// owners ranked by B or by their change per day, what changed for the
// highlighted owners (or every owner) by machine and runner label,
// runner-hours per push to main, and with a rates file's budget,
// the year to date and B's pace a year against it. It follows the page's
// workflow scope and owner highlight, and a row's click highlights across
// the page; its own choices (rollup, unit, periods, order) are in its state.
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

  const keys = (
    <Box sx={{ display: "flex", gap: 0.75, alignItems: "center" }}>
      {TREND_ROLLUPS.map((r) => {
        const ready = prepared === undefined || rollupReady(prepared, r);
        return (
          <KeyButton
            key={r}
            title={
              ready
                ? `A bar per ${r}`
                : `Two whole ${r}s of data first: the rollup has data from ${daysLabel(
                    {
                      from: prepared.dailyDays[0] ?? prepared.end,
                      to: prepared.dailyDays[0] ?? prepared.end,
                    }
                  )}`
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
        title="Compare per day with data: every trigger's runner time"
        active={per === "day"}
        onClick={() => setPer("day")}
      >
        Per day
      </KeyButton>
      <KeyButton
        title="Compare per commit: what a push to main costs, its jobs' runner time over the pushes to main. Main runs every test, with no target determination, so it is normalized, and weekends and quiet days do not skew it"
        active={per === "commit"}
        onClick={() => setPer("commit")}
      >
        Per commit
      </KeyButton>
    </Box>
  );
  const frame = (children: ReactNode) => (
    <CostFrame
      title="Trends and budget"
      description={DESCRIPTION}
      note={`· ${scope ?? "all workflows"}`}
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
        The rollup holds no runner-hours in these periods yet.
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
  const series = trendSeries(prepared, priced, lit, per);
  const focus = lit.size > 0 ? lit : null;
  const whose =
    focus === null ? "" : `${joinNames(Array.from(lit, ownerLabel))}: `;
  const amount = (v: number) => fineAmountLabel(unit, v);
  const budget = rates?.budget ?? null;
  // The budget the bars and the pace read against: the highlighted owners'
  // when each has one, every owner's otherwise.
  const focusBudget =
    focus === null
      ? budget?.annual ?? null
      : ownersBudget(budget, Array.from(lit));
  const { days: yearDays } = trendYear(prepared);
  const periodBudget =
    dollars && focusBudget !== null && per === "day"
      ? Float64Array.from(
          prepared.periodData,
          (days) => (focusBudget * days) / yearDays
        )
      : null;

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
    const vsA = (now: number | null, then: number | null, say: string) =>
      now === null || then === null || then === 0
        ? undefined
        : `${now > then ? "▲" : now < then ? "▼" : ""} ${
            now > then ? "+" : ""
          }${Math.round(((now - then) / then) * 100)}% vs A (${say})`;
    const rateB = averageRate(bt.value, bt.runnerHours, bt.unpriced);
    const rateA =
      at === null ? null : averageRate(at.value, at.runnerHours, at.unpriced);
    const facts = budgetFacts(prepared, priced, b);
    const pace = focus === null ? facts?.pace ?? null : bPerDay * yearDays;
    const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
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
    const dayCard = (
      <Card
        key="day"
        title={`${whose}${dollars ? "$" : "Runner-hours"} per day in B`}
        value={amount(bPerDay)}
        note={vsA(bPerDay, aPerDay, aPerDay === null ? "" : amount(aPerDay))}
        noteColor={change === null ? undefined : change > 0 ? up : down}
        detail={`${bDays > 1 ? `${amount(bt.value)} over ` : ""}${rangeLabel(
          prepared,
          b
        )} · ${days(bDays)} with data${
          dollars && bt.unpriced > 0.5
            ? ` · ${shareLabel(bt.unpriced / bt.runnerHours)} of hours unpriced`
            : ""
        }`}
      />
    );
    const commitCard = bPerCommit !== null && (
      <Card
        key="commit"
        title={`${whose}${dollars ? "$" : "Runner-hours"} per commit in B`}
        value={amount(bPerCommit)}
        note={vsA(
          bPerCommit,
          aPerCommit,
          aPerCommit === null ? "" : amount(aPerCommit)
        )}
        noteColor={
          commitChange === null ? undefined : commitChange > 0 ? up : down
        }
        detail={`What a push to main costs; main runs every test. ${(bDays > 0
          ? bPushes / bDays
          : 0
        ).toFixed(0)} pushes a day ran ${shareLabel(
          bt.runnerHours > 0 ? bMain.runnerHours / bt.runnerHours : 0
        )} of ${
          focus === null
            ? "every owner"
            : joinNames(Array.from(lit, ownerLabel))
        }'s runner-hours in B`}
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
        {dollars && facts !== null ? (
          <Card
            title={`Year to date vs budget, all owners`}
            value={`${amountLabel("cost", facts.ytd)} of ${amountLabel(
              "cost",
              facts.toDate
            )}`}
            note={`${shareLabel(facts.ratio)} of the budget for the ${
              facts.ytdDays
            } days with data since ${facts.firstDay ?? "January 1"}`}
            noteColor={facts.ratio > 1 ? up : down}
          />
        ) : (
          dollars && (
            <Card
              title="Year to date vs budget"
              value="No budget"
              note={`Add "budget": {"annual": $} to ${
                rates?.file ?? "your rates file"
              }'s wrapped form`}
            />
          )
        )}
        {dollars && pace !== null && focusBudget !== null && (
          <Card
            title={`${whose}B's pace a year`}
            value={amountLabel("cost", pace)}
            note={`${
              pace > focusBudget ? "▲ over" : "✓ under"
            } the ${amountLabel("cost", focusBudget)} budget by ${shareLabel(
              Math.abs(pace / focusBudget - 1)
            )}`}
            noteColor={pace > focusBudget ? up : down}
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
            title={
              p.available
                ? `A: ${rangeLabel(prepared, p.a!)} · B: ${rangeLabel(
                    prepared,
                    p.b!
                  )}`
                : "Needs every day of both periods in the rollup"
            }
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
              <TextButton label="Clear A" onClick={() => setRange("a", null)}>
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
      <Typography
        variant="caption"
        component="p"
        sx={{ color: "text.secondary" }}
      >
        {per === "day"
          ? `Bars: each ${prepared.rollup}'s total.`
          : `Bars: what a push to main cost each ${prepared.rollup}.`}{" "}
        Drag across the bars to set B; hold Shift to set A. Faded bars lack days
        of data{periodBudget !== null ? "; dashed lines are the budget" : ""}.
      </Typography>
      {filling.length > 0 && (
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "warning.main" }}
        >
          ⚠ {filling.map((d) => daysLabel({ from: d, to: d })).join(", ")}{" "}
          {filling.length === 1 ? "is" : "are"} still filling: jobs that started
          then are still running, so{" "}
          {filling.length === 1 ? "it reads" : "they read"} low until the rollup
          computes {filling.length === 1 ? "it" : "them"} again after 03:00 UTC.
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
            One day against another: per commit moves about 5% from day to day,
            up to 13% for an owner, so compare 7 days for smaller changes.
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
            ⚠ A has {weekendDays(prepared, a)!.weekend} of{" "}
            {weekendDays(prepared, a)!.days} days on a weekend, B{" "}
            {weekendDays(prepared, b)!.weekend} of{" "}
            {weekendDays(prepared, b)!.days}: weekends run far fewer jobs, so
            compare the same weekdays, whole weeks, or per commit.
          </Typography>
        )}
      <TrendChart
        prepared={prepared}
        series={series}
        highlighting={lit.size > 0}
        budget={periodBudget}
        a={a}
        b={b}
        onRangeChange={(which, range) => setRange(which, range)}
      />
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
              Owners · {dollars ? "$" : "runner-hours"} per{" "}
              {per === "day"
                ? "day with data"
                : `commit · what a push to main costs, its jobs ${shareLabel(
                    mainShare(prepared, b)
                  )} of B's runner-hours`}
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
            onExpand={() => setExpanded(true)}
          />
          <Typography
            variant="caption"
            component="p"
            sx={{ color: "text.secondary" }}
          >
            Click an owner to highlight it across the page and see what changed
            for it below; click it again to clear. Click a column&apos;s header
            to sort by it.
          </Typography>
          {a === null ? (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 2 }}>
              Set A (Shift-drag across the bars, or pick a comparison) to see
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
            />
          )}
        </>
      )}
    </>
  );
}
