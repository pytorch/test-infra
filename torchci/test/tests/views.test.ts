// How the tests page reads the named views GET /api/tests/options serves:
// a view's cell is marked only while the table shows exactly that view, the
// first view, the list's defaults in the default window, when the page
// opens; choosing one keeps the window and the languages unless it sets its
// own, which is what GET /api/tests/summary reads the view's figure over;
// and clearing it leaves the list's defaults, which nothing clears.

import type { RawQuery } from "lib/api/parameters";
import { testOptionsFrom } from "lib/api/tests/options/options";
import type { TestView } from "lib/api/tests/options/types";
import { parseTestListParams, WINDOWS } from "lib/api/tests/parameters";
import { figureListQuery, viewListQuery } from "lib/api/tests/summary/summary";
import {
  resolveTestsQuery,
  testsApiUrl,
  TestsQuery,
  testsQueryFromUrl,
} from "lib/tests/table";
import {
  activeViewIds,
  chooseView,
  clearableViewIds,
  viewsOf,
  viewStatuses,
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
  test("marks the first view on a bare URL, where the page opens", () => {
    expect(options.views[0].id).toBe("unhealthy");
    expect(activeViewIds(queryOf({}), options)).toEqual(["unhealthy"]);
    // In whatever languages the reader is in.
    expect(activeViewIds(queryOf({ language: "python" }), options)).toEqual([
      "unhealthy",
    ]);
  });

  // The first view is the default table, and that table is of the default
  // window. Until 2026-11-24 the view named no window and was marked in any:
  // over 7 days, or over the 12 hours Blocking viable/strict had left the
  // page in.
  test("leaves the first view in every window but the default, which is its own", () => {
    expect(view("unhealthy").params.window).toBe(options.window.default);
    for (const window of WINDOWS) {
      expect({
        window,
        marked: activeViewIds(queryOf({ window }), options),
      }).toEqual({
        window,
        marked: window === options.window.default ? ["unhealthy"] : [],
      });
    }
    expect(
      activeViewIds(queryOf({ window: "7d", language: "python" }), options)
    ).toEqual([]);
  });

  test("leaves the first view as soon as the table shows anything but the defaults", () => {
    for (const change of [
      { status: "failing" },
      { accelerator: "cuda" },
      { search: "conv" },
      { sort: "-runs" },
      { ran_on: "main,pull_request" },
      { file: "test/test_nn.py" },
    ]) {
      expect(activeViewIds(queryOf(change), options)).not.toContain(
        "unhealthy"
      );
    }
  });

  test("marks each view on its own parameters, alone", () => {
    for (const each of options.views) {
      expect(activeViewIds(queryOf(each.params), options)).toEqual([each.id]);
    }
  });

  test("leaves a view as soon as the table shows anything else", () => {
    const flaky = view("flaky_main").params;
    for (const change of [
      // A filter, a search and an exact name filter the view does not ask
      // for narrow the table past the view.
      { accelerator: "rocm" },
      { search: "conv" },
      { file: "test/test_nn.py" },
      // A parameter the view sets, changed.
      { sort: "-runs" },
      { status: ["flaky", "failing"] },
      { ran_on: "main,pull_request" },
    ]) {
      expect(activeViewIds(queryOf({ ...flaky, ...change }), options)).toEqual(
        []
      );
    }
  });

  test("keeps a view marked through the window and the languages, which are the reader's", () => {
    const flaky = view("flaky_main").params;
    expect(
      activeViewIds(
        queryOf({ ...flaky, window: "14d", language: ["python", "cpp"] }),
        options
      )
    ).toEqual(["flaky_main"]);
  });

  test("leaves Blocking viable/strict outside its own 12 hours, for the view its filters no longer are", () => {
    const blocking = view("blocking_viable_strict").params;
    expect(activeViewIds(queryOf(blocking), options)).toEqual([
      "blocking_viable_strict",
    ]);
    expect(
      activeViewIds(queryOf({ ...blocking, window: "3d" }), options)
    ).toEqual([]);
    // Its languages are still the reader's.
    expect(
      activeViewIds(queryOf({ ...blocking, language: "python" }), options)
    ).toEqual(["blocking_viable_strict"]);
  });

  test("tells Unhealthy from Blocking viable/strict, which narrows it", () => {
    expect(activeViewIds(queryOf(view("unhealthy").params), options)).toEqual([
      "unhealthy",
    ]);
    expect(
      activeViewIds(
        queryOf({
          ...view("unhealthy").params,
          workflow_path: ".github/workflows/pull.yml",
        }),
        options
      )
    ).toEqual([]);
    expect(
      activeViewIds(queryOf(view("blocking_viable_strict").params), options)
    ).toEqual(["blocking_viable_strict"]);
  });
});

describe("clearableViewIds", () => {
  test("is every marked view but the defaults, which clearing leads back to", () => {
    for (const each of options.views) {
      const shown = chooseView(queryOf({ window: "3d" }), each, options);
      expect(activeViewIds(shown, options)).toEqual([each.id]);
      expect(clearableViewIds(shown, options)).toEqual(
        each.id === "unhealthy" ? [] : [each.id]
      );
    }
  });

  test("is no view the table is not showing", () => {
    expect(clearableViewIds(queryOf({ search: "conv" }), options)).toEqual([]);
    expect(
      clearableViewIds(
        queryOf({ ...view("flaky_main").params, accelerator: "cuda" }),
        options
      )
    ).toEqual([]);
  });
});

describe("chooseView", () => {
  test("starts the view afresh in the reader's window and languages", () => {
    const slowest = view("slowest");
    expect(
      chooseView(
        queryOf({
          window: "3d",
          language: "cpp",
          status: "failing",
          search: "conv",
          file: "test/test_nn.py",
          ran_on: "pull_request",
        }),
        slowest,
        options
      )
    ).toEqual(queryOf({ ...slowest.params, window: "3d", language: "cpp" }));
  });

  test("uses the view's own window when it sets one", () => {
    const blocking = view("blocking_viable_strict");
    const chosen = chooseView(
      queryOf({ window: "3d", language: "python" }),
      blocking,
      options
    );
    expect(chosen.window).toBe("12h");
    expect(chosen.languages).toEqual(["python"]);
  });

  test("returns to the default window for the first view, as after Blocking viable/strict set its own", () => {
    const blocking = chooseView(
      queryOf({ language: "python" }),
      view("blocking_viable_strict"),
      options
    );
    expect(blocking.window).toBe("12h");
    const first = chooseView(blocking, view("unhealthy"), options);
    // The page a reader arrives on, in their languages: not the defaults
    // left at 12 hours with the first cell marked over them.
    expect(first).toEqual(queryOf({ language: "python" }));
    expect(first.window).toBe(options.window.default);
    expect(activeViewIds(first, options)).toEqual(["unhealthy"]);
    // From any window.
    for (const window of WINDOWS) {
      expect(
        chooseView(queryOf({ window }), view("unhealthy"), options)
      ).toEqual(queryOf({}));
    }
  });

  test("uses the view's own languages when it sets them", () => {
    const python: TestView = {
      ...view("slowest"),
      id: "slowest_python",
      params: { ...view("slowest").params, language: ["python"] },
    };
    expect(
      chooseView(queryOf({ language: "cpp" }), python, options).languages
    ).toEqual(["python"]);
  });

  test("marks the view it chose, whatever the page showed before", () => {
    for (const each of options.views) {
      for (const before of [
        {},
        { window: "7d", language: "python", search: "conv" },
        view("flaky_pull_requests").params,
      ]) {
        const chosen = chooseView(queryOf(before), each, options);
        expect(activeViewIds(chosen, options)).toEqual([each.id]);
      }
    }
  });

  // The figure in a view's cell is read by the API for the view in the
  // page's window and languages (viewListQuery), narrowed by the filters the
  // view's figure adds (figureListQuery); choosing the view must ask the
  // list for exactly that view, or the figure promises another table.
  test("asks the list for the view the API reads the figure over", () => {
    const repo = "pytorch/pytorch";
    const listRequest = (raw: RawQuery) => {
      const parsed = parseTestListParams(raw);
      if (!parsed.success) throw new Error(parsed.error.message);
      // The page pages by itself.
      const { cursor: _cursor, limit: _limit, ...query } = parsed.data;
      return query;
    };
    const rawOf = (url: string): RawQuery => {
      const raw: Record<string, string | string[]> = {};
      for (const [name, value] of new URL(url, "https://hud.pytorch.org")
        .searchParams) {
        const existing = raw[name];
        raw[name] = existing === undefined ? value : [existing, value].flat();
      }
      return raw;
    };
    for (const each of options.views) {
      for (const window of WINDOWS) {
        for (const languages of [[], ["python"], ["python", "cpp"]]) {
          const page = queryOf({ window, language: languages });
          const chosen = chooseView(page, each, options);
          const pageRequest = rawOf(
            testsApiUrl({ repo, query: chosen, limit: 25 })
          );
          const summary = {
            repo,
            window,
            ...(languages.length === 0
              ? {}
              : { language: [...languages].sort() as ("python" | "cpp")[] }),
          };
          // What choosing the view lists is the view the API links.
          const { limit: _viewLimit, ...viewList } = viewListQuery(
            each,
            summary
          );
          expect({
            view: each.id,
            window,
            languages,
            asked: listRequest(pageRequest),
          }).toEqual({ view: each.id, window, languages, asked: viewList });
          // And the figure is of those entries, less the ones its own
          // filters leave out: all of them for a figure that adds none.
          const { limit: _figureLimit, ...figureList } = figureListQuery(
            each,
            summary
          );
          expect({
            view: each.id,
            window,
            languages,
            counted: figureList,
          }).toEqual({
            view: each.id,
            window,
            languages,
            counted: listRequest({ ...pageRequest, ...each.figure.params }),
          });
          if (Object.keys(each.figure.params).length === 0) {
            expect(figureList).toEqual(viewList);
          }
        }
      }
    }
  });

  // The first view's figure counts the unhealthy entries, failing or flaky,
  // of a list that the default sort begins with: the rows under the marked
  // cell lead with what its number counts.
  test("counts for the first view the entries its table begins with", () => {
    const first = options.views[0];
    expect(first.figure.params).toEqual({ status: ["failing", "flaky"] });
    // The two statuses the list ranks worst, in its own order.
    expect(options.status.values.slice(0, 2).map((each) => each.value)).toEqual(
      ["failing", "flaky"]
    );
    const chosen = chooseView(queryOf({}), first, options);
    expect(chosen.sort.split(",")[0]).toBe("-status");
    expect(chosen.filters.status).toEqual([]);
  });
});

describe("withoutView", () => {
  test("returns a marked view's parameters to their defaults, in the reader's window and languages", () => {
    const flaky = view("flaky_main");
    expect(
      withoutView(
        queryOf({ ...flaky.params, window: "7d", language: "python" }),
        flaky,
        options
      )
    ).toEqual(queryOf({ window: "7d", language: "python" }));
  });

  test("leaves the list's defaults: the first view in the default window, no view in another", () => {
    // From the page a reader arrives on, clearing any view leads back to it.
    for (const each of options.views) {
      const shown = chooseView(queryOf({}), each, options);
      const cleared = withoutView(shown, each, options);
      expect(cleared).toEqual(queryOf({}));
      expect(activeViewIds(cleared, options)).toEqual(["unhealthy"]);
    }
    // From another window the window stays the reader's, so the defaults
    // are shown in it and no cell is marked; a view that set its own window
    // gives it back, which is the default window and the first view.
    for (const each of options.views) {
      const shown = chooseView(queryOf({ window: "3d" }), each, options);
      const cleared = withoutView(shown, each, options);
      const own = "window" in each.params;
      expect(cleared).toEqual(queryOf(own ? {} : { window: "3d" }));
      expect(activeViewIds(cleared, options)).toEqual(own ? ["unhealthy"] : []);
    }
  });

  test("changes nothing for the defaults themselves", () => {
    const shown = queryOf({ language: "cpp" });
    expect(activeViewIds(shown, options)).toEqual(["unhealthy"]);
    expect(withoutView(shown, view("unhealthy"), options)).toEqual(shown);
  });
});

describe("viewStatuses", () => {
  test("are the statuses a view's figure counts or the view narrows to, and none for a view of every status", () => {
    // The first view lists every status; its figure counts the unhealthy
    // ones, and its cell is about both.
    expect(view("unhealthy").params).not.toHaveProperty("status");
    expect(viewStatuses(view("unhealthy"))).toEqual(["failing", "flaky"]);
    // The figure's own statuses stand before the view's.
    expect(
      viewStatuses({
        params: { status: ["flaky"] },
        figure: { params: { status: ["failing"] } },
      })
    ).toEqual(["failing"]);
    // Options from before a figure had params of its own.
    expect(viewStatuses({ params: { status: ["flaky"] }, figure: {} })).toEqual(
      ["flaky"]
    );
    expect(viewStatuses(view("blocking_viable_strict"))).toEqual(["failing"]);
    expect(viewStatuses(view("flaky_main"))).toEqual(["flaky"]);
    expect(viewStatuses(view("flaky_pull_requests"))).toEqual(["flaky"]);
    expect(viewStatuses(view("slowest"))).toEqual([]);
    expect(viewStatuses(view("most_ci_time"))).toEqual([]);
    // As the view names them.
    expect(viewStatuses({ params: { status: ["flaky", "failing"] } })).toEqual([
      "flaky",
      "failing",
    ]);
    // A URL spells one value as a string.
    expect(viewStatuses({ params: { status: "skipped" } })).toEqual([
      "skipped",
    ]);
  });
});
