// Module-level issue triage tracker. For each `module: *` / `oncall: *` label,
// shows whether its issues are fully triaged within 7 days of creation, as the
// maintainer guide asks:
// https://github.com/pytorch/pytorch/blob/main/docs/source/community/maintainer_guide.md
// Every control lives in the URL (start, label, children) so a maintainer
// can bookmark their own view. `label` repeats once per selected label, e.g.
// ?label=module: nn&label=module: autograd for the modules someone looks after.

import { Alert, Link, Stack, Typography } from "@mui/material";
import IssueLists from "components/triage/IssueLists";
import LabelPicker from "components/triage/LabelPicker";
import LabelTable from "components/triage/LabelTable";
import OutcomeBreakdown from "components/triage/OutcomeBreakdown";
import SummaryTiles from "components/triage/SummaryTiles";
import { WeeklyChart } from "components/triage/TriageCharts";
import TriageControls from "components/triage/TriageControls";
import { useClickHouseAPIImmutable } from "lib/GeneralUtils";
import {
  githubSelectionUrl,
  HISTORY_START_DATE,
  isBeforeHistory,
  IssueRow,
  LabelRow,
  OverviewRow,
  parseLabels,
  parseStart,
  SLA_DAYS,
  STATE_LABELS,
  WeeklyRow,
} from "lib/triage/issueTriage";
import { labelSelection } from "lib/triage/labelTree";
import { useLabelTree } from "lib/triage/useLabelTree";
import NextLink from "next/link";
import { useRouter } from "next/router";

const GUIDE_URL =
  "https://github.com/pytorch/pytorch/blob/main/docs/source/community/maintainer_guide.md";

function emptyLabelRow(label: string): LabelRow {
  return {
    label,
    include_children: 0,
    queue_size: 0,
    overdue: 0,
    oldest_days: 0,
    high_pri_in_queue: 0,
    issues_created: 0,
    sla_eligible: 0,
    met_sla: 0,
    median_days_to_triage: null,
    actionable: 0,
    needs_reproduction: 0,
    needs_research: 0,
    needs_design: 0,
    wont_fix: 0,
    closed: 0,
  };
}

function queryString(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default function IssueTriagePage() {
  const router = useRouter();
  const start = queryString(router.query.start);
  const selected = parseLabels(router.query.label);
  // Page-wide: parents count their child labels' issues, unless
  // ?children=exclude.
  const includeChildren = queryString(router.query.children) !== "exclude";
  const { preset, date: startDate } = parseStart(start);

  // Empty strings and empty lists remove the parameter; lists (`label`) are
  // kept as repeated parameters.
  function setQuery(updates: Record<string, string | string[]>) {
    const query: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries({
      ...router.query,
      ...updates,
    })) {
      if (value === undefined) {
        continue;
      }
      const v = Array.isArray(value) ? value.filter((x) => x !== "") : value;
      if (v.length > 0) {
        query[key] = v;
      }
    }
    router.replace({ pathname: router.pathname, query }, undefined, {
      shallow: true,
    });
  }

  // Queries wait for the label hierarchy too, so parents count their
  // children from the first load.
  const { tree, ready: treeReady } = useLabelTree();
  const ready = router.isReady && treeReady;
  const isAllLabels = selected.length === 0;
  const selection = labelSelection(selected, includeChildren, tree);
  const params = { startDate, ...selection };
  const withoutChildren = (label: string) =>
    !includeChildren && tree.hasChildren(label);

  const { data: overview } = useClickHouseAPIImmutable<OverviewRow>(
    "issue_triage_overview",
    params,
    ready
  );
  const { data: labelModes } = useClickHouseAPIImmutable<LabelRow>(
    "issue_triage_labels",
    {
      startDate,
      descendants: tree.closure.descendants,
      ancestors: tree.closure.ancestors,
    },
    ready
  );
  const { data: weekly } = useClickHouseAPIImmutable<WeeklyRow>(
    "issue_triage_weekly",
    params,
    ready
  );
  const { data: issues } = useClickHouseAPIImmutable<IssueRow>(
    "issue_triage_issues",
    params,
    ready && !isAllLabels
  );

  // One row per label, counted with or without its children as chosen. Every
  // label with issues in its subtree has an include_children = 1 row; a parent
  // with nothing waiting at its own level gets an empty row.
  const labels = labelModes
    ?.filter((row) => row.include_children === 1)
    .map((row) =>
      withoutChildren(row.label)
        ? labelModes.find(
            (r) => r.label === row.label && r.include_children === 0
          ) ?? emptyLabelRow(row.label)
        : row
    );
  // With several labels selected, their rows of the per-label table.
  const selectedLabels = labels?.filter((row) => selected.includes(row.label));
  const githubUrl = githubSelectionUrl(
    selected,
    includeChildren,
    tree,
    startDate
  );

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack direction="row" spacing={2} alignItems="baseline">
        <Typography variant="h5">
          {isAllLabels ? (
            "Module triage"
          ) : (
            <>
              <Link
                component={NextLink}
                href={{
                  pathname: "/triage/modules",
                  query: {
                    ...(start ? { start } : {}),
                    ...(includeChildren ? {} : { children: "exclude" }),
                  },
                }}
              >
                Module triage
              </Link>
              {` / ${selected
                .map((l) => (withoutChildren(l) ? `${l} (parent only)` : l))
                .join(" + ")}`}
            </>
          )}
        </Typography>
        {!isAllLabels && (
          <Link href={githubUrl} target="_blank" rel="noopener noreferrer">
            Open the queue on GitHub
          </Link>
        )}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        The{" "}
        <Link href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
          maintainer guide
        </Link>{" "}
        asks for every issue to be fully triaged within {SLA_DAYS} days of
        creation: closed, or labelled one of {STATE_LABELS.join(", ")}. A
        label&apos;s queue is its open issues with none of those labels, whether
        or not they are marked triaged yet.
      </Typography>

      <LabelPicker
        options={labels?.map((row) => row.label)}
        selected={selected}
        onChange={(value) => setQuery({ label: value })}
      />

      <TriageControls
        preset={preset}
        startDate={startDate}
        onStartChange={(value) => setQuery({ start: value })}
        includeChildren={includeChildren}
        onIncludeChildrenChange={(include) =>
          setQuery({ children: include ? "" : "exclude" })
        }
      />

      {isBeforeHistory(startDate) && (
        <Alert severity="info">
          Label history starts on {HISTORY_START_DATE}. For issues created
          earlier, queue counts are exact but the SLA and time-to-triage numbers
          only count closures, so they understate how much was triaged in time.
        </Alert>
      )}

      <SummaryTiles overview={overview?.[0]} />

      <OutcomeBreakdown overview={overview?.[0]} />

      {isAllLabels ? (
        <LabelTable
          rows={labels}
          tree={tree}
          includeChildren={includeChildren}
          outline
          start={start}
          startDate={startDate}
        />
      ) : (
        <>
          {selected.length > 1 && (
            <LabelTable
              rows={selectedLabels}
              tree={tree}
              includeChildren={includeChildren}
              outline={false}
              start={start}
              startDate={startDate}
            />
          )}
          <IssueLists rows={issues} selection={selection} />
        </>
      )}

      <WeeklyChart rows={weekly} />
    </Stack>
  );
}
