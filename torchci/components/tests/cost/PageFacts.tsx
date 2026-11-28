import { Box, Typography } from "@mui/material";
import FactPill from "components/tests/FactPill";
import { addDays, type Pricer, type Unit } from "lib/api/tests/cost/contracts";
import type { CostTrend, RunnerHours } from "lib/api/tests/cost/types";
import { COST_WINDOW_DAYS } from "lib/api/tests/cost/windows";
import {
  amount,
  pageFacts,
  rangeText,
  type WindowFigure,
} from "lib/tests/cost/drill";
import { hoursLabel, shareLabel } from "lib/tests/cost/query";
import { pricingNotes } from "lib/tests/cost/ratePeriods";
import { Fragment, useMemo } from "react";

export interface PageFactsProps {
  // The day trend of the page's repository and workflow scope, any Show
  // (its daily cells start January 1); undefined while that scope's loads.
  trend: CostTrend | undefined;
  // The workflow scope in words: "all workflows", "PR Critical Path".
  scope: string;
  // A custom scope's every workflow, for the Across pill's title.
  scopeDetail?: string;
  unit: Unit;
  pricer: Pricer | null;
  // The 7-day answer: its PR update and merge signals.
  runnerHours?: RunnerHours;
}

const lines = (...xs: (string | null | undefined)[]) =>
  xs.filter(Boolean).join("\n") || undefined;

// Hours on labels without a rate are said once they reach this share.
const UNPRICED_NOTE = 0.005;

const daysWord = (n: number) => (n === 1 ? "day" : `${n} days`);

// A duration as the facts say it: "4.0 h", "27 min".
function signalLabel(seconds: number): string {
  return seconds >= 3600
    ? `${(seconds / 3600).toFixed(1)} h`
    : `${Math.round(seconds / 60)} min`;
}

// The page's headline facts under its title, as pills: the workflow scope, a
// year, per day, per commit and the share with an owner over the last 28
// whole days (pageFacts), then the PR signals of the last 7 days. The
// repository and workflow scope only: never the trail or A/B, as a light
// caption at the row's end says with both windows. Each pill's title says
// how it is counted, in at most three lines.
export default function PageFacts({
  trend,
  scope,
  scopeDetail,
  unit,
  pricer,
  runnerHours,
}: PageFactsProps) {
  const facts = useMemo(
    () => (trend === undefined ? null : pageFacts(trend, unit, pricer)),
    [trend, unit, pricer]
  );
  const usd = unit === "usd" && pricer !== null;
  const dots = "…";
  // In $: the priced days and the rates' notes, as one line.
  const pricing =
    facts !== null && pricer !== null && usd
      ? [
          facts.perDay.priced
            ? `${facts.perDay.priced.days} of ${facts.perDay.priced.of} days priced`
            : null,
          ...pricingNotes(pricer, facts.days),
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  // Over the priced days only, so said so when some days have no rates.
  const unpriced = (f: WindowFigure | undefined) =>
    usd && f?.unpriced != null && f.unpriced >= UNPRICED_NOTE
      ? `${shareLabel(f.unpriced)} of ${
          f.priced ? "priced days' " : ""
        }hours unpriced ($0)`
      : null;
  // A figure as its pill says it, its blank as the figure reads blank.
  const said = (
    f: WindowFigure | undefined,
    text: (_v: number) => string,
    scale = 1
  ) =>
    f === undefined
      ? dots
      : f.value === null
      ? f.blank
      : `${f.approx ? "≈" : ""}${text(f.value * scale)}`;
  const perDay = facts?.perDay;
  const perCommit = facts?.perCommit;
  const blank = (f: WindowFigure | undefined) =>
    f !== undefined && f.value === null;
  const days = facts?.days ?? [];
  const span =
    days.length === 0
      ? null
      : `${rangeText({ from: days[0], to: days[days.length - 1] })}${
          days.length === 1 ? "" : ` (${days.length} days)`
        }`;
  const signals = runnerHours?.time_to_signal ?? [];
  const signalDays = runnerHours ? COST_WINDOW_DAYS[runnerHours.window] : 0;
  const signalEnd = runnerHours?.end.slice(0, 10);
  // "Last 7 days, Nov 13–19", "Last day, Nov 19": the days before its end.
  const signalWindow = signalEnd
    ? `Last ${daysWord(signalDays)}, ${rangeText({
        from: addDays(signalEnd, -signalDays),
        to: addDays(signalEnd, -1),
      })}`
    : null;
  // The caption: the figures' window, the signals', and that A/B moves
  // neither; each part kept whole when it wraps.
  const caption = [
    facts?.window ?? null,
    signals.length > 0 && signalWindow !== null
      ? `signals last ${daysWord(signalDays)}`
      : null,
  ].filter((x): x is string => x !== null);
  return (
    <Box
      component="section"
      aria-label="Page facts"
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 1,
        typography: "body2",
      }}
    >
      <FactPill label="Across" title={scopeDetail}>
        {scope}
      </FactPill>
      <FactPill
        label="Annualized"
        muted={blank(perDay)}
        title={
          perDay?.value == null
            ? undefined
            : lines(
                `Per day × 365; ${said(
                  perDay,
                  (v) =>
                    usd ? amount("usd", v) : `${hoursLabel(v)} runner-hours`,
                  365 / 12
                )} a month`,
                pricing,
                unpriced(perDay)
              )
        }
      >
        {said(
          perDay,
          (v) =>
            usd
              ? `${amount("usd", v)} a year`
              : `${hoursLabel(v)} runner-hours a year`,
          365
        )}
      </FactPill>
      <FactPill
        label="Per day"
        muted={blank(perDay)}
        title={
          span === null
            ? undefined
            : lines(
                `Daily mean of ${span}, weekends included`,
                pricing,
                unpriced(perDay)
              )
        }
      >
        {said(perDay, (v) =>
          usd ? amount("usd", v) : `${hoursLabel(v)} runner-hours`
        )}
      </FactPill>
      <FactPill
        label="Per commit"
        muted={blank(perCommit)}
        title={
          perCommit === undefined
            ? undefined
            : lines(
                `${
                  usd ? "$" : "Runner-hours"
                } of pushes to main ÷ ${perCommit.pushes.toLocaleString(
                  "en-US"
                )} pushes`,
                pricing,
                unpriced(perCommit)
              )
        }
      >
        {said(perCommit, (v) => amount(usd ? "usd" : "hours", v))}
      </FactPill>
      <FactPill
        label="Attributed to owners"
        muted={facts !== null && facts.owned === null}
        title="Share of runner-hours in test files with an owner in today's owners list"
      >
        {facts === null
          ? dots
          : facts.owned === null
          ? "–"
          : shareLabel(facts.owned)}
      </FactPill>
      {signals.map((s) => (
        <FactPill
          key={s.value}
          label={s.label}
          muted={s.p50_seconds === null}
          title={lines(
            signalWindow,
            `Median ${s.workflow} run time on pushes to main, queue included`,
            s.p90_seconds === null
              ? null
              : `p90 ${signalLabel(s.p90_seconds)} · ${s.runs} runs`
          )}
        >
          {s.p50_seconds === null ? "none" : signalLabel(s.p50_seconds)}
        </FactPill>
      ))}
      {caption.length > 0 && (
        <Typography
          variant="caption"
          title="Whole days only; the A/B picks below don't change these"
          sx={{ ml: "auto", color: "text.secondary", lineHeight: 1.4 }}
        >
          {caption.map((part, i) => (
            <Fragment key={part}>
              {i > 0 && " · "}
              <Box component="span" sx={{ whiteSpace: "nowrap" }}>
                {part}
                {i === caption.length - 1 && " · A/B picks don't apply"}
              </Box>
            </Fragment>
          ))}
        </Typography>
      )}
    </Box>
  );
}
