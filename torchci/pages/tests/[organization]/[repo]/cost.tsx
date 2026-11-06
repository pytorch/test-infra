import { Box, Stack } from "@mui/material";
import AccessNotice from "components/tests/AccessNotice";
import CellDrawer, { type OpenCell } from "components/tests/cost/CellDrawer";
import CostFacts from "components/tests/cost/CostFacts";
import CostHeading from "components/tests/cost/CostHeading";
import CostMatrix, { type MatrixCell } from "components/tests/cost/CostMatrix";
import CostPanel from "components/tests/cost/CostPanel";
import OwnerChart from "components/tests/cost/OwnerChart";
import RunnersDrawer from "components/tests/cost/RunnersDrawer";
import TrendPanel from "components/tests/cost/TrendPanel";
import WorkflowsCard from "components/tests/cost/WorkflowsCard";
import LoadError from "components/tests/LoadError";
import LoadTime from "components/tests/LoadTime";
import PageColumn from "components/tests/PageColumn";
import type { RunnerHours } from "lib/api/tests/cost/types";
import {
  COST_WINDOW_DAYS,
  DEFAULT_TREND_ROLLUP,
  type TrendRollup,
} from "lib/api/tests/cost/windows";
import {
  costApiUrl,
  type CostQuery,
  costTrendApiUrl,
  costUrlParams,
  resolveCostQuery,
} from "lib/tests/cost/query";
import {
  costFacts,
  MAX_RATES_BYTES,
  parseRates,
  priceableRunners,
  pricedRunnerHours,
  ratesCoverage,
  type RatesFile,
  withRate,
} from "lib/tests/cost/rates";
import {
  computeView,
  type CostChoices,
  factsOf,
  knownChoices,
  type OwnerRow,
  ownerRows,
  prepareRunnerHours,
  scopeName,
  toggled,
} from "lib/tests/cost/runnerHours";
import { useCostTrend, useRunnerHours } from "lib/tests/cost/useCost";
import { accessReasonOf } from "lib/tests/table";
import { mergedUrlQuery } from "lib/tests/url";
import { useSession } from "next-auth/react";
import Router, { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useState } from "react";

// Choices as the URL's query takes them: arrays it may own.
function copied(choices: CostChoices) {
  return {
    workflows: [...choices.workflows],
    owners: [...choices.owners],
    machines: [...choices.machines],
  };
}

// The days an answer covers as every panel says them: "2026-11-03",
// "2026-10-28 to 11-03", and how many have data when not all of them do.
function datesOf(answer: RunnerHours): string {
  const first = answer.start.slice(0, 10);
  const last = new Date(Date.parse(answer.end) - 1).toISOString().slice(0, 10);
  const range =
    first === last
      ? first
      : `${first} to ${
          last.slice(0, 4) === first.slice(0, 4) ? last.slice(5) : last
        }`;
  const asked = COST_WINDOW_DAYS[answer.window];
  return answer.days < asked
    ? `${range} (${answer.days} of ${asked} days have data)`
    : range;
}

// Where a repository's CI runner-hours go, by owner, machine and workflow,
// from one answer of GET /api/tests/cost summed in the browser
// (lib/tests/cost/runnerHours.ts). The window, which fetches a new answer,
// and the workflow scope are the only choices that change the numbers;
// owners and machines highlight. Every choice travels in
// the URL under COST_PAGE_PARAMETER_DEFINITIONS' names, left off at its
// default; the presets come with the runner-hours. The page never queries the
// database; the API is behind the HUD GitHub gate, which the browser passes
// with its sign-in.
//
// Cost is a panel of its own under the runner-hours chart (CostPanel), from
// a rates file the reader adds (lib/tests/cost/rates.ts), its rates editable
// in the panel's key: held in this component's state only, never in the URL,
// storage or a request, and so are the panel's split keys. It follows the
// page's scope and highlight; with a file the facts gain a row in $, and the
// matrix and the workflows card stay in runner-hours.
//
// The trend (TrendPanel), under the cost panel, has its own periods from GET
// /api/tests/cost/trend, asked with the page's workflow scope; it shows the
// owner highlight and sets it, and reads the rates file and its budget. Its
// rollup, periods and order stay in its state, out of the URL.
export default function Page() {
  const router = useRouter();
  const organization = router.query.organization;
  const repo = router.query.repo;
  const repository =
    typeof organization === "string" && typeof repo === "string"
      ? `${organization}/${repo}`
      : undefined;
  const session = useSession();
  const query = useMemo(() => resolveCostQuery(router.query), [router.query]);
  const apiUrl = repository ? costApiUrl(repository, query.window) : null;
  const request = useRunnerHours(apiUrl);
  const [cell, setCell] = useState<MatrixCell | null>(null);
  const [matrixExpanded, setMatrixExpanded] = useState(false);
  const [rates, setRates] = useState<RatesFile | null>(null);
  const [ratesError, setRatesError] = useState<string | null>(null);
  const [costSplit, setCostSplit] = useState(true);
  // The key of the owner chart row whose runners drawer is open.
  const [runnersKey, setRunnersKey] = useState<string | null>(null);
  const [trendRollup, setTrendRollup] =
    useState<TrendRollup>(DEFAULT_TREND_ROLLUP);

  const prepared = useMemo(
    () =>
      request.runnerHours === undefined
        ? undefined
        : prepareRunnerHours(request.runnerHours),
    [request.runnerHours]
  );
  const choices = useMemo(
    () => (prepared === undefined ? undefined : knownChoices(prepared, query)),
    [prepared, query]
  );
  const view = useMemo(
    () =>
      prepared === undefined || choices === undefined
        ? undefined
        : computeView(prepared, choices),
    [prepared, choices]
  );
  // The answer priced by the rates file added, for the cost panel and its
  // runners drawer.
  const priced = useMemo(
    () =>
      prepared === undefined || rates === null
        ? undefined
        : pricedRunnerHours(prepared, rates),
    [prepared, rates]
  );
  const pricedView = useMemo(
    () =>
      priced === undefined || choices === undefined
        ? undefined
        : computeView(priced, choices),
    [priced, choices]
  );
  // The trend in the page's scope: as the URL names it until the
  // runner-hours arrive, then without the names they do not hold.
  const trendRequest = useCostTrend(
    repository
      ? costTrendApiUrl(
          repository,
          trendRollup,
          choices?.workflows ?? query.workflows
        )
      : null
  );

  // Reads a rates file into memory; a bad file leaves the loaded rates as
  // they were and says what is wrong with it.
  const loadRates = useCallback(
    async (file: File) => {
      try {
        if (file.size > MAX_RATES_BYTES) {
          throw new Error(
            `${file.name} is ${Math.round(
              file.size / 1000
            )} KB; a rates file is a few KB.`
          );
        }
        const next = parseRates(await file.text(), file.name);
        // A file pricing no runner here is a file of something else (or of
        // misspelled labels): it would draw every bar at $0.
        if (
          prepared !== undefined &&
          ratesCoverage(prepared, next).priced === 0
        ) {
          const [example] = priceableRunners(prepared);
          throw new Error(
            `None of ${
              file.name
            }'s labels ran in this window; keys are runner labels${
              example === undefined ? "" : ` like ${example.label}`
            }.`
          );
        }
        setRates(next);
        setRatesError(null);
      } catch (e) {
        setRatesError(e instanceof Error ? e.message : String(e));
      }
    },
    [prepared]
  );
  const openRunners = (row: OwnerRow) => {
    setCell(null);
    setRunnersKey(runnersKey === row.key ? null : row.key);
  };
  const openCellDrawer = (next: MatrixCell | null) => {
    if (next !== null) setRunnersKey(null);
    setCell(next);
  };
  // The runners drawer's row, looked up by key in the $ answer as it is now,
  // as the opened cell is: "N more owners" recounted when one of them is
  // highlighted, and closed when its owner has no hours in the scope.
  const runnersRow = useMemo((): OwnerRow | null => {
    if (runnersKey === null || pricedView === undefined) return null;
    const row = ownerRows(pricedView, false, "grouped").find(
      (r) => r.key === runnersKey
    );
    if (row !== undefined) return row;
    // An owner listed under the expanded "N more owners".
    return (pricedView.ownerRunnerHours.get(runnersKey) ?? 0) > 0
      ? {
          key: runnersKey,
          label: runnersKey,
          owners: [runnersKey],
          hours: pricedView.ownerScope.get(runnersKey) ?? 0,
          kind: "owner",
        }
      : null;
  }, [runnersKey, pricedView]);
  // The opened cell, looked up by name in the matrix as it is now: closed
  // when its row or machine is gone, as when a highlighted owner leaves
  // "N more owners".
  const openCell = useMemo((): OpenCell | null => {
    if (cell === null || prepared === undefined || view === undefined) {
      return null;
    }
    const row = ownerRows(view, matrixExpanded, "each").find(
      (r) => r.key === cell.rowKey && r.kind !== "less"
    );
    const machine = prepared.machines.indexOf(cell.machine);
    return row !== undefined && machine >= 0 ? { row, machine } : null;
  }, [cell, prepared, view, matrixExpanded]);

  // Writes a change into the URL, each choice under its name and left off
  // at its default. It starts from the URL as it is when it fires, read from
  // the router itself (useRouter's is this render's copy), so changes in
  // quick succession never undo one another; a toggle is a function of it.
  // Names the answer does not hold leave the URL with the next change, as they
  // have already left the page.
  const change = (
    patch: Partial<CostQuery> | ((_current: CostQuery) => Partial<CostQuery>)
  ) => {
    if (repository === undefined) return;
    const asked = resolveCostQuery(Router.query);
    // A new window brings a new answer, which may hold names this one lacks:
    // keep the choices as asked.
    const newWindow = typeof patch !== "function" && patch.window !== undefined;
    const current =
      prepared === undefined || newWindow
        ? asked
        : { ...asked, ...copied(knownChoices(prepared, asked)) };
    const next = {
      ...current,
      ...(typeof patch === "function" ? patch(current) : patch),
    };
    void Router.push(
      {
        pathname: Router.pathname,
        query: mergedUrlQuery(Router.query, costUrlParams(next)),
      },
      undefined,
      { shallow: true, scroll: false }
    );
  };
  const clearHighlight = () =>
    change({ owners: [], machines: [], only: false });
  // "Only selected" goes with the last of the highlight, so it never hides
  // the matrix at the next one unasked.
  const toggleOwners = (owners: string[]) =>
    change((current) => {
      const next = toggled(current.owners, owners);
      return {
        owners: next,
        only: current.only && next.length + current.machines.length > 0,
      };
    });
  const toggleMachines = (machines: string[]) =>
    change((current) => {
      const next = toggled(current.machines, machines);
      return {
        machines: next,
        only: current.only && current.owners.length + next.length > 0,
      };
    });
  const clearMachines = () =>
    change((current) => ({
      machines: [],
      only: current.only && current.owners.length > 0,
    }));

  // Escape closes the drawer, then clears the highlight, unless a text field
  // or menu took it for itself.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          "input:not([type=checkbox]):not([type=radio]), textarea, select, [role='menu'], [role='listbox']"
        )
      ) {
        return;
      }
      if (openCell !== null) setCell(null);
      else if (runnersRow !== null) setRunnersKey(null);
      else if (query.owners.length > 0 || query.machines.length > 0)
        clearHighlight();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // A file dropped anywhere is never opened in a tab, even before the cost
  // panel (which takes it) is there: while loading, on an error, without
  // access.
  useEffect(() => {
    const keep = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);
  // A new scope leaves the opened cell behind.
  const scopeKey = query.workflows.join(",");
  useEffect(() => setCell(null), [scopeKey]);

  const signedIn = session.status === "authenticated";
  const accessReason = accessReasonOf(request.error, signedIn);
  const scope =
    prepared && view && view.scope.size > 0 ? scopeName(prepared, view) : null;
  const answer = request.runnerHours;
  const heading = (
    <CostHeading
      repo={repository}
      window={query.window}
      onWindowChange={(window) => change({ window })}
    />
  );
  if (accessReason !== undefined) {
    return (
      <PageColumn>
        {heading}
        <AccessNotice reason={accessReason} />
      </PageColumn>
    );
  }
  const dates = answer ? datesOf(answer) : "";
  const ready =
    repository !== undefined &&
    choices !== undefined &&
    prepared !== undefined &&
    view !== undefined &&
    answer !== undefined;
  return (
    <PageColumn>
      <Stack spacing={1.5}>
        {heading}
        <CostFacts
          facts={ready ? factsOf(prepared, view, answer.days) : undefined}
          dates={dates}
          loading={request.isLoading}
          scope={scope}
          signals={answer?.time_to_signal}
          onClearScope={() => change({ workflows: [] })}
          cost={
            ready &&
            rates !== null &&
            priced !== undefined &&
            pricedView !== undefined
              ? {
                  ...costFacts(priced, pricedView, answer.days),
                  file: rates.file,
                }
              : undefined
          }
        />
      </Stack>
      {request.error !== undefined && (
        <LoadError
          what="the runner-hours"
          error={request.error}
          onRetry={() => void request.retry()}
        />
      )}
      {ready && (
        <>
          <Box>
            <OwnerChart
              repo={repository}
              prepared={prepared}
              view={view}
              presets={answer.workflow_presets}
              scope={choices.workflows}
              split={query.split}
              loading={request.isLoading}
              dates={dates}
              method={answer.method}
              onScopeChange={(workflows) => change({ workflows })}
              onSplitChange={(split) => change({ split })}
              onToggleOwners={toggleOwners}
              onToggleMachines={toggleMachines}
              onClearHighlight={clearHighlight}
              onClearMachines={clearMachines}
            />
            <LoadTime
              timing={answer.timing ?? null}
              loading={request.isLoading}
            />
          </Box>
          <CostPanel
            prepared={prepared}
            rates={rates}
            error={ratesError}
            onFile={loadRates}
            onClear={() => {
              setRates(null);
              setRatesError(null);
              setRunnersKey(null);
              setCostSplit(true);
            }}
            onDismissError={() => setRatesError(null)}
            onUndoEdits={() =>
              setRates((current) =>
                current === null
                  ? null
                  : { ...current, rates: current.original }
              )
            }
            chart={(frame) =>
              priced !== undefined &&
              pricedView !== undefined && (
                <OwnerChart
                  repo={repository}
                  prepared={priced}
                  view={pricedView}
                  presets={answer.workflow_presets}
                  scope={choices.workflows}
                  split={costSplit}
                  loading={request.isLoading}
                  dates={dates}
                  method={answer.method}
                  onScopeChange={(workflows) => change({ workflows })}
                  onSplitChange={setCostSplit}
                  onToggleOwners={toggleOwners}
                  onToggleMachines={toggleMachines}
                  onClearHighlight={clearHighlight}
                  onClearMachines={clearMachines}
                  onOpenRunners={openRunners}
                  runnersKey={runnersRow?.key ?? null}
                  onRateChange={(key, rate) =>
                    setRates((current) =>
                      current === null ? null : withRate(current, key, rate)
                    )
                  }
                  originalRates={rates?.original}
                  {...frame}
                />
              )
            }
          />
          <TrendPanel
            answer={trendRequest.trend}
            loading={trendRequest.isLoading}
            rollup={trendRollup}
            onRollupChange={setTrendRollup}
            rates={rates}
            scope={scope}
            highlighted={choices.owners}
            onToggleOwners={toggleOwners}
            runnerHours={prepared}
          />
          {trendRequest.error !== undefined && (
            <LoadError
              what="the trend"
              error={trendRequest.error}
              onRetry={() => void trendRequest.retry()}
            />
          )}
          <CostMatrix
            prepared={prepared}
            view={view}
            cells={query.cells}
            only={query.only}
            loading={request.isLoading}
            dates={dates}
            fileName={`runner_hours_${repository.replace(
              "/",
              "_"
            )}_${answer.start.slice(0, 10)}_${answer.days}d.csv`}
            cell={openCell === null ? null : cell}
            expanded={matrixExpanded}
            onExpandedChange={setMatrixExpanded}
            onCellsChange={(cells) => change({ cells })}
            onOnlyChange={(only) => change({ only })}
            onToggleOwners={toggleOwners}
            onToggleMachines={toggleMachines}
            onCellChange={openCellDrawer}
          />
          <WorkflowsCard
            prepared={prepared}
            view={view}
            presets={answer.workflow_presets}
            scope={choices.workflows}
            loading={request.isLoading}
            dates={dates}
            onScopeChange={(workflows) => change({ workflows })}
          />
          <CellDrawer
            prepared={prepared}
            view={view}
            cell={openCell}
            onClose={() => setCell(null)}
          />
          {priced !== undefined && pricedView !== undefined && (
            <RunnersDrawer
              prepared={priced}
              view={pricedView}
              row={runnersRow}
              ratesFile={rates?.file ?? null}
              onClose={() => setRunnersKey(null)}
            />
          )}
        </>
      )}
    </PageColumn>
  );
}
