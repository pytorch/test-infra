import { Box } from "@mui/material";
import { signalLabel } from "components/tests/cost/CostFacts";
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
import { useMemo } from "react";

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

// The page's headline facts under its title, in V1's pills and order: the
// workflow scope, a year, per day, per commit and the share with an owner
// over the last 28 whole days (pageFacts), then the PR signals of the last 7
// days. The repository and workflow scope only: never the trail or A/B. The
// window is said in the row's title, not on screen.
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
  const window = facts?.window ?? undefined;
  const pricing =
    facts !== null && pricer !== null && usd
      ? [
          facts.perDay.priced
            ? `${facts.perDay.priced.days} of ${facts.perDay.priced.of} days priced`
            : null,
          ...pricingNotes(pricer, facts.days).lines,
        ]
      : [];
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
  const signals = runnerHours?.time_to_signal ?? [];
  const signalDays = runnerHours ? COST_WINDOW_DAYS[runnerHours.window] : 0;
  const signalEnd = runnerHours?.end.slice(0, 10);
  const signalWindow = signalEnd
    ? `Last ${signalDays} days, ${rangeText({
        from: addDays(signalEnd, -signalDays),
        to: addDays(signalEnd, -1),
      })}`
    : null;
  return (
    <Box
      component="section"
      aria-label="Page facts"
      title={window}
      sx={{ display: "flex", flexWrap: "wrap", gap: 1, typography: "body2" }}
    >
      <FactPill label="Across" title={lines(window, scopeDetail)}>
        {scope}
      </FactPill>
      <FactPill
        label="Annualized"
        muted={blank(perDay)}
        title={
          perDay?.value == null
            ? undefined
            : lines(
                window,
                `${said(
                  perDay,
                  (v) =>
                    usd ? amount("usd", v) : `${hoursLabel(v)} runner-hours`,
                  365 / 12
                )} a month`,
                ...pricing
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
        title={usd ? lines(window, ...pricing) : undefined}
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
                window,
                `${
                  usd ? "$" : "Runner-hours"
                } of pushes to main ÷ ${perCommit.pushes.toLocaleString(
                  "en-US"
                )} pushes`,
                ...pricing
              )
        }
      >
        {said(perCommit, (v) => amount(usd ? "usd" : "hours", v))}
      </FactPill>
      <FactPill
        label="Attributed to owners"
        muted={facts !== null && facts.owned === null}
        title={lines(
          window,
          "Share of runner-hours in test files with an owner"
        )}
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
    </Box>
  );
}
