// The commit table's Job header: its filter reaches the header past the
// grids, so the choices that arrive with the jobs' tests are shown without
// the table's rows being drawn again.

import CommitTable, { CommitTableProps } from "components/tests/CommitTable";
import HeaderFilter from "components/tests/HeaderFilter";
import HubDataGrid from "components/tests/HubDataGrid";
import { DEFAULT_COMMIT_SORT } from "lib/tests/commitPage";
import { noFacetValues } from "lib/tests/facets";
import { buildTimeline, jobFilterOf } from "lib/tests/timeline";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { COMMIT_JOBS, COMMIT_TESTS } from "./timelineFixtures";

// The grid stands in as a count of the times it is drawn, with the Job
// column's header inside it, where the real grid has it.
jest.mock("components/tests/HubDataGrid", () => ({
  __esModule: true,
  default: jest.fn(({ columns }) =>
    columns
      .find((column: { field: string }) => column.field === "job")
      .renderHeader()
  ),
}));
const grid = HubDataGrid as unknown as jest.Mock;

const NOW = Date.parse("2026-11-14T07:00:00Z") / 1000;
const noop = () => undefined;
const PROPS: Omit<CommitTableProps, "jobFilter" | "onJobFilter"> = {
  repo: "pytorch/pytorch",
  runs: [],
  loading: false,
  loadingMore: false,
  hasMore: false,
  onLoadMore: noop,
  statuses: [],
  onStatusesChange: noop,
  error: undefined,
  onRetry: noop,
  timing: null,
  top: null,
  emptyText: "",
  sort: DEFAULT_COMMIT_SORT,
  onSortChange: noop,
  options: undefined,
  filters: noFacetValues(),
  onFiltersChange: noop,
  onFilter: noop,
  search: "",
  onSearchInput: noop,
  onSearch: noop,
};

test("the Job header shows a new filter without the grids being drawn again", () => {
  // The jobs' tests bring the header its choices.
  const before = jobFilterOf(buildTimeline(COMMIT_JOBS, undefined, NOW), null);
  const after = jobFilterOf(
    buildTimeline(COMMIT_JOBS, COMMIT_TESTS, NOW),
    null
  );
  expect(before.sections).toEqual([]);
  const choice = after.sections[0].options[0].value;

  const onJobFilter = jest.fn();
  const table = (jobFilter: typeof before) => (
    <CommitTable {...PROPS} jobFilter={jobFilter} onJobFilter={onJobFilter} />
  );
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(table(before));
  });
  const header = () => renderer.root.findByType(HeaderFilter).props;
  expect(header().sections).toBe(before.sections);
  const drawn = grid.mock.calls.length;

  act(() => renderer.update(table(after)));
  expect(header().sections).toBe(after.sections);
  expect(grid.mock.calls.length).toBe(drawn);

  act(() => header().onChange({ [after.sections[0].facet]: [choice] }));
  expect(onJobFilter).toHaveBeenCalledWith(choice);
});
