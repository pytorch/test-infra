// The tests page's choices in the hub's row: the window, the code sources
// and the languages, each a named control whose values and labels are the
// options'. What the three say, the places held until the options arrive,
// and the query each hands the page when its choice changes.

import { ButtonBase, ListItemText, MenuItem } from "@mui/material";
import TestsChoices from "components/tests/TestsChoices";
import { testOptionsFrom } from "lib/api/tests/options/options";
import type { TestOptions } from "lib/api/tests/options/types";
import {
  resolveTestsQuery,
  TestsQuery,
  testsQueryFromUrl,
} from "lib/tests/table";
import type { UrlQuery } from "lib/tests/url";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { CATALOG_VALUES } from "test/api/tests/fixtures";

// The menu without its popover, which is placed in a document this
// environment has none of: its items while it is open.
jest.mock("@mui/material", () => {
  const React = jest.requireActual("react");
  return {
    ...jest.requireActual("@mui/material"),
    Menu: function Menu({ open, children }: Record<string, any>) {
      return open ? React.createElement("menu-popover", null, children) : null;
    },
  };
});

const options = testOptionsFrom(CATALOG_VALUES);
const queryOf = (url: UrlQuery = {}, offered: TestOptions = options) =>
  resolveTestsQuery(testsQueryFromUrl(url), offered);
const noop = () => {};

// The words of each control, in order.
function controls(
  query: TestsQuery | undefined,
  offered: TestOptions | undefined = options
): string[] {
  const html = renderToStaticMarkup(
    <TestsChoices options={offered} query={query} onQueryChange={noop} />
  ).replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "");
  return Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g), (match) =>
    match[0]
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim()
  );
}

describe("TestsChoices", () => {
  test("names the page's three choices and says each as the options label it", () => {
    expect(controls(queryOf())).toEqual([
      "Window 3 hours",
      "Ran on main",
      "Language All",
    ]);
    expect(
      controls(
        queryOf({
          window: "7d",
          ran_on: "main,pull_request",
          language: ["cpp", "python"],
        })
      )
    ).toEqual([
      "Window 7 days",
      "Ran on main and pull requests",
      // In the menu's order, whatever the URL's.
      "Language Python and C++",
    ]);
  });

  test("spells no value itself: a label the options change is the label shown", () => {
    const renamed: TestOptions = {
      ...options,
      window: {
        ...options.window,
        values: options.window.values.map((each) =>
          each.value === options.window.default
            ? { ...each, label: "a few hours" }
            : each
        ),
      },
      ran_on: {
        ...options.ran_on,
        values: options.ran_on.values.map((each) =>
          each.value === "main" ? { ...each, label: "trunk" } : each
        ),
      },
    };
    expect(controls(queryOf({}, renamed), renamed)).toEqual([
      "Window a few hours",
      "Ran on trunk",
      "Language All",
    ]);
  });

  test("holds the three places until the options arrive", () => {
    for (const [offered, query] of [
      [undefined, undefined],
      [options, undefined],
    ] as const) {
      const html = renderToStaticMarkup(
        <TestsChoices options={offered} query={query} onQueryChange={noop} />
      );
      expect(html).not.toContain("<button");
      // As wide as the controls are on the page's defaults.
      expect(
        Array.from(
          html.matchAll(
            /<span class="MuiSkeleton-root [^"]*" style="width:(\d+)px;height:32px">/g
          ),
          (match) => Number(match[1])
        )
      ).toEqual([146, 126, 128]);
    }
  });
});

describe("changing a choice", () => {
  let renderer: ReactTestRenderer | undefined;
  const onQueryChange = jest.fn();
  beforeEach(() => onQueryChange.mockClear());
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  // The choices on a page that takes each query handed to it, as the tests
  // page does through its URL.
  function Page({ initial }: { initial: TestsQuery }) {
    const [query, setQuery] = useState(initial);
    return (
      <TestsChoices
        options={options}
        query={query}
        onQueryChange={(next) => {
          onQueryChange(next);
          setQuery(next);
        }}
      />
    );
  }

  function mount(initial: TestsQuery = queryOf()) {
    act(() => {
      renderer = create(<Page initial={initial} />);
    });
    const root = renderer!.root;
    const keys = () =>
      root.findAll(
        (node) =>
          node.type === ButtonBase && node.props["aria-haspopup"] === "menu"
      );
    const items = () => root.findAllByType(MenuItem);
    const text = (item: (typeof root.children)[number]) =>
      typeof item === "string"
        ? item
        : (item.findByType(ListItemText).props.primary as string);
    return {
      // Opens the menu of the control at the place given, from the left.
      open: (index: number) =>
        act(() => keys()[index].props.onClick({ currentTarget: {} })),
      items: () =>
        items().map((item) => [
          text(item),
          item.props["aria-checked"],
          item.props.disabled === true ? "kept" : "free",
        ]),
      press: (label: string) =>
        act(() => {
          const found = items().find((item) => text(item) === label);
          if (found === undefined) throw new Error(`No item ${label}`);
          found.props.onClick();
        }),
      last: () => onQueryChange.mock.calls.at(-1)?.[0] as TestsQuery,
    };
  }

  test("the window is one of the options' windows, and the rest of the query stays", () => {
    const initial = queryOf({ language: "python", status: "flaky" });
    const page = mount(initial);
    page.open(0);
    expect(page.items()).toEqual(
      options.window.values.map((each) => [
        each.label,
        each.value === options.window.default,
        "free",
      ])
    );
    page.press("7 days");
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(page.last()).toEqual({ ...initial, window: "7d" });
  });

  test("the code sources are several, in the menu's order, and the last one stays chosen", () => {
    const initial = queryOf();
    const page = mount(initial);
    page.open(1);
    // The API requires a code source: the only one chosen cannot go.
    expect(page.items()).toEqual([
      ["main", true, "kept"],
      ["pull requests", false, "free"],
    ]);
    page.press("pull requests");
    expect(page.last()).toEqual({
      ...initial,
      ranOn: ["main", "pull_request"],
    });
    expect(page.items()).toEqual([
      ["main", true, "free"],
      ["pull requests", true, "free"],
    ]);
    page.press("main");
    expect(page.last()).toEqual({ ...initial, ranOn: ["pull_request"] });
    expect(page.items()).toEqual([
      ["main", false, "free"],
      ["pull requests", true, "kept"],
    ]);
  });

  test("the languages are several, in the menu's order, and none of them means all", () => {
    const initial = queryOf();
    const page = mount(initial);
    page.open(2);
    expect(page.items()).toEqual(
      options.language.values.map((each) => [each.label, false, "free"])
    );
    page.press("C++");
    page.press("Python");
    expect(page.last()).toEqual({ ...initial, languages: ["python", "cpp"] });
    page.press("C++");
    page.press("Python");
    // Back to none, which nothing keeps from being chosen.
    expect(page.last()).toEqual(initial);
    expect(onQueryChange).toHaveBeenCalledTimes(4);
  });
});
