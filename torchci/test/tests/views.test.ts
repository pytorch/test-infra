// How the tests page reads the named views GET /api/tests/options serves:
// a view's chip stays chosen while its own parameters hold, whatever else
// refines it, and the most specific view that holds is the one shown;
// choosing one keeps the window unless it sets one, and clearing it keeps
// the refinements.

import { testOptionsFrom } from "lib/api/tests/options/options";
import type { TestView } from "lib/api/tests/options/types";
import {
  resolveTestsQuery,
  TestsQuery,
  testsQueryFromUrl,
} from "lib/tests/table";
import {
  activeViewIds,
  chooseView,
  viewsOf,
  withoutView,
} from "lib/tests/views";
import { CATALOG_VALUES } from "test/api/tests/fixtures";

const options = testOptionsFrom(CATALOG_VALUES);
const view = (id: string): TestView => {
  const found = options.views.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No view ${id}`);
  return found;
};
// The query a page URL with these parameters asks for.
const queryOf = (
  url: Record<string, string | string[] | undefined>
): TestsQuery => resolveTestsQuery(testsQueryFromUrl(url), options);

describe("viewsOf", () => {
  test("offers the options' views, and none from options that predate them", () => {
    expect(viewsOf(options)).toBe(options.views);
    expect(viewsOf({})).toEqual([]);
  });
});

describe("activeViewIds", () => {
  test("names the defaults' view on a bare URL, where the page opens", () => {
    expect(activeViewIds(queryOf({}), options)).toEqual([options.views[0].id]);
  });

  test("names the view whose parameters the page shows, not the defaults it starts from", () => {
    expect(
      activeViewIds(queryOf(view("blocking_viable_strict").params), options)
    ).toEqual(["blocking_viable_strict"]);
  });

  test("keeps a view chosen while the page refines it", () => {
    const flaky = view("flaky_main").params;
    expect(
      activeViewIds(
        queryOf({
          ...flaky,
          window: "14d",
          accelerator: "rocm",
          search: "conv",
        }),
        options
      )
    ).toEqual(["flaky_main"]);
  });

  test("leaves a view once a parameter it sets changes", () => {
    const flaky = view("flaky_main").params;
    for (const change of [
      { sort: "-runs" },
      { status: ["flaky", "failing"] },
      // main is the default, and still a parameter the view sets.
      { ran_on: "main,pull_request" },
    ]) {
      expect(activeViewIds(queryOf({ ...flaky, ...change }), options)).toEqual(
        []
      );
    }
  });

  test("leaves Blocking viable/strict outside its 12 hours", () => {
    expect(
      activeViewIds(
        queryOf({ ...view("blocking_viable_strict").params, window: "3d" }),
        options
      )
    ).toEqual([options.views[0].id]);
  });
});

describe("chooseView", () => {
  test("starts the view afresh in the reader's window", () => {
    const slowest = view("slowest");
    expect(
      chooseView(
        queryOf({ window: "3d", status: "failing", search: "conv" }),
        slowest,
        options
      )
    ).toEqual(queryOf({ ...slowest.params, window: "3d" }));
  });

  test("uses the view's own window when it sets one", () => {
    const blocking = view("blocking_viable_strict");
    expect(
      chooseView(queryOf({ window: "3d" }), blocking, options).window
    ).toBe("12h");
  });
});

describe("withoutView", () => {
  test("returns the view's parameters to their defaults and keeps the rest", () => {
    const flaky = view("flaky_main");
    expect(
      withoutView(
        queryOf({ ...flaky.params, accelerator: "rocm" }),
        flaky,
        options
      )
    ).toEqual(queryOf({ accelerator: "rocm" }));
  });
});
