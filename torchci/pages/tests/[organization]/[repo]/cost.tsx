import { Stack } from "@mui/material";
import CoverageBanner from "components/tests/cost/banner/CoverageBanner";
import DrillTable from "components/tests/cost/drill/DrillTable";
import ScopeHead from "components/tests/cost/drill/ScopeHead";
import ScopeTrail from "components/tests/cost/drill/ScopeTrail";
import { useDrill } from "components/tests/cost/drill/useDrill";
import PageFacts from "components/tests/cost/PageFacts";
import RatesControl from "components/tests/cost/rates/RatesControl";
import RateStrip from "components/tests/cost/rates/RateStrip";
import ScopeKeys from "components/tests/cost/ScopeKeys";
import TrendsPanel from "components/tests/cost/trends/TrendsPanel";
import WorkflowsCard from "components/tests/cost/WorkflowsCard";
import HubTabs from "components/tests/HubTabs";
import LoadError from "components/tests/LoadError";
import PageColumn from "components/tests/PageColumn";
import {
  type CostSeries,
  costSeriesUrl,
  costTrendDaysUrl,
  current,
  DEFAULT_SHOW,
  type DrillQuery,
  type RatesSet,
  seriesEcho,
  todayUtc,
  trendDaysParam,
  trendEcho,
  type TrendsQuery,
  type Unit,
} from "lib/api/tests/cost/contracts";
import type { RunnerHours } from "lib/api/tests/cost/types";
import { COST_WINDOW_DAYS } from "lib/api/tests/cost/windows";
import { FACTS_DAYS } from "lib/tests/cost/drill";
import {
  costApiUrl,
  costChoices,
  resolveCostQuery,
} from "lib/tests/cost/query";
import { makePricer, readRatesFiles } from "lib/tests/cost/ratePeriods";
import {
  computeView,
  isScope,
  knownChoices,
  prepareRunnerHours,
  scopeName,
} from "lib/tests/cost/runnerHours";
import {
  rangeText,
  resolveCompare,
  shownRange,
  trendContext,
} from "lib/tests/cost/select";
import { useCostUrl } from "lib/tests/cost/urlState";
import { useCostTrend, useRunnerHours } from "lib/tests/cost/useCost";
import { useSettled } from "lib/tests/cost/useSettled";
import { useApiResource } from "lib/tests/useApiResource";
import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The days an answer covers as the workflows card says them: "Nov 3",
// "Nov 16 – 22", and how many have data when not all of them do.
function datesOf(answer: RunnerHours): string {
  const first = answer.start.slice(0, 10);
  const last = new Date(Date.parse(answer.end) - 1).toISOString().slice(0, 10);
  const range = rangeText({ from: first, to: last });
  const asked = COST_WINDOW_DAYS[answer.window];
  return answer.days < asked
    ? `${range} (${answer.days} of ${asked} days have data)`
    : range;
}

// Where a repository's test-job runner-hours go: the hub's row (HubTabs),
// which is the page's title, with the workflow scope and the rates file at
// its right end, then the headline facts, the coverage banner of what share
// of org CI the page covers, then Trends: the A/B picker over owner- or
// machine-stacked bars, with the drill-down (trail, head, table) inside it,
// every part following the trail. The workflows card comes last, folded,
// from the 7-day answer, which also lends machine hues; the trend never
// waits for it.
//
// Every choice lives in the URL through useCostUrl, the page's one writer;
// the rates file stays in this component's memory (never the URL, storage
// or a request).
export default function Page() {
  const router = useRouter();
  const { organization, repo: repoName } = router.query;
  const repo =
    typeof organization === "string" && typeof repoName === "string"
      ? `${organization}/${repoName}`
      : undefined;
  const q = useMemo(() => resolveCostQuery(router.query), [router.query]);
  const write = useCostUrl();
  const workflows = q.workflows;
  const t = q.trends;
  const show = t.show ?? DEFAULT_SHOW[t.rollup];

  // ── The trend: one day-rollup fetch; weeks and months fold in the browser.
  // todayUtc() builds only this URL; everything else reads ctx.end. It
  // holds a week past the facts' days at least, for their owners' share. ──
  const trendUrl = repo
    ? costTrendDaysUrl(
        repo,
        workflows,
        Math.max(
          FACTS_DAYS + 7,
          trendDaysParam(shownRange(t.rollup, show, todayUtc()))
        )
      )
    : null;
  const trend = useCostTrend(trendUrl);
  // The facts read any trend of this repository and workflow scope: a new
  // Show leaves them as they are.
  const factsTrend =
    repo !== undefined &&
    trend.trend !== undefined &&
    costTrendDaysUrl(trend.trend.repo, trend.trend.workflows, 0) ===
      costTrendDaysUrl(repo, workflows, 0)
      ? trend.trend
      : undefined;
  const ctx = useMemo(
    () => (trend.trend ? trendContext(trend.trend) : null),
    [trend.trend]
  );
  const shown = ctx && shownRange(t.rollup, show, ctx.end);
  const compare = ctx ? resolveCompare(t, ctx) : null;

  // ── Rates, in memory only ──
  const [rates, setRates] = useState<RatesSet | null>(null);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const pricer = useMemo(() => (rates ? makePricer(rates) : null), [rates]);
  const unit: Unit = t.unit === "usd" && pricer ? "usd" : "hours";
  const labels = trend.trend?.labels;
  const ratesRef = useRef(rates);
  ratesRef.current = rates;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  // A dropped or picked rates.json (with its rates.meta.json, or a meta
  // alone for the held file); a bad drop keeps the loaded rates and says why.
  const takeRates = useCallback((files: File[]) => {
    readRatesFiles(files, labelsRef.current ?? [], ratesRef.current)
      .then((next) => {
        setRates(next);
        setRatesError(null);
      })
      .catch((e) => setRatesError(e instanceof Error ? e.message : String(e)));
  }, []);
  // Files dragged anywhere over the page load as rates, and are never opened
  // in a tab.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) takeRates(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [takeRates]);

  // ── The 7-day answer: machine hues, the facts' signals and the workflows
  // card ──
  const request = useRunnerHours(repo ? costApiUrl(repo, q.window) : null);
  const answer = request.runnerHours;
  const prepared = useMemo(
    () => (answer === undefined ? undefined : prepareRunnerHours(answer)),
    [answer]
  );
  const choices = useMemo(
    () =>
      prepared === undefined
        ? undefined
        : knownChoices(prepared, costChoices(q)),
    [prepared, q]
  );
  const view = useMemo(
    () =>
      prepared === undefined || choices === undefined
        ? undefined
        : computeView(prepared, choices),
    [prepared, choices]
  );

  // ── The drill, on A/B once a gesture settles ──
  const onDrillChange = useCallback(
    (patch: Partial<DrillQuery>) => write({ drill: patch }),
    [write]
  );
  const onTrendsChange = useCallback(
    (patch: Partial<TrendsQuery>) => write({ trends: patch }),
    [write]
  );
  // The drill reads its answer's A/B per bar of the rollup they were
  // snapped to.
  const settled = useSettled(compare, 400);
  const drill = useDrill({
    repo,
    workflows,
    compare: settled,
    query: q.drill,
    onQueryChange: onDrillChange,
    per: t.per,
    rollup: settled?.rollup ?? t.rollup,
    unit,
    pricer,
    runnerHours: prepared,
  });

  // ── The bars of every scope but the owner root: /series(trail, by), asked
  // once the scope holds still; only an answer for the scope drawn now
  // counts, so a settling scope keeps the last bars dimmed. ──
  const wantedSeriesUrl =
    repo && shown && !drill.bars.fromTrend
      ? costSeriesUrl(repo, workflows, drill.bars.trail, drill.bars.by, shown)
      : null;
  const seriesUrl = useSettled(wantedSeriesUrl, 250, String);
  const seriesRes = useApiResource<CostSeries>(seriesUrl, {
    keepPreviousData: true,
  });
  const series = current(seriesRes.data, wantedSeriesUrl, seriesEcho);

  // ── The workflow scope: pushes a history entry ──
  const setWorkflows = (next: string[]) => write({ workflows: next }, "push");
  const workflowScope =
    workflows.length === 0
      ? null
      : prepared && view && view.scope.size > 0
      ? scopeName(prepared, view)
      : workflows.join(", ");
  const preset = (answer?.workflow_presets ?? []).find(
    (p) => workflows.length > 0 && isScope(workflows, p.workflows)
  );

  // The hub's row is the page's title; its choices are the two that apply to
  // everything the page shows.
  const row = (
    <HubTabs repo={repo} current="cost">
      <ScopeKeys
        presets={answer?.workflow_presets ?? []}
        scope={workflows}
        scopeLabel={workflowScope ?? "all workflows"}
        onScopeChange={setWorkflows}
        showCustom
      />
      <RatesControl
        rates={rates}
        error={ratesError}
        dragging={dragging}
        exampleLabels={(labels ?? []).slice(0, 2)}
        onFiles={takeRates}
        onClear={() => {
          setRates(null);
          setRatesError(null);
        }}
        onDismissError={() => setRatesError(null)}
      />
    </HubTabs>
  );
  return (
    <PageColumn>
      {row}
      <Stack spacing={1.5}>
        <PageFacts
          trend={factsTrend}
          scope={preset?.label ?? workflowScope ?? "all workflows"}
          scopeDetail={
            preset === undefined && workflows.length > 3
              ? workflows.join(", ")
              : undefined
          }
          unit={unit}
          pricer={pricer}
          runnerHours={answer}
        />
        <CoverageBanner
          repo={repo}
          workflows={workflows}
          b={compare?.b ?? null}
          shown={shown}
          end={ctx?.end ?? null}
          unit={unit}
          pricer={pricer}
        />
      </Stack>
      <TrendsPanel
        answer={trend.trend}
        context={ctx}
        loading={
          trendUrl !== null && !current(trend.trend, trendUrl, trendEcho)
        }
        query={t}
        compare={compare}
        onQueryChange={onTrendsChange}
        pricer={pricer}
        runnerHours={prepared}
        scope={drill.bars}
        series={series}
        seriesLoading={!drill.bars.fromTrend && !series}
        workflowScope={workflowScope}
        slots={{
          trail: <ScopeTrail drill={drill} />,
          head: <ScopeHead drill={drill} />,
          table: <DrillTable drill={drill} />,
        }}
        renderStrip={(g) =>
          pricer && !pricer.set.legacy ? (
            <RateStrip pricer={pricer} {...g} />
          ) : null
        }
      />
      {trend.error !== undefined && (
        <LoadError
          what="the trend"
          error={trend.error}
          onRetry={() => void trend.retry()}
        />
      )}
      {request.error !== undefined && (
        <LoadError
          what="the runner-hours"
          error={request.error}
          onRetry={() => void request.retry()}
        />
      )}
      {prepared !== undefined && view !== undefined && answer !== undefined && (
        <WorkflowsCard
          prepared={prepared}
          view={view}
          presets={answer.workflow_presets}
          scope={workflows}
          loading={request.isLoading}
          dates={datesOf(answer)}
          onScopeChange={setWorkflows}
          defaultOpen={false}
        />
      )}
    </PageColumn>
  );
}
