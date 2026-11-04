import { Box, Stack } from "@mui/material";
import AccessNotice from "components/tests/AccessNotice";
import CellDrawer, { type OpenCell } from "components/tests/cost/CellDrawer";
import CostFacts from "components/tests/cost/CostFacts";
import CostHeading from "components/tests/cost/CostHeading";
import CostMatrix, { type MatrixCell } from "components/tests/cost/CostMatrix";
import OwnerChart from "components/tests/cost/OwnerChart";
import WorkflowsCard from "components/tests/cost/WorkflowsCard";
import LoadError from "components/tests/LoadError";
import LoadTime from "components/tests/LoadTime";
import PageColumn from "components/tests/PageColumn";
import type { RunnerHours } from "lib/api/tests/cost/types";
import { COST_WINDOW_DAYS } from "lib/api/tests/cost/windows";
import {
  costApiUrl,
  type CostQuery,
  costUrlParams,
  resolveCostQuery,
} from "lib/tests/cost/query";
import {
  computeView,
  type CostChoices,
  factsOf,
  knownChoices,
  ownerRows,
  prepareRunnerHours,
  scopeName,
  toggled,
} from "lib/tests/cost/runnerHours";
import { useRunnerHours } from "lib/tests/cost/useCost";
import { accessReasonOf } from "lib/tests/table";
import { mergedUrlQuery } from "lib/tests/url";
import { useSession } from "next-auth/react";
import Router, { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";

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
  const toggleOwners = (owners: string[]) =>
    change((current) => ({ owners: toggled(current.owners, owners) }));
  const toggleMachines = (machines: string[]) =>
    change((current) => ({ machines: toggled(current.machines, machines) }));

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
      else if (query.owners.length > 0 || query.machines.length > 0)
        clearHighlight();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
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
              onClearMachines={() => change({ machines: [] })}
            />
            <LoadTime
              timing={answer.timing ?? null}
              loading={request.isLoading}
            />
          </Box>
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
            onCellChange={setCell}
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
        </>
      )}
    </PageColumn>
  );
}
