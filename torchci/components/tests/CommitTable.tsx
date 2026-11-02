import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import {
  Box,
  IconButton,
  Skeleton,
  Stack,
  Typography,
  useTheme,
} from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { GridColDef, GridSortModel } from "@mui/x-data-grid";
import { AttemptPill } from "components/tests/AttemptPill";
import {
  CELL_ROOT_SX,
  CellBlock,
  CellFrame,
  CellLines,
} from "components/tests/CellBlock";
import ColumnTitle from "components/tests/ColumnTitle";
import HeaderFilter from "components/tests/HeaderFilter";
import HubDataGrid from "components/tests/HubDataGrid";
import LoadError from "components/tests/LoadError";
import LoadTime from "components/tests/LoadTime";
import {
  environmentColumn,
  filterColumnProps,
  HubRow,
  nameColumn,
  ownersColumn,
  testConfigColumn,
} from "components/tests/sharedColumns";
import TestName from "components/tests/TestName";
import TextButton from "components/tests/TextButton";
import TextLink from "components/tests/TextLink";
import Updated from "components/tests/Updated";
import type { TestOptions } from "lib/api/tests/options/types";
import { testPagePath } from "lib/api/tests/pages/parameters";
import type { RunRecord } from "lib/api/tests/test/runs/types";
import {
  attemptGroupCount,
  attemptGroupLabel,
  attemptsCaption,
  BUNDLE_STATUS_WORDS,
  bundleDuration,
  BundleStatus,
} from "lib/tests/bundle";
import { clockLabel, problemHue, STATUS_TITLES } from "lib/tests/commit";
import {
  COMMIT_COLUMN_DESCRIPTIONS,
  COMMIT_TABLE_SORT_FIELDS,
  CommitTableRow,
  commitTableRows,
  DEFAULT_COMMIT_SORT,
  gridChunks,
  runStatus,
  STATUS_CHOICES,
  statusesSummary,
} from "lib/tests/commitPage";
import type { Token } from "lib/tests/environment";
import { FacetValues, noFacetValues } from "lib/tests/facets";
import { OUTCOME_WORDS } from "lib/tests/grid";
import { jobDetailLine, parseJobName } from "lib/tests/jobName";
import { COMMIT_COLUMN_WIDTHS } from "lib/tests/layout";
import { CELL_HORIZONTAL_PADDING } from "lib/tests/rows";
import { durationLabel, sortModelOf, sortParamOf } from "lib/tests/table";
import { FILTERABLE_HEADER } from "lib/tests/tableStyle";
import { useMounted } from "lib/tests/useMounted";
import type { PageTiming } from "lib/tests/useTestsListing";
import { useMemo, useState } from "react";

// A row of the grid: one of the table's rows (CommitTableRow in
// lib/tests/commitPage.ts) with what the shared columns read (HubRow); a
// row of attempts and the "Show more" row span every column and carry
// nothing for them.
type CommitRow = CommitTableRow & HubRow;

// The chevron before a name, and the room it takes, which the rows of
// attempts under the run indent by so their first column lines up with
// the name.
const CHEVRON_SIZE = 20;
const CHEVRON_GAP = 4;
const CHEVRON_INDENT = CHEVRON_SIZE + CHEVRON_GAP;
// The attempts rows' last part, the message, spans the four columns after
// Duration, less the cell's own padding at its right, so the parts before
// it line up with the columns (see AttemptRow).
const MESSAGE_WIDTH =
  COMMIT_COLUMN_WIDTHS.environment +
  COMMIT_COLUMN_WIDTHS.test_config +
  COMMIT_COLUMN_WIDTHS.job +
  COMMIT_COLUMN_WIDTHS.owners -
  CELL_HORIZONTAL_PADDING;

export interface CommitTableProps {
  // The repository as owner/name, for the rows' links to their tests' pages.
  repo: string;
  // The runs loaded, in the API's order: by outcome, then the sort.
  runs: readonly RunRecord[];
  // The first page is on its way.
  loading: boolean;
  // A further page is on its way.
  loadingMore: boolean;
  // Another page follows the loaded ones.
  hasMore: boolean;
  // The "Show more" row clicked: load the next page.
  onLoadMore: () => void;
  // The outcomes listed, which the Outcome filter chooses.
  statuses: readonly BundleStatus[];
  onStatusesChange: (_statuses: BundleStatus[]) => void;
  // Any failure loading the runs, and the means to ask again.
  error: unknown;
  onRetry: () => void;
  // How long the first page took; null before it arrives.
  timing: PageTiming | null;
  // When the summary shown arrived, for the "Updated" caption.
  refreshedAt: string | null;
  // The API sort parameter in force; the headers change it.
  sort: string;
  onSortChange: (_sort: string) => void;
  // The options, for the labels of the environment cells and the values
  // the headers' filters offer; undefined before they arrive.
  options: TestOptions | undefined;
  // The facet filters in force, which the headers show.
  filters: FacetValues;
  onFiltersChange: (_next: Partial<FacetValues>) => void;
  // A value clicked in a cell: the facets it stands for, to filter by.
  onFilter: (_filters: Token["filters"]) => void;
  // The text searched for, as the Name header's field shows it.
  search: string;
  onSearchInput: (_text: string) => void;
  onSearch: (_text: string) => void;
}

// The chevron that opens a run's attempts.
function Chevron({
  open,
  label,
  onClick,
}: {
  open: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <IconButton
      size="small"
      aria-label={label}
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      sx={{
        flex: "none",
        width: CHEVRON_SIZE,
        height: CHEVRON_SIZE,
        p: 0,
        color: "text.secondary",
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 120ms",
      }}
    >
      <ChevronRightIcon fontSize="small" />
    </IconButton>
  );
}

// A time of day filled in on the client only.
function Clock({ timestamp }: { timestamp: string }) {
  const mounted = useMounted();
  return <>{mounted ? `Started ${clockLabel(timestamp)}` : ""}</>;
}

// The "Show more" row: text that acts, with a down chevron; a shimmer while
// the page it asked for is on its way.
function MoreRow({
  row,
  onClick,
}: {
  row: Extract<CommitRow, { kind: "more" }>;
  onClick: () => void;
}) {
  const label = "Show more";
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        pl: `${CHEVRON_INDENT}px`,
        color: row.loading ? "text.disabled" : "text.secondary",
      }}
    >
      {row.loading ? (
        // The rows on their way shimmer where they will land, under the
        // table's progress bar.
        <Skeleton variant="text" sx={{ width: "22ch" }} />
      ) : (
        <TextButton label={label} onClick={onClick}>
          <ExpandMoreIcon
            fontSize="inherit"
            sx={{ verticalAlign: "-0.2em", mr: 0.5 }}
          />
          {label}
        </TextButton>
      )}
    </Box>
  );
}

// A row of attempts under a run, lined up with the columns: under Name,
// "Attempt 1" over when it started; under Outcome, the attempts' pill,
// "Failed ×9" when the row stands for several; under Duration, their time;
// across the rest, the first line of the message and a link to the job's
// log. The parts take the columns' widths; the Name part takes what is
// left, as the Name column does.
function AttemptRow({
  row,
  theme,
}: {
  row: Extract<CommitRow, { kind: "attempts" }>;
  theme: Theme;
}) {
  const { group, run } = row;
  const count = attemptGroupCount(group);
  const executed = group.attempts.some(
    (attempt) => attempt.outcome !== "skipped"
  );
  const duration = !executed
    ? "—"
    : group.attempts.length > 1
    ? `${durationLabel(group.duration_milliseconds)} in all`
    : durationLabel(group.duration_milliseconds);
  const part = (width: number) => ({
    flex: "none",
    width,
    boxSizing: "border-box" as const,
    pl: `${CELL_HORIZONTAL_PADDING}px`,
    minWidth: 0,
  });
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        width: "100%",
        minWidth: 0,
        lineHeight: 1.25,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0, pl: `${CHEVRON_INDENT}px` }}>
        <CellLines
          lead={attemptGroupLabel(group)}
          caption={<Clock timestamp={group.attempts[0].started_at} />}
        />
      </Box>
      <Box sx={part(COMMIT_COLUMN_WIDTHS.outcome)}>
        <AttemptPill outcome={group.outcome} theme={theme}>
          {OUTCOME_WORDS[group.outcome]}
          {count !== undefined && (
            <Box component="span" sx={{ ml: 0.5, opacity: 0.8 }}>
              {count}
            </Box>
          )}
        </AttemptPill>
      </Box>
      <Box sx={part(COMMIT_COLUMN_WIDTHS.duration)}>{duration}</Box>
      <Box sx={{ ...part(MESSAGE_WIDTH), display: "flex", gap: 1.5 }}>
        <Typography
          component="span"
          variant="body2"
          title={group.attempts[0].outcome_summary || undefined}
          sx={{
            flex: 1,
            minWidth: 0,
            overflowWrap: "anywhere",
            color: group.message === "" ? "text.disabled" : "text.primary",
          }}
        >
          {group.message === "" ? "No message" : group.message}
        </Typography>
        {run.github_workflow.job_url !== null && (
          <Typography component="span" variant="body2" sx={{ flex: "none" }}>
            <TextLink href={run.github_workflow.job_url}>
              Log
              <OpenInNewIcon
                sx={{ fontSize: "0.9em", verticalAlign: "-0.15em", ml: 0.25 }}
              />
            </TextLink>
          </Typography>
        )}
      </Box>
    </Box>
  );
}

// The Outcome cell of a run: a block of the status's hue for a failed,
// timed out or flaky run, plain muted words for the rest, with the
// attempts in words beneath, "all 3 attempts".
function OutcomeCell({ run }: { run: RunRecord }) {
  const outcomes = run.attempts.map((attempt) => attempt.outcome);
  const status = runStatus(run);
  const hue = problemHue(status);
  const caption = attemptsCaption(outcomes) ?? "";
  return (
    <Box component="span" sx={{ ...CELL_ROOT_SX, color: "text.secondary" }}>
      {hue !== null ? (
        <CellBlock
          hue={hue}
          lead={BUNDLE_STATUS_WORDS[status]}
          caption={caption}
        />
      ) : (
        <CellFrame lead={BUNDLE_STATUS_WORDS[status]} caption={caption} />
      )}
    </Box>
  );
}

// What the shared columns read of a row that is not a run.
const NOTHING: HubRow = {
  test: null,
  environment: null,
  env_vars: null,
  workflowPaths: [],
  owners: [],
  environmentRepeated: false,
};

// The runs of a commit from GET /api/tests/commit/{sha}, one list in
// outcome order and within it the sort, filtered by the API
// (commitTableRows); the hub's table (HubDataGrid) with the hub's Name,
// Environment, Test Config and Owners columns (sharedColumns) and this
// page's Outcome, Duration and Job. A run's rows of attempts and the "Show
// more" row are rows of the grid spanning every column.
export default function CommitTable({
  repo,
  runs,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  statuses,
  onStatusesChange,
  error,
  onRetry,
  timing,
  refreshedAt,
  sort,
  onSortChange,
  options,
  filters,
  onFiltersChange,
  onFilter,
  search,
  onSearchInput,
  onSearch,
}: CommitTableProps) {
  const theme = useTheme();
  const sortModel = useMemo(
    () => sortModelOf(sort, COMMIT_TABLE_SORT_FIELDS),
    [sort]
  );
  const [searchExtraHeight, setSearchExtraHeight] = useState(0);
  // The runs whose attempts are open; it does not travel in the URL.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const toggleExpanded = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows: CommitRow[] = useMemo(
    () =>
      commitTableRows({
        runs,
        loadingMore,
        hasMore,
        expanded,
        sortedByEnvironment: sortModel[0]?.field === "environment",
      }).map((row) =>
        row.kind === "run"
          ? {
              ...row,
              test: row.run.test,
              environment: row.run.environment,
              env_vars: row.run.env_vars,
              workflowPaths:
                row.run.github_workflow.path === null
                  ? []
                  : [row.run.github_workflow.path],
              owners: row.run.owners,
            }
          : { ...row, ...NOTHING }
      ),
    [runs, loadingMore, hasMore, expanded, sortModel]
  );

  const columns = useMemo<GridColDef<CommitRow>[]>(() => {
    const table = { options, filters, onFiltersChange, onFilter };
    const spanAll = (row: CommitRow) => (row.kind === "run" ? 1 : 7);
    return [
      nameColumn<CommitRow>({
        description: COMMIT_COLUMN_DESCRIPTIONS.name,
        href: (row) =>
          row.kind === "run" && row.run.test !== null
            ? testPagePath(repo, row.run.test.id)
            : undefined,
        search: {
          value: search,
          onChange: onSearchInput,
          onSubmit: onSearch,
          filters: undefined,
          onRemoveFilter: () => undefined,
          onExtraHeightChange: setSearchExtraHeight,
        },
        onSearch,
        colSpan: spanAll,
        renderRow: (row) => {
          switch (row.kind) {
            case "more":
              return <MoreRow row={row} onClick={onLoadMore} />;
            case "attempts":
              return <AttemptRow row={row} theme={theme} />;
            case "run":
              return (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: `${CHEVRON_GAP}px`,
                    width: "100%",
                    minWidth: 0,
                  }}
                >
                  <Chevron
                    open={row.expanded}
                    label={`${row.expanded ? "Hide" : "Show"} the attempts`}
                    onClick={() => toggleExpanded(row.id)}
                  />
                  {row.run.test === null ? (
                    <Typography
                      component="span"
                      variant="body2"
                      color="text.secondary"
                    >
                      Unknown test
                    </Typography>
                  ) : (
                    <TestName
                      test={row.run.test}
                      href={testPagePath(repo, row.run.test.id)}
                      onSearch={onSearch}
                    />
                  )}
                </Box>
              );
          }
        },
      }),
      {
        field: "outcome",
        headerName: "Outcome",
        headerClassName: FILTERABLE_HEADER,
        renderHeader: () => (
          <>
            <ColumnTitle
              title="Outcome"
              description={COMMIT_COLUMN_DESCRIPTIONS.outcome}
            />
            <HeaderFilter
              column="outcome"
              summary={statusesSummary(statuses)}
              anyLabel="Every outcome"
              sections={[
                {
                  facet: "status",
                  title: "Outcome",
                  options: STATUS_CHOICES.map((status) => ({
                    value: status,
                    label: STATUS_TITLES[status],
                  })),
                },
              ]}
              value={{ ...noFacetValues(), status: [...statuses] }}
              onChange={(next) =>
                onStatusesChange(
                  (next.status ?? []).length === 0
                    ? [...STATUS_CHOICES]
                    : (next.status as BundleStatus[])
                )
              }
            />
          </>
        ),
        width: COMMIT_COLUMN_WIDTHS.outcome,
        display: "flex",
        sortable: false,
        renderCell: ({ row }) =>
          row.kind === "run" ? <OutcomeCell run={row.run} /> : null,
      },
      {
        field: "duration",
        headerName: "Duration",
        renderHeader: () => (
          <ColumnTitle
            title="Duration"
            description={COMMIT_COLUMN_DESCRIPTIONS.duration}
          />
        ),
        width: COMMIT_COLUMN_WIDTHS.duration,
        display: "flex",
        sortingOrder: ["desc", "asc"],
        renderCell: ({ row }) =>
          row.kind === "run" ? (
            <Typography
              component="span"
              variant="body2"
              sx={{ fontVariantNumeric: "tabular-nums" }}
            >
              {runStatus(row.run) === "skipped"
                ? "—"
                : durationLabel(bundleDuration(row.run.attempts))}
            </Typography>
          ) : null,
      },
      environmentColumn<CommitRow>(
        filterColumnProps(table, COMMIT_COLUMN_DESCRIPTIONS.environment)
      ),
      testConfigColumn<CommitRow>(
        filterColumnProps(table, COMMIT_COLUMN_DESCRIPTIONS.test_config)
      ),
      {
        field: "job",
        headerName: "Job",
        renderHeader: () => (
          <ColumnTitle
            title="Job"
            description={COMMIT_COLUMN_DESCRIPTIONS.job}
          />
        ),
        width: COMMIT_COLUMN_WIDTHS.job,
        display: "flex",
        sortingOrder: ["asc", "desc"],
        renderCell: ({ row }) => {
          if (row.kind !== "run") return null;
          const { job_name: jobName, job_url: jobUrl } =
            row.run.github_workflow;
          if (jobName === null) {
            return (
              <Typography
                component="span"
                variant="body2"
                color="text.secondary"
              >
                Unknown job
              </Typography>
            );
          }
          const job = parseJobName(jobName);
          return (
            <CellLines
              title={jobName}
              lead={
                jobUrl === null ? (
                  job.build
                ) : (
                  <TextLink href={jobUrl}>{job.build}</TextLink>
                )
              }
              caption={jobDetailLine(job) ?? ""}
            />
          );
        },
      },
      ownersColumn<CommitRow>(
        filterColumnProps(table, COMMIT_COLUMN_DESCRIPTIONS.owners)
      ),
    ];
  }, [
    repo,
    options,
    filters,
    onFiltersChange,
    onFilter,
    search,
    onSearchInput,
    onSearch,
    statuses,
    onStatusesChange,
    onLoadMore,
    theme,
  ]);

  // One grid per hundred rows (gridChunks); the rows change only with the
  // input, so the split does too.
  const chunks = useMemo(() => gridChunks(rows), [rows]);
  const handleSortModelChange = (model: GridSortModel) => {
    onSortChange(
      sortParamOf(model, COMMIT_TABLE_SORT_FIELDS) ?? DEFAULT_COMMIT_SORT
    );
  };
  // Something is on its way: the first page or a further one. The grid
  // shows it as the list's grid does: a progress bar over the rows it has,
  // the skeleton rows while it has none.
  const busy = loading || loadingMore;
  return (
    <Stack spacing={1.5}>
      {error !== undefined && (
        <LoadError what="the runs" error={error} onRetry={onRetry} />
      )}
      <Box>
        <Box sx={{ mb: 1.5 }}>
          <Updated refreshedAt={refreshedAt} cadence={null} />
        </Box>
        {chunks.map((chunk, index) => (
          <HubDataGrid
            key={index}
            headerless={index > 0}
            blockFields={["outcome"]}
            mutedFields={[]}
            twoLineHeaderFields={[]}
            searchExtraHeight={searchExtraHeight}
            rows={chunk}
            columns={columns}
            getRowId={(row: CommitRow) => row.id}
            getRowClassName={({ row }) =>
              row.kind === "run" ? "" : `commit-${row.kind}`
            }
            loading={index === 0 && busy}
            sortModel={sortModel}
            onSortModelChange={handleSortModelChange}
            hideFooter
            // The grids are stacked as one table, each as tall as its rows.
            disableVirtualization
            localeText={{ noRowsLabel: "No runs with the outcomes listed" }}
            sx={{
              "& .MuiDataGrid-row.commit-attempts": {
                backgroundColor: theme.palette.action.hover,
                "&:hover": { backgroundColor: theme.palette.action.hover },
              },
              "& .MuiDataGrid-row.commit-more .MuiDataGrid-cell": {
                minHeight: 36,
              },
              // Stacked grids read as one table: no rule or rounding where
              // one meets the next.
              ...(index > 0
                ? {
                    borderTop: 0,
                    borderTopLeftRadius: 0,
                    borderTopRightRadius: 0,
                  }
                : {}),
              ...(index < chunks.length - 1
                ? { borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }
                : {}),
            }}
          />
        ))}
        <LoadTime timing={timing} loading={loading} />
      </Box>
    </Stack>
  );
}
