import { Box, Stack, Typography, useTheme } from "@mui/material";
import { DataGrid, GridColDef, GridSortModel } from "@mui/x-data-grid";
import ColumnTitle from "components/tests/ColumnTitle";
import Config from "components/tests/Config";
import Environment from "components/tests/Environment";
import type { FacetSection } from "components/tests/FacetMenu";
import HeaderFilter, {
  HEADER_FILTER_INSET,
  HEADER_FILTER_SIZE,
} from "components/tests/HeaderFilter";
import Health from "components/tests/Health";
import LastRun from "components/tests/LastRun";
import LoadError from "components/tests/LoadError";
import LoadTime from "components/tests/LoadTime";
import MeanPassedDuration from "components/tests/MeanPassedDuration";
import NameSearch from "components/tests/NameSearch";
import Owners from "components/tests/Owners";
import TestName, {
  TEST_NAME_SEPARATOR,
  testNameParts,
} from "components/tests/TestName";
import Updated from "components/tests/Updated";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import type { TestOptions } from "lib/api/tests/options/types";
import type { TestHealthEntry } from "lib/api/tests/types";
import type { Token } from "lib/tests/environment";
import {
  CONFIG_COLUMN_FACETS,
  ENVIRONMENT_COLUMN_FACETS,
  FACET_TITLES,
  facetChoice,
  facetsPhrase,
  FacetValues,
  HEALTH_COLUMN_FACETS,
  NameFilter,
  NameFilterValues,
  noFacetValues,
  OWNER_COLUMN_FACETS,
  TestsFacet,
} from "lib/tests/facets";
import { headerBandColor, headerRuleColor } from "lib/tests/headerColors";
import {
  COLUMN_WIDTHS,
  HEADER_TITLE_STYLE,
  NAME_MIN_WIDTH,
  TABLE_BORDER,
} from "lib/tests/layout";
import { ListContext, testPagePath, testRunsHref } from "lib/tests/links";
import { CELL_VERTICAL_PADDING, ROW_HEIGHT } from "lib/tests/rows";
import {
  columnHeaderHeightFor,
  DEFAULT_TESTS_SORT,
  displayedRowsLabel,
  sortModelOf,
  sortParamOf,
  TESTS_PAGE_SIZES,
} from "lib/tests/table";
import type { TestsListing } from "lib/tests/useTestsListing";
import { ReactNode, useMemo, useState } from "react";

// A row is one API entry: a test in one environment with one env var set.
type TestRow = TestHealthEntry & {
  id: string;
  // The row above shows the same environment and the table is sorted by it.
  environmentRepeated: boolean;
};

function rowId(entry: TestHealthEntry, index: number): string {
  return entry.environment !== null && entry.env_vars !== null
    ? `${entry.test.id}:${entry.environment.id}:${entry.env_vars.id}`
    : `${entry.test.id}:#${index}`;
}

const PAGE_SIZE_OPTIONS = [...TESTS_PAGE_SIZES];

// The class of a header that holds a filter, which makes room for it.
const FILTERABLE_HEADER = "tests-filterable-header";
// The class of the Name header, which holds the search field.
const SEARCH_HEADER = "tests-search-header";

// What each column shows, said once, in its header's tooltip.
// Hover help for each header, in the page owner's words. The two that
// depend on the window name the one in force, "within the last 12 hours".
export function descriptionsFor(windowLabel: string | undefined) {
  const within =
    windowLabel === undefined
      ? "within the window"
      : `within the last ${windowLabel}`;
  return {
    name: "The name of the test. A name can appear more than once, in a different environment or test config each time.",
    // One line per status; the tooltip keeps the line breaks.
    health: [
      "The health of the test.",
      "Failing: a run failed and stayed failed after retries.",
      "Flaky: runs failed but passed on retry.",
      "Healthy: nothing failed.",
      "Skipped: every attempt was skipped.",
    ].join("\n"),
    environment: "Where the test ran.",
    test_config:
      "The TEST_CONFIG set in the GitHub workflow that ran the test, plus any env vars from TestEnvironment.repro_env_vars that differ from their defaults.",
    mean_passed_duration_milliseconds: `The average time a successful run of the test takes ${within}.`,
    owners:
      "The owners of the test, as determined by scripts/codeowners/owners.py.",
    last_run_at: `When the test most recently ran ${within}.`,
  };
}

// The menu sections of a column's facets: each facet's title and the values
// the options offer for it, none until the options arrive.
function sectionsOf(
  facets: readonly TestsFacet[],
  options: TestOptions | undefined
): FacetSection[] {
  return facets.map((facet) => ({
    facet,
    title: FACET_TITLES[facet],
    options: options === undefined ? [] : facetChoice(options, facet).values,
  }));
}

// The columns' widths in pixels, each sized to what it shows, as its
// definition says, and the table's width they add up to, which the page
// column is cut to, are in lib/tests/layout.ts.

// The row geometry is in lib/tests/rows.ts, shared with the Health cell,
// whose block is sized to it. The header, set in pixels the same way
// (COLUMN_HEADER_HEIGHT in lib/tests/layout.ts, shared with the grid's
// band), holds its two-line label as a row holds its two-line cells.

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
  const theme = useTheme();
  // The table is set like a typeset list, in the voice of the title above
  // it: HUD's shared table border (`--table-border-color`, which its other
  // tables draw) around the grid's rounded corners, hairlines in the
  // palette's divider color between rows, compact rows, and
  // emphasis carried by text color. The header is a band in the same grey as
  // the title's pills, clipped above by the box's rounded corners and square
  // below so the rows' hairlines meet it flush, with small bold uppercase
  // muted labels and a short hairline between its columns, so the header and
  // the title read as one system. Every color follows the theme's mode.
  const hairline = theme.palette.divider;
  const headerBand = headerBandColor(theme);
  const headerDivider = headerRuleColor(theme);
  // The accent as text on the band, for the sorted header's label and arrow:
  // a step darker in light mode and a step lighter in dark mode, since the
  // accent itself reads at 4.0:1 and 3.1:1 against the band and these at
  // 5.0:1 and 4.0:1 (measured 2026-10-26).
  const sortedHeaderText =
    theme.palette.mode === "dark"
      ? theme.palette.primary.light
      : theme.palette.primary.dark;

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

  // Every header and every cell is left-aligned, the figures too, so each
  // column reads down one edge from its label. (A right-aligned label would
  // also jump: the grid's sort arrow takes no width until its header is
  // hovered or sorted, so a label set against the right edge moves left to
  // make room for it, while a left-aligned one stays put and the arrow
  // appears after it.)
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
    return [
      {
        field: "name",
        headerName: "Name",
        headerClassName: SEARCH_HEADER,
        // The label as the grid would set it, and the column's search, which
        // the header's styles below set after the sort arrow, filling the
        // header.
        renderHeader: () => (
          <>
            <ColumnTitle title="Name" description={descriptions.name} />
            <NameSearch
              value={search}
              onChange={onSearchInput}
              onSubmit={onSearch}
              filters={nameFilters}
              onRemoveFilter={onNameFilterRemove}
              onExtraHeightChange={setSearchExtraHeight}
            />
          </>
        ),
        // The width the other columns leave, 480px at least: at the table's
        // sizes about 60 characters of case name over 70 of file and suite,
        // so most names keep to a line each. A longer name wraps rather than
        // being cut off, and its row grows to hold it.
        flex: 1,
        minWidth: NAME_MIN_WIDTH,
        // A flex cell centers the stack, as in the other cells.
        display: "flex",
        sortingOrder: ["asc", "desc"],
        valueGetter: (_value, row) =>
          testNameParts(row.test).join(TEST_NAME_SEPARATOR),
        renderCell: ({ row }) => (
          <TestName test={row.test} href={nameHref(row)} onSearch={onSearch} />
        ),
      },
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
      {
        field: "environment",
        headerName: "Environment",
        headerClassName: FILTERABLE_HEADER,
        // The label as the grid would set it, so it shares the other headers'
        // style, and the column's filter beside it.
        renderHeader: () => (
          <>
            <ColumnTitle
              title="Environment"
              description={descriptions.environment}
            />
            <HeaderFilter
              column="environment"
              summary={
                options === undefined
                  ? ""
                  : facetsPhrase(ENVIRONMENT_COLUMN_FACETS, filters, options)
              }
              anyLabel="Any environment"
              sections={sectionsOf(ENVIRONMENT_COLUMN_FACETS, options)}
              value={filters}
              onChange={onFiltersChange}
            />
          </>
        ),
        // Wide enough for the longest second line the catalog produces,
        // "Python 3.10 · Windows 10.0.17763 · x86_64 avx512 · MSVC 194234444",
        // 400px of text at caption size inside the cell's 20px of padding,
        // so no line is cut off.
        width: COLUMN_WIDTHS.environment,
        // A flex cell centers the two-line stack; a text cell would center
        // one line through its line height and hang the stack from its
        // baseline.
        display: "flex",
        sortingOrder: ["asc", "desc"],
        valueGetter: (_value, row) => row.environment?.id ?? "",
        renderCell: ({ row }) => (
          <Environment
            environment={row.environment}
            options={options}
            onFilter={onFilter}
            repeated={row.environmentRepeated}
          />
        ),
      },
      {
        field: "test_config",
        headerName: "Test Config",
        headerClassName: FILTERABLE_HEADER,
        renderHeader: () => (
          <>
            <ColumnTitle
              title="Test Config"
              description={descriptions.test_config}
            />
            <HeaderFilter
              column="test config"
              summary={
                options === undefined
                  ? ""
                  : facetsPhrase(CONFIG_COLUMN_FACETS, filters, options)
              }
              anyLabel="Any test config or workflow"
              sections={sectionsOf(CONFIG_COLUMN_FACETS, options)}
              value={filters}
              onChange={onFiltersChange}
            />
          </>
        ),
        width: COLUMN_WIDTHS.test_config,
        display: "flex",
        sortingOrder: ["asc", "desc"],
        valueGetter: (_value, row) => row.env_vars?.id ?? "",
        renderCell: ({ row }) => (
          <Config
            envVars={row.env_vars}
            workflowPaths={row.health.workflow_paths}
            onFilter={onFilter}
          />
        ),
      },
      {
        field: "mean_passed_duration_milliseconds",
        // Set on two lines; the header styles below keep the break.
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
      {
        field: "owners",
        headerName: "Owners",
        headerClassName: FILTERABLE_HEADER,
        renderHeader: () => (
          <>
            <ColumnTitle title="Owners" description={descriptions.owners} />
            <HeaderFilter
              column="owners"
              summary={
                options === undefined
                  ? ""
                  : facetsPhrase(OWNER_COLUMN_FACETS, filters, options)
              }
              anyLabel="Any owner"
              sections={sectionsOf(OWNER_COLUMN_FACETS, options)}
              value={filters}
              onChange={onFiltersChange}
            />
          </>
        ),
        // Wide enough for the longest label at the table's text size.
        width: COLUMN_WIDTHS.owners,
        display: "flex",
        sortingOrder: ["asc", "desc"],
        valueGetter: (_value, row) => row.owners.join(", "),
        renderCell: ({ row }) => (
          <Owners owners={row.owners} onFilter={onFilter} />
        ),
      },
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
        <DataGrid
          sx={{
            // The grid's own border color darkens the divider, which in HUD's
            // dark theme ends up darker than the page; the shared variable is
            // set for both modes in globals.css.
            border: `${TABLE_BORDER}px solid var(--table-border-color)`,
            "--DataGrid-rowBorderColor": hairline,
            "& .MuiDataGrid-columnHeaders": { backgroundColor: headerBand },
            "& .MuiDataGrid-columnHeader, & .MuiDataGrid-columnHeaders .MuiDataGrid-filler, & .MuiDataGrid-columnHeaders .MuiDataGrid-scrollbarFiller":
              { backgroundColor: "transparent" },
            // The grid's own font size, which HUD's other tables keep too.
            "& .MuiDataGrid-columnHeaderTitle": {
              ...HEADER_TITLE_STYLE,
              color: theme.palette.text.secondary,
            },
            "& .MuiDataGrid-columnHeaders .MuiDataGrid-row--borderBottom .MuiDataGrid-columnHeader, & .MuiDataGrid-columnHeaders .MuiDataGrid-row--borderBottom .MuiDataGrid-filler":
              { borderBottom: "none" },
            // The sort arrow's button only: a header's filter button sets its
            // own color.
            "& .MuiDataGrid-columnHeader .MuiDataGrid-iconButtonContainer .MuiIconButton-root, & .MuiDataGrid-sortIcon":
              { color: theme.palette.text.secondary },
            // The duration label is too long for one line of a column as wide
            // as its figures need, so its name breaks it onto two lines, which
            // pre-line keeps. Left to wrap on its own, the label would fill the
            // header's width and push the sort arrow to the far edge instead of
            // after the label, where the other headers have it.
            '& .MuiDataGrid-columnHeader[data-field="mean_passed_duration_milliseconds"] .MuiDataGrid-columnHeaderTitle':
              { whiteSpace: "pre-line", lineHeight: 1.2 },
            // A header with a filter keeps the filter key at its right edge,
            // out of the flow, and leaves it room and a gap, so the label and
            // the sort arrow sit as they do in the other headers.
            [`& .${FILTERABLE_HEADER}`]: { position: "relative" },
            [`& .${FILTERABLE_HEADER} .MuiDataGrid-columnHeaderTitleContainer`]:
              {
                paddingRight: `${
                  HEADER_FILTER_INSET + HEADER_FILTER_SIZE + 4
                }px`,
              },
            // The Name header's search field is in the title row instead, after
            // the sort arrow, taking the width the label and the arrow leave.
            // The row's content wrapper is made transparent to layout, so the
            // field is an item of the row and can follow the arrow (its
            // `order`); the arrow's slot is kept whether or not the arrow
            // shows, so the field does not move when the header is sorted or
            // hovered; and the header's right padding is the field's inset,
            // so it ends where the other headers' keys end.
            [`& .${SEARCH_HEADER}`]: {
              paddingRight: `${HEADER_FILTER_INSET}px`,
            },
            [`& .${SEARCH_HEADER} .MuiDataGrid-columnHeaderTitleContainerContent`]:
              { display: "contents" },
            [`& .${SEARCH_HEADER} .MuiDataGrid-iconButtonContainer`]: {
              width: "auto",
            },
            // Between header columns the grid's own separator stays: a 1px rule
            // shorter than the band. None after the last column, and nothing to
            // drag because the columns do not resize.
            "& .MuiDataGrid-columnSeparator": { color: headerDivider },
            "& .MuiDataGrid-columnHeader--last .MuiDataGrid-columnSeparator": {
              display: "none",
            },
            // The grid paints the sorted column's icon box in its default header
            // color so it covers the separator; paint it in the band's grey.
            "& .MuiDataGrid-columnHeader--sorted .MuiDataGrid-iconButtonContainer":
              { background: headerBand },
            // The sorted column's header is marked as the active control it is,
            // like a header's filled filter key: its label and arrow take the
            // accent color and an accent rule runs along its bottom edge, the
            // width of the column, so the column the table is ordered by can
            // be seen at a glance. The rule is an inset shadow, not a border,
            // so the header keeps its height and its text stays put.
            "& .MuiDataGrid-columnHeader--sorted": {
              boxShadow: `inset 0 -2px 0 ${theme.palette.primary.main}`,
            },
            "& .MuiDataGrid-columnHeader--sorted .MuiDataGrid-columnHeaderTitle, & .MuiDataGrid-columnHeader--sorted .MuiDataGrid-iconButtonContainer .MuiIconButton-root, & .MuiDataGrid-columnHeader--sorted .MuiDataGrid-sortIcon":
              { color: sortedHeaderText },
            // HUD's global stylesheet paints every link in a grid cell in
            // the link blue (`.MuiDataGrid-root .MuiDataGrid-cell a` in
            // globals.css), which is what the name and the duration figure
            // want; said here too, so the table does not lean on that
            // sheet. A cell whose link wants another color names it in
            // `--cell-link-color`, which the rule reads first: the Health
            // block its hue's ink, the healthy word the text around it. The
            // rule outranks the global one by the root class.
            "&.MuiDataGrid-root .MuiDataGrid-cell a": {
              color: "var(--cell-link-color, var(--link-color))",
            },
            // A row's cells are as tall as its tallest, `ROW_HEIGHT` at least,
            // and keep a little air above and below a name that wraps.
            "& .MuiDataGrid-cell": {
              borderTopColor: hairline,
              minHeight: ROW_HEIGHT,
              paddingTop: `${CELL_VERTICAL_PADDING}px`,
              paddingBottom: `${CELL_VERTICAL_PADDING}px`,
            },
            // The Health cell, which holds a block, pads its sides as it does
            // above and below, so the block sits the same distance from every
            // edge; the block pads its own text out to where the other cells'
            // text starts.
            '& .MuiDataGrid-cell[data-field="health"]': {
              paddingLeft: `${CELL_VERTICAL_PADDING}px`,
              paddingRight: `${CELL_VERTICAL_PADDING}px`,
            },
            '& .MuiDataGrid-cell[data-field="last_run_at"]': {
              color: theme.palette.text.secondary,
              fontVariantNumeric: "tabular-nums",
            },
            "& .MuiDataGrid-footerContainer": {
              borderTop: `1px solid ${hairline}`,
              color: theme.palette.text.secondary,
            },
          }}
          rows={rows}
          columns={columns}
          loading={listing.loading}
          // Rows grow with their content, so a wrapped name is never cut off;
          // `rowHeight` is what the grid assumes for a row it has not measured.
          getRowHeight={() => "auto"}
          rowHeight={ROW_HEIGHT}
          // Taller by the Name header's rows of name-filter chips.
          columnHeaderHeight={columnHeaderHeightFor(searchExtraHeight)}
          disableColumnMenu
          disableColumnResize
          disableRowSelectionOnClick
          sortingMode="server"
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
