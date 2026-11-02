import { Typography } from "@mui/material";
import { GridColDef } from "@mui/x-data-grid";
import ColumnTitle from "components/tests/ColumnTitle";
import Config from "components/tests/Config";
import Environment from "components/tests/Environment";
import type { FacetSection } from "components/tests/FacetMenu";
import HeaderFilter from "components/tests/HeaderFilter";
import NameSearch, { NameSearchProps } from "components/tests/NameSearch";
import Owners from "components/tests/Owners";
import TestName, {
  TEST_NAME_SEPARATOR,
  TestNameParts,
  testNameParts,
} from "components/tests/TestName";
import type { TestOptions } from "lib/api/tests/options/types";
import type { EnvironmentRecord, EnvVarsRecord } from "lib/api/tests/types";
import type { Token } from "lib/tests/environment";
import {
  CONFIG_COLUMN_FACETS,
  ENVIRONMENT_COLUMN_FACETS,
  FACET_TITLES,
  facetChoice,
  facetsPhrase,
  FacetValues,
  OWNER_COLUMN_FACETS,
  TestsFacet,
} from "lib/tests/facets";
import { COLUMN_WIDTHS, NAME_MIN_WIDTH } from "lib/tests/layout";
import { FILTERABLE_HEADER, SEARCH_HEADER } from "lib/tests/tableStyle";
import type { ReactNode } from "react";

// The four columns the hub's tables share, the tests list's
// (TestsTable) and the commit page's: Name, Environment, Test Config and
// Owners, each built once here for a row of either table. Their sort
// fields and header help are in lib/tests/columns.ts. Every header and
// every cell is left-aligned, the figures too, so each column reads down
// one edge from its label. (A right-aligned label would also jump: the
// grid's sort arrow takes no width until its header is hovered or sorted,
// so a label set against the right edge moves left to make room for it,
// while a left-aligned one stays put and the arrow appears after it.)

// What a row of either table shows in the shared columns.
export interface HubRow {
  // The test; null when its catalog row is missing, which a run's bundle
  // can be without.
  test: TestNameParts | null;
  environment: EnvironmentRecord | null;
  env_vars: EnvVarsRecord | null;
  // The calling workflow paths of the row's configuration: a test's from
  // its health, a run's from its job.
  workflowPaths: readonly string[];
  owners: readonly string[];
  // The row above shows the same environment and the table is sorted by it.
  environmentRepeated: boolean;
}

// The menu sections of a column's facets: each facet's title and the values
// the options offer for it, none until the options arrive.
export function sectionsOf(
  facets: readonly TestsFacet[],
  options: TestOptions | undefined
): FacetSection[] {
  return facets.map((facet) => ({
    facet,
    title: FACET_TITLES[facet],
    options: options === undefined ? [] : facetChoice(options, facet).values,
  }));
}

// A table's own rows among the shared columns' cells: given, a column asks
// it first and renders what it returns, falling back to its own cell for
// undefined; and how many columns a row's cell spans, 1 unless given.
export interface RowOverrides<Row extends HubRow> {
  renderRow?: (_row: Row) => ReactNode | undefined;
  colSpan?: (_row: Row) => number;
}

export interface NameColumnProps<Row extends HubRow> extends RowOverrides<Row> {
  // What the column shows, for the header's tooltip.
  description: string;
  // Where a row's name leads, the test's page; undefined for plain text.
  href: (_row: Row) => string | undefined;
  // The header's search field.
  search: NameSearchProps;
  // Search for this text now: a file or suite clicked in a cell.
  onSearch: (_text: string) => void;
}

export function nameColumn<Row extends HubRow>({
  description,
  href,
  search,
  onSearch,
  renderRow,
  colSpan,
}: NameColumnProps<Row>): GridColDef<Row> {
  return {
    field: "name",
    ...(colSpan === undefined
      ? {}
      : { colSpan: (_value, row) => colSpan(row) }),
    headerName: "Name",
    headerClassName: SEARCH_HEADER,
    // The label as the grid would set it, and the column's search, which
    // the header's styles set after the sort arrow, filling the header.
    renderHeader: () => (
      <>
        <ColumnTitle title="Name" description={description} />
        <NameSearch {...search} />
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
      row.test === null
        ? ""
        : testNameParts(row.test).join(TEST_NAME_SEPARATOR),
    renderCell: ({ row }) =>
      renderRow?.(row) ??
      (row.test === null ? (
        <Typography component="span" variant="body2" color="text.secondary">
          Unknown test
        </Typography>
      ) : (
        <TestName test={row.test} href={href(row)} onSearch={onSearch} />
      )),
  };
}

// What the three filterable shared columns need.
export interface FilterColumnProps<Row extends HubRow = HubRow>
  extends RowOverrides<Row> {
  // What the column shows, for the header's tooltip.
  description: string;
  // The options, for the labels of the cells and the values the header's
  // filter offers; undefined before they arrive, when the cells show the
  // catalog's spelling and the filter offers nothing yet.
  options: TestOptions | undefined;
  // The facet filters in force, which the header shows.
  filters: FacetValues;
  // The header's filter changed: the facets it covers with their new values.
  onFiltersChange: (_next: Partial<FacetValues>) => void;
  // A value clicked in a cell: the facets it stands for, to filter by.
  onFilter: (_filters: Token["filters"]) => void;
}

// What a table gives every filterable column: its options, the filters in
// force and the two handlers, which this pairs with the column's own
// description.
export function filterColumnProps<Row extends HubRow>(
  table: Pick<
    FilterColumnProps<Row>,
    "options" | "filters" | "onFiltersChange" | "onFilter"
  >,
  description: string
): FilterColumnProps<Row> {
  return { description, ...table };
}

// A filterable column's header: the label as the grid would set it, so it
// shares the other headers' style, and the column's filter beside it.
function FilterHeader({
  title,
  column,
  anyLabel,
  facets,
  description,
  options,
  filters,
  onFiltersChange,
}: Omit<FilterColumnProps, "renderRow" | "colSpan"> & {
  title: string;
  // The column, lowercase, for what the filter says: "environment".
  column: string;
  // The menu's first item: "Any environment".
  anyLabel: string;
  facets: readonly TestsFacet[];
}) {
  return (
    <>
      <ColumnTitle title={title} description={description} />
      <HeaderFilter
        column={column}
        summary={
          options === undefined ? "" : facetsPhrase(facets, filters, options)
        }
        anyLabel={anyLabel}
        sections={sectionsOf(facets, options)}
        value={filters}
        onChange={onFiltersChange}
      />
    </>
  );
}

export function environmentColumn<Row extends HubRow>(
  props: FilterColumnProps<Row>
): GridColDef<Row> {
  return {
    field: "environment",
    headerName: "Environment",
    headerClassName: FILTERABLE_HEADER,
    ...(props.colSpan === undefined
      ? {}
      : { colSpan: (_value, row) => props.colSpan!(row) }),
    renderHeader: () => (
      <FilterHeader
        title="Environment"
        column="environment"
        anyLabel="Any environment"
        facets={ENVIRONMENT_COLUMN_FACETS}
        {...props}
      />
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
    renderCell: ({ row }) =>
      props.renderRow?.(row) ?? (
        <Environment
          environment={row.environment}
          options={props.options}
          onFilter={props.onFilter}
          repeated={row.environmentRepeated}
        />
      ),
  };
}

export function testConfigColumn<Row extends HubRow>(
  props: FilterColumnProps<Row>
): GridColDef<Row> {
  return {
    field: "test_config",
    headerName: "Test Config",
    headerClassName: FILTERABLE_HEADER,
    renderHeader: () => (
      <FilterHeader
        title="Test Config"
        column="test config"
        anyLabel="Any test config or workflow"
        facets={CONFIG_COLUMN_FACETS}
        {...props}
      />
    ),
    width: COLUMN_WIDTHS.test_config,
    display: "flex",
    sortingOrder: ["asc", "desc"],
    valueGetter: (_value, row) => row.env_vars?.id ?? "",
    renderCell: ({ row }) =>
      props.renderRow?.(row) ?? (
        <Config
          envVars={row.env_vars}
          workflowPaths={row.workflowPaths}
          onFilter={props.onFilter}
        />
      ),
  };
}

export function ownersColumn<Row extends HubRow>(
  props: FilterColumnProps<Row>
): GridColDef<Row> {
  return {
    field: "owners",
    headerName: "Owners",
    headerClassName: FILTERABLE_HEADER,
    renderHeader: () => (
      <FilterHeader
        title="Owners"
        column="owners"
        anyLabel="Any owner"
        facets={OWNER_COLUMN_FACETS}
        {...props}
      />
    ),
    // Wide enough for the longest label at the table's text size.
    width: COLUMN_WIDTHS.owners,
    display: "flex",
    sortingOrder: ["asc", "desc"],
    valueGetter: (_value, row) => row.owners.join(", "),
    renderCell: ({ row }) =>
      props.renderRow?.(row) ?? (
        <Owners owners={row.owners} onFilter={props.onFilter} />
      ),
  };
}
