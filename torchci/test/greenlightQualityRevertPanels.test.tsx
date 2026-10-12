// Pins the two panels the reverts query feeds: the table of reverts carrying a
// GreenLight LAND, with what it says when it lists none, and the revert tile's
// face. The two state one staleness note, counted over the same rows.
//
// The real useQualityQuery runs over the stand-in for SWR in the shared helpers.
// lib/GeneralUtils is mocked because it carries octokit, which does not load
// under this jest environment. The table panel is a stub that keeps what
// RevertedTable hands it: the rows it lists and the overlay it shows when there
// are none.

import { QualityChartKey } from "components/greenlight/quality/chartConfigs";
import RevertedTable from "components/greenlight/quality/RevertedTable";
import { REVERTED_TABLE } from "components/greenlight/quality/tableConfigs";
import {
  REVERT_RATE_CAVEAT,
  REVERT_RATE_LABEL,
} from "components/greenlight/quality/tileConfigs";
import TrustPanels from "components/greenlight/quality/TrustPanels";
import {
  approvedRevertRows,
  staleVerdictNote,
} from "lib/greenlight/qualityFigures";
import { QUALITY_QUERIES, qualityUrl } from "lib/greenlight/qualityQuery";
import { ComponentType, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ANCHOR,
  ariaLabels,
  useSWRStub as mockUseSWR,
  revert,
  shas,
  swrStub,
  texts,
  WINDOW_PROPS,
  withTotals,
} from "./greenlightQuality.helpers";

jest.mock("lib/GeneralUtils", () => ({ fetcher: jest.fn() }));

jest.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null, fetcher: unknown, options: any) =>
    mockUseSWR(key, fetcher, options),
}));

let mockTable: any;

jest.mock("components/metrics/panels/TablePanel", () => ({
  TablePanelWithData: (props: any) => {
    mockTable = props;
    return null;
  },
}));

const REVERTS_URL = qualityUrl(
  QUALITY_QUERIES.reverts,
  WINDOW_PROPS.startTime,
  WINDOW_PROPS.stopTime,
  WINDOW_PROPS.shadowMode
);

const CONFIRMED = revert("confirmed", "LAND", "yes");
const UNVERIFIED = revert("unverified", "LAND", "unknown", "");
const GHFIRST_CURRENT = revert("ghfirst-current", "LAND", "yes", "ghfirst");
const GHFIRST_UNVERIFIED = revert(
  "ghfirst-unverified",
  "LAND",
  "unknown",
  "ghfirst"
);
const STALE = revert("stale", "LAND", "no");
const STALE_GHFIRST = revert("stale-ghfirst", "LAND", "no", "ghfirst");
const NO_LAND_REVERT = revert("no-land", "NO_LAND", "unknown");
const UNEVALUATED = revert("unevaluated", "", "unknown", "");

// MIXED and its window totals as greenlight_quality_reverts reports them.
const MIXED = withTotals(
  [
    CONFIRMED,
    UNVERIFIED,
    GHFIRST_CURRENT,
    GHFIRST_UNVERIFIED,
    STALE,
    STALE_GHFIRST,
    NO_LAND_REVERT,
    UNEVALUATED,
  ],
  {
    land_approved_reverts: 2,
    land_approved_ghfirst_reverts: 2,
    land_approved_stale_reverts: 2,
    ghfirst_reverts: 3,
  }
);

function renderTable(rows: any[]) {
  swrStub.data.set(REVERTS_URL, rows);
  mockTable = undefined;
  renderToStaticMarkup(<RevertedTable {...WINDOW_PROPS} />);
  const Overlay: ComponentType = mockTable.dataGridProps.slots.noRowsOverlay;
  return {
    listed: shas(mockTable.data),
    heading: renderToStaticMarkup(mockTable.title),
    emptyMessage: texts(renderToStaticMarkup(<Overlay />)).join(""),
  };
}

function renderTile(rows: any[]): string {
  swrStub.data.set(REVERTS_URL, rows);
  return renderToStaticMarkup(
    <TrustPanels
      {...WINDOW_PROPS}
      openCharts={new Set<QualityChartKey>()}
      onToggleChart={() => {}}
    />
  );
}

beforeEach(() => {
  swrStub.reset();
});

describe("RevertedTable", () => {
  test.each([
    ["a window with no reverts", [ANCHOR], "No reverts in this window."],
    [
      "a window whose reverts GreenLight never approved",
      [NO_LAND_REVERT, UNEVALUATED],
      "No GreenLight-approved reverts in this window.",
    ],
    [
      "a window whose reverts carrying a GreenLight LAND were all stale",
      [STALE, STALE_GHFIRST, NO_LAND_REVERT],
      "Every revert carrying a GreenLight LAND in this window was excluded as stale.",
    ],
  ])("%s lists nothing and says why", (_case, rows, message) => {
    const table = renderTable(withTotals(rows, {}));
    expect(table.listed).toEqual([]);
    expect(table.emptyMessage).toBe(message);
  });

  test("lists the reverts of a current approved version, ghfirst ones included", () => {
    expect(renderTable(MIXED).listed).toEqual(
      shas([CONFIRMED, UNVERIFIED, GHFIRST_CURRENT, GHFIRST_UNVERIFIED])
    );
  });

  // The rows the table lists have already lost their stale reverts, so a note
  // counted over them would always report none.
  test("states the tile's staleness note, counted over every revert carrying a GreenLight LAND", () => {
    const note = staleVerdictNote(MIXED);
    expect(note).not.toBe(staleVerdictNote(approvedRevertRows(MIXED)));
    expect(ariaLabels(renderTable(MIXED).heading)).toContain(
      `${REVERTED_TABLE.heading}: ${note}`
    );
    expect(ariaLabels(renderTile(MIXED))).toContain(
      `${REVERT_RATE_LABEL}: ${REVERT_RATE_CAVEAT} ${note}`
    );
  });

  // Its props are all primitives, so the page's re-renders for state the table
  // does not read pass it by.
  test("is memoised", () => {
    const element = <RevertedTable {...WINDOW_PROPS} />;
    expect(isValidElement(element)).toBe(true);
    expect((element.type as any).$$typeof).toBe(Symbol.for("react.memo"));
  });
});

describe("the revert tile's face", () => {
  test("lists its exclusions, ghfirst then stale, each on a line of its own", () => {
    const lines = texts(renderTile(MIXED));
    const ghfirst = lines.indexOf("2 excluded as ghfirst");
    const stale = lines.indexOf("2 excluded as stale");
    expect(ghfirst).toBeGreaterThan(-1);
    expect(stale).toBe(ghfirst + 1);
  });

  test("names no exclusion that removed nothing", () => {
    const current = withTotals([CONFIRMED], {
      land_approved_reverts: 1,
      land_approved_ghfirst_reverts: 0,
      land_approved_stale_reverts: 0,
      ghfirst_reverts: 0,
    });
    expect(texts(renderTile(current)).join("\n")).not.toContain("excluded as");
  });
});
