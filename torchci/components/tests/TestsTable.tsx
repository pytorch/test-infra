import { Box, Stack, Typography } from "@mui/material";
import { GridColDef, GridSortModel } from "@mui/x-data-grid";
import ColumnTitle from "components/tests/ColumnTitle";
import HeaderFilter from "components/tests/HeaderFilter";
import Health from "components/tests/Health";
import HubDataGrid from "components/tests/HubDataGrid";
import LastRun from "components/tests/LastRun";
import LoadError from "components/tests/LoadError";
import LoadTime from "components/tests/LoadTime";
import MeanPassedDuration from "components/tests/MeanPassedDuration";
import {
  environmentColumn,
  filterColumnProps,
  HubRow,
  nameColumn,
  ownersColumn,
  sectionsOf,
  testConfigColumn,
} from "components/tests/sharedColumns";
import Updated from "components/tests/Updated";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import type { TestOptions } from "lib/api/tests/options/types";
import type { TestHealthEntry } from "lib/api/tests/types";
import { SHARED_COLUMN_DESCRIPTIONS } from "lib/tests/columns";
import type { Token } from "lib/tests/environment";
import {
  facetsPhrase,
  FacetValues,
  HEALTH_COLUMN_FACETS,
  NameFilter,
  NameFilterValues,
  noFacetValues,
} from "lib/tests/facets";
import { COLUMN_WIDTHS } from "lib/tests/layout";
import { ListContext, testPagePath, testRunsHref } from "lib/tests/links";
import {
  DEFAULT_TESTS_SORT,
  displayedRowsLabel,
  sortModelOf,
  sortParamOf,
  TESTS_PAGE_SIZES,
} from "lib/tests/table";
import { FILTERABLE_HEADER } from "lib/tests/tableStyle";
import type { TestsListing } from "lib/tests/useTestsListing";
import { ReactNode, useMemo, useState } from "react";

// A row is one API entry: a test in one environment with one env var set,
// with what the shared columns read (HubRow).
type TestRow = TestHealthEntry & HubRow & { id: string };

function rowId(entry: TestHealthEntry, index: number): string {
  return entry.environment !== null && entry.env_vars !== null
    ? `${entry.test.id}:${entry.environment.id}:${entry.env_vars.id}`
    : `${entry.test.id}:#${index}`;
}

const PAGE_SIZE_OPTIONS = [...TESTS_PAGE_SIZES];

// What each column shows, said once, in its header's tooltip.
// Hover help for each header, in the page owner's words. The two that
// depend on the window name the one in force, "within the last 12 hours".
export function descriptionsFor(windowLabel: string | undefined) {
  const within =
    windowLabel === undefined
      ? "within the window"
      : `within the last ${windowLabel}`;
  return {
    ...SHARED_COLUMN_DESCRIPTIONS,
    // One line per status; the tooltip keeps the line breaks.
    health: [
      "The health of the test.",
      "Failing: a run failed and stayed failed after retries.",
      "Flaky: runs failed but passed on retry.",
      "Healthy: nothing failed.",
      "Skipped: every attempt was skipped.",
    ].join("\n"),
    mean_passed_duration_milliseconds: `The average time a successful run of the test takes ${within}.`,
    last_run_at: `When the test most recently ran ${within}.`,
  };
}

// The columns' widths in pixels, each sized to what it shows, as its
// definition says, and the table's width they add up to, which the page
// column is cut to, are in lib/tests/layout.ts. The row geometry is in
// lib/tests/rows.ts, shared with the Health cell, whose block is sized to
// it; the table's style is the hub's (HubDataGrid), and the Name,
// Environment, Test Config and Owners columns are the hub's too
// (sharedColumns), this table adding Health, Mean Passed Duration and Last
// run.

export interface TestsTableProps {
  // The repository as owner/name, for the rows' links to their tests' pages;
  // undefined until the router knows it, when the cells are plain text.
  repo: string | undefined;
  // What the list is showing, which the Health and duration cells' links
  // carry to the test's page; undefined until the options have resolved the
  // URL, when those cells are plain text.
  links: ListContext | undefined;
  // The page to show and the means to turn its pages.
  listing: TestsListing;
  // The API sort parameter in force; the headers change it.
  sort: string;
  onSortChange: (_sort: string) => void;
  // The options, for the labels of the environment cells and the values the
  // headers' filters offer; undefined before they arrive, when the cells
  // show the catalog's spelling and the filters offer nothing yet.
  options: TestOptions | undefined;
  // The window in force as the options label it, "12 hours", for the headers'
  // hover help; undefined before the options arrive.
  windowLabel: string | undefined;
  // The facet filters in force, which the headers show; undefined with the
  // options.
  filters: FacetValues | undefined;
  // A header's filter changed: the facets it covers with their new values.
  onFiltersChange: (_next: Partial<FacetValues>) => void;
  // A value clicked in a cell: the facets it stands for, to filter by.
  onFilter: (_filters: Token["filters"]) => void;
  // The text searched for, as the Name header's field shows it: what the
  // URL carries, or what is still being typed.
  search: string;
  // A keystroke in the search field, with the whole text.
  onSearchInput: (_text: string) => void;
  // Search for this text now: a file or suite clicked in a cell, or Enter.
  onSearch: (_text: string) => void;
  // The exact name filters the URL carries, which the Name header shows as
  // chips beside the search; undefined until the options have resolved the
  // URL.
  nameFilters: NameFilterValues | undefined;
  // A chip's remove button: take this value of this filter out of the URL.
  onNameFilterRemove: (_name: NameFilter, _value: string) => void;
  // What sits on the caption's line, left of "Updated": the view chips.
  toolbar?: ReactNode;
}

// The tests of a repository from GET /api/tests, sorted, filtered and paged
// by the API.
export default function TestsTable({
  repo,
  links,
  listing,
  sort,
  onSortChange,
  options,
  windowLabel,
  filters: currentFilters,
  onFiltersChange,
  onFilter,
  search,
  onSearchInput,
  onSearch,
  nameFilters,
  onNameFilterRemove,
  toolbar,
}: TestsTableProps) {
  const filters = currentFilters ?? noFacetValues();
  const sortModel = useMemo(() => sortModelOf(sort), [sort]);
  // How much taller than a key the Name header's search field is, holding
  // its rows of name-filter chips; the header band grows by it.
  const [searchExtraHeight, setSearchExtraHeight] = useState(0);
  const descriptions = useMemo(
    () => descriptionsFor(windowLabel),
    [windowLabel]
  );
  const paginationMeta = useMemo(
    () => ({ hasNextPage: listing.hasNextPage }),
    [listing.hasNextPage]
  );

  const columns = useMemo<GridColDef<TestRow>[]>(() => {
    // Where a row's cells lead (lib/tests/links.ts): the name to the test's
    // page, the Health and duration figures to that page opened on the runs
    // they were counted over, the row's configuration marked.
    const nameHref = (row: TestRow) =>
      repo === undefined ? undefined : testPagePath(repo, row.test.id);
    const runsHref = (row: TestRow) =>
      repo === undefined || links === undefined
        ? undefined
        : testRunsHref(repo, row, links);
    const table = { options, filters, onFiltersChange, onFilter };
    return [
      nameColumn<TestRow>({
        description: descriptions.name,
        href: nameHref,
        search: {
          value: search,
          onChange: onSearchInput,
          onSubmit: onSearch,
          filters: nameFilters,
          onRemoveFilter: onNameFilterRemove,
          onExtraHeightChange: setSearchExtraHeight,
        },
        onSearch,
      }),
      {
        field: "health",
        headerName: "Health",
        headerClassName: FILTERABLE_HEADER,
        renderHeader: () => (
          <>
            <ColumnTitle title="Health" description={descriptions.health} />
            <HeaderFilter
              column="health"
              summary={
                options === undefined
                  ? ""
                  : facetsPhrase(HEALTH_COLUMN_FACETS, filters, options)
              }
              anyLabel="Any health"
              sections={sectionsOf(HEALTH_COLUMN_FACETS, options)}
              value={filters}
              onChange={onFiltersChange}
            />
          </>
        ),
        // Room for the second line's longest usual form, "5 of 5 runs · 62
        // skipped" or "31 runs · 124 skipped", 130px at caption size, in the
        // cell's 150px; a longer one wraps and its row grows.
        width: COLUMN_WIDTHS.health,
        display: "flex",
        // Worst first, as a reader looking for trouble expects (the fields
        // are in TESTS_TABLE_SORT_FIELDS); the API puts the configurations
        // without a run, which have no status rank, last either way.
        sortingOrder: ["desc", "asc"],
        valueGetter: (_value, row) => row.health.status,
        renderCell: ({ row }) => (
          <Health health={row.health} options={options} href={runsHref(row)} />
        ),
      },
      environmentColumn<TestRow>(
        filterColumnProps(table, descriptions.environment)
      ),
      testConfigColumn<TestRow>(
        filterColumnProps(table, descriptions.test_config)
      ),
      {
        field: "mean_passed_duration_milliseconds",
        // Set on two lines; the table's style keeps the break.
        headerName: "Mean Passed\nDuration",
        renderHeader: () => (
          <ColumnTitle
            title={"Mean Passed\nDuration"}
            description={descriptions.mean_passed_duration_milliseconds}
          />
        ),
        width: COLUMN_WIDTHS.mean_passed_duration_milliseconds,
        display: "flex",
        // Slowest first, as a reader looking for slow tests expects; the API
        // puts the tests without a pass, which have no mean, last either way.
        sortingOrder: ["desc", "asc"],
        valueGetter: (_value, row) =>
          row.health.mean_passed_duration_milliseconds,
        renderCell: ({ row }) => (
          <MeanPassedDuration
            milliseconds={row.health.mean_passed_duration_milliseconds}
            passedRuns={row.health.passed_runs}
            href={runsHref(row)}
          />
        ),
      },
      ownersColumn<TestRow>(filterColumnProps(table, descriptions.owners)),
      {
        field: "last_run_at",
        headerName: "Last run",
        renderHeader: () => (
          <ColumnTitle
            title="Last run"
            description={descriptions.last_run_at}
          />
        ),
        width: COLUMN_WIDTHS.last_run_at,
        // A flex cell centers the label in a row grown by its name; a text
        // cell would set it at the top.
        display: "flex",
        sortingOrder: ["desc", "asc"],
        valueGetter: (_value, row) => row.health.last_run_at,
        renderCell: ({ row }) =>
          row.health.last_run_at === null ? (
            <Typography component="span" variant="body2" color="text.secondary">
              —
            </Typography>
          ) : (
            <LastRun timestamp={row.health.last_run_at} />
          ),
      },
    ];
  }, [
    repo,
    links,
    options,
    descriptions,
    filters,
    onFiltersChange,
    onFilter,
    search,
    onSearchInput,
    onSearch,
    nameFilters,
    onNameFilterRemove,
  ]);

  const handleSortModelChange = (model: GridSortModel) => {
    onSortChange(sortParamOf(model) ?? DEFAULT_TESTS_SORT);
  };

  // Sorted by environment, a page runs through each environment's rows in
  // turn; all but the first of a run are set softer.
  const sortedByEnvironment = sortModel[0]?.field === "environment";
  const rows: TestRow[] = listing.entries.map((entry, index) => {
    const previous = index > 0 ? listing.entries[index - 1] : undefined;
    return {
      ...entry,
      id: rowId(entry, index),
      workflowPaths: entry.health.workflow_paths,
      environmentRepeated:
        sortedByEnvironment &&
        entry.environment !== null &&
        previous?.environment?.id === entry.environment.id,
    };
  });

  return (
    <Stack spacing={1.5}>
      {listing.error !== undefined && (
        <LoadError what="tests" error={listing.error} onRetry={listing.retry} />
      )}
      <Box>
        {/* The caption's line: the toolbar at the left, "Updated" at the
            right, both on the line's bottom edge, just above the table. */}
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 2,
            minHeight: VIEW_CHIP_HEIGHT,
            mb: 1.5,
          }}
        >
          <Box sx={{ minWidth: 0 }}>{toolbar}</Box>
          <Updated refreshedAt={listing.refreshedAt} />
        </Box>
        <HubDataGrid
          blockFields={["health"]}
          mutedFields={["last_run_at"]}
          twoLineHeaderFields={["mean_passed_duration_milliseconds"]}
          searchExtraHeight={searchExtraHeight}
          rows={rows}
          columns={columns}
          loading={listing.loading}
          sortModel={sortModel}
          onSortModelChange={handleSortModelChange}
          paginationMode="server"
          rowCount={listing.rowCount}
          paginationMeta={paginationMeta}
          paginationModel={listing.paginationModel}
          onPaginationModelChange={listing.onPaginationModelChange}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          localeText={{ paginationDisplayedRows: displayedRowsLabel }}
        />
        <LoadTime timing={listing.timing} loading={listing.loading} />
      </Box>
    </Stack>
  );
}
