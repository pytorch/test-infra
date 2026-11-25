// The band above the tests table: one button per named view, with its name,
// its figure and its caption, set on two lines; the cell of the view the
// table shows marked as a whole, in both themes; what a click does, and
// when the chosen cell's button reads "Showing" and when "Clear"; and the
// colors the marking is made of, measured against the backgrounds they sit
// on.

import { ButtonBase, createTheme, ThemeProvider } from "@mui/material";
import {
  alpha,
  decomposeColor,
  getContrastRatio,
  type Theme,
} from "@mui/material/styles";
import ViewBand, { ViewBandProps } from "components/tests/ViewBand";
import { testOptionsFrom } from "lib/api/tests/options/options";
import type { TestView } from "lib/api/tests/options/types";
import type { TestSummary, TestViewFigure } from "lib/api/tests/summary/types";
import { solidHueColor } from "lib/tests/blockColors";
import { accentFillColor, accentTextColor } from "lib/tests/headerColors";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { CATALOG_VALUES } from "test/api/tests/fixtures";

// MUI's light theme, which HUD uses as it is, and HUD's dark palette
// (styles/MuiThemeOverrides.tsx), each with the page's background
// (styles/globals.css).
const THEMES = {
  light: {
    theme: createTheme({ palette: { mode: "light" } }),
    page: "#ffffff",
  },
  dark: {
    theme: createTheme({
      palette: {
        mode: "dark",
        background: { default: "#1E1E1E", paper: "#2A2A2A" },
        text: { primary: "#E0E0E0", secondary: "#AAAAAA" },
        primary: { main: "#4A90E2" },
        divider: "#3A3A3A",
      },
    }),
    page: "#1e1e1e",
  },
} as const;
type Mode = keyof typeof THEMES;
const MODES = Object.keys(THEMES) as Mode[];

const HOUR = 60 * 60 * 1000;
const options = testOptionsFrom(CATALOG_VALUES);
const view = (id: string): TestView => {
  const found = options.views.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No view ${id}`);
  return found;
};

function figure(
  id: string,
  overrides: Partial<TestViewFigure>
): TestViewFigure {
  return {
    id,
    kind: "count",
    window: "3h",
    count: null,
    duration_milliseconds: null,
    test: null,
    hud_url: null,
    ...overrides,
  };
}

const SLOWEST_TEST: NonNullable<TestViewFigure["test"]> = {
  id: "13862921515559540007",
  hud_url:
    "https://hud.pytorch.org/tests/pytorch/pytorch/test/13862921515559540007",
  repo: "pytorch/pytorch",
  file: "test/test_nn.py",
  suite: "TestNN",
  case_name: "test_cudnn_rnn_dropout_states_device",
  declared_case_name: "test_cudnn_rnn_dropout_states_device",
  language: "python",
  first_seen_at: "2026-10-14T06:57:57.812Z",
};

// A figure for every view: counts, one of them none, a slowest test and a
// total of machine time.
const SUMMARY: TestSummary = {
  views: [
    figure("unhealthy", { count: 20 }),
    figure("blocking_viable_strict", { count: 0 }),
    figure("flaky_main", { count: 1502 }),
    figure("flaky_pull_requests", { count: 118 }),
    figure("slowest", {
      kind: "slowest",
      duration_milliseconds: 1296000,
      test: SLOWEST_TEST,
    }),
    figure("most_ci_time", {
      kind: "total_duration",
      duration_milliseconds: 1240 * HOUR,
    }),
  ],
  hud_url: null,
  refreshed_at: "2026-11-24T10:00:00Z",
  query_duration_ms: 1,
};

const noop = () => {};
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

// The first view is the list's defaults: the cell marked when the page
// opens, and the one a click cannot clear.
const HOME = options.views[0].id;

// The band over every view and its figure, but for the props given. As on
// the page, a marked view can be cleared unless it is the defaults.
function band(props: Partial<ViewBandProps>) {
  return (
    <ViewBand
      views={options.views}
      activeIds={[]}
      clearableIds={(props.activeIds ?? []).filter((id) => id !== HOME)}
      summary={SUMMARY}
      figuresLoading={false}
      options={options}
      onChoose={noop}
      onClear={noop}
      {...props}
    />
  );
}

// The band's markup without the styles Emotion writes beside it, those
// styles, and the markup of each cell.
function rendered(props: Partial<ViewBandProps> = {}, mode: Mode = "light") {
  const markup = renderToStaticMarkup(
    <ThemeProvider theme={THEMES[mode].theme}>{band(props)}</ThemeProvider>
  );
  const html = markup.replace(STYLE, "");
  return {
    html,
    css: Array.from(markup.matchAll(STYLE), (match) => match[1]).join("\n"),
    cells: Array.from(
      html.matchAll(/<button\b[\s\S]*?<\/button>/g),
      (match) => match[0]
    ),
  };
}

function decoded(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function words(html: string): string {
  return decoded(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// An attribute of a cell's own tag.
function attribute(cell: string, name: string): string | undefined {
  const tag = cell.slice(0, cell.indexOf(">") + 1);
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match === null ? undefined : decoded(match[1]);
}

// The class Emotion gave the first tag the pattern finds in a cell; the
// pattern captures it.
function styled(cell: string, pattern: RegExp): string {
  const match = pattern.exec(cell);
  if (match === null) throw new Error(`No ${pattern} in ${cell}`);
  return match[1];
}
const CLASS = "(css-[\\w-]+)";
const cellClass = (cell: string) =>
  styled(cell, new RegExp(`^<button class="[^"]*?${CLASS}"`));
// The line with the view's name, the first in a cell.
const labelClass = (cell: string) =>
  styled(cell, new RegExp(`^<button[^>]*><span class="MuiBox-root ${CLASS}"`));
// The dots before the name, the only empty spans, in order.
const dotClasses = (cell: string) =>
  Array.from(
    cell.matchAll(
      new RegExp(`<span class="MuiBox-root ${CLASS}"></span>`, "g")
    ),
    (match) => match[1]
  );
// The figure's line, the one after the name's: after the name's own words,
// which the dots before the name have none of.
const figureClass = (cell: string) =>
  styled(
    cell,
    new RegExp(`[^<>]</span></span><span class="MuiBox-root ${CLASS}"`)
  );
// The caption, the words just ahead of the drawn button.
const captionClass = (cell: string) =>
  styled(
    cell,
    new RegExp(
      `<span class="MuiBox-root ${CLASS}">[^<]*</span><span class="ViewBand-action `
    )
  );
const actionClass = (cell: string) =>
  styled(
    cell,
    new RegExp(`<span class="ViewBand-action MuiBox-root ${CLASS}"`)
  );

// The declarations Emotion wrote for a class: its own rule, or the one with
// the suffix given, ":hover", " .ViewBand-clear".
function declarations(
  css: string,
  className: string,
  suffix = ""
): string | undefined {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${className}${escaped}\\{([^}]*)\\}`).exec(css)?.[1];
}

// The rules inside the blocks of an at-rule, and the styles without them.
function atRule(css: string, condition: string) {
  const escaped = condition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${escaped}\\{((?:[^{}]*\\{[^{}]*\\})*)\\}`, "g");
  return {
    inside: Array.from(css.matchAll(block), (match) => match[1]).join(""),
    outside: css.replace(block, ""),
  };
}

describe("ViewBand", () => {
  test("holds its place with six cells until the options arrive", () => {
    const { html, cells } = rendered({
      views: undefined,
      summary: undefined,
      figuresLoading: true,
      options: undefined,
    });
    // Nothing to press and nothing to read out: in each cell the places of
    // its name, its figure and its caption.
    expect(cells).toHaveLength(0);
    expect(html).toMatch(/^<div class="[^"]*" aria-hidden="true">/);
    expect(html).not.toContain('role="group"');
    expect(html.match(/<span class="MuiSkeleton-root/g)).toHaveLength(18);
  });

  test("is not there for options that offer no views", () => {
    expect(rendered({ views: [] }).html).toBe("");
  });

  test("sets each view as one button: its name, its figure, its caption and what a click does", () => {
    const { html, cells } = rendered();
    expect(html).toMatch(
      /^<div class="[^"]*" role="group" aria-label="Starter queries">/
    );
    expect(cells.map((cell) => attribute(cell, "data-view"))).toEqual(
      options.views.map((each) => each.id)
    );
    expect(cells.map(words)).toEqual([
      "Unhealthy 20 failing or flaky, 3 hours Show",
      "Blocking viable/strict 0 pull and trunk, 12 hours Show",
      "Flaky on main 1,502 passed on retry Show",
      "Flaky on PRs 118 passed on retry Show",
      // The slowest test's name stands for the view's own caption.
      "Slowest 21.6 min test_cudnn_rnn_dropout_states_device Show",
      "Most CI time 1,240 h of tests, all attempts Show",
    ]);
    for (const cell of cells) {
      expect(attribute(cell, "type")).toBe("button");
      // No cell is marked on the page's own defaults.
      expect(attribute(cell, "aria-pressed")).toBe("false");
      // The button drawn in the cell is the cell's own face, not a second
      // control: it is not read out, and the cell's state is the press.
      expect(cell).toMatch(
        /<span class="ViewBand-action MuiBox-root css-[\w-]+" aria-hidden="true">/
      );
      expect(cell.match(/<button\b/g)).toHaveLength(1);
    }
  });

  test("describes each cell by its view and what its figure counts", () => {
    const titles = Object.fromEntries(
      rendered().cells.map((cell) => [
        attribute(cell, "data-view"),
        attribute(cell, "title"),
      ])
    );
    expect(titles.unhealthy).toBe(
      `${
        view("unhealthy").description
      }\n20 rows in the last 3 hours, one per test, environment and test config.`
    );
    expect(titles.slowest).toBe(
      `${
        view("slowest").description
      }\ntest/test_nn.py::TestNN::test_cudnn_rnn_dropout_states_device averaged 21.6 min a passed run in the last 3 hours.`
    );
    expect(titles.most_ci_time).toBe(
      `${
        view("most_ci_time").description
      }\n1,240 h of machine time in the last 3 hours, every attempt counted.`
    );
    // Without its figure, or the options to name the window, by its view.
    for (const props of [{ summary: undefined }, { options: undefined }]) {
      expect(attribute(rendered(props).cells[0], "title")).toBe(
        view("unhealthy").description
      );
    }
  });

  test.each(MODES)(
    "marks the cell of the view the table shows, whole (%s)",
    (mode) => {
      const { theme } = THEMES[mode];
      const { cells, css } = rendered({ activeIds: ["flaky_main"] }, mode);
      expect(
        cells.map((cell) => [
          attribute(cell, "data-view"),
          attribute(cell, "aria-pressed"),
        ])
      ).toEqual(
        options.views.map((each) => [each.id, String(each.id === "flaky_main")])
      );
      const chosen = cells[2];
      const other = cells[0];
      const accent = theme.palette.primary.main;
      const { selectedOpacity, hoverOpacity } = theme.palette.action;

      // A wash of the accent over the whole cell, as strong as the theme
      // makes a selected item, and an accent rule along its foot.
      const cell = declarations(css, cellClass(chosen));
      expect(cell).toContain(
        `background-color:${alpha(accent, selectedOpacity)};box-shadow:`
      );
      expect(cell).toContain(`,inset 0 -2px 0 ${accent};`);
      expect(declarations(css, cellClass(chosen), ":hover")).toBe(
        `background-color:${alpha(accent, selectedOpacity + hoverOpacity)};`
      );
      const plain = declarations(css, cellClass(other));
      expect(plain).toContain("background-color:transparent;box-shadow:");
      expect(plain).not.toContain("inset");
      expect(declarations(css, cellClass(other), ":hover")).toBe(
        `background-color:${theme.palette.action.hover};`
      );

      // Its name in the accent, the others' in the secondary text color.
      expect(declarations(css, labelClass(chosen))).toContain(
        `color:${accentTextColor(theme)};`
      );
      expect(declarations(css, labelClass(other))).toContain(
        `color:${theme.palette.text.secondary};`
      );

      // Its button filled, with both its faces; the others' an outline.
      expect(words(chosen)).toBe(
        "Flaky on main 1,502 passed on retry Showing Clear"
      );
      const action = declarations(css, actionClass(chosen));
      expect(action).toContain(`border:1px solid ${accent};`);
      expect(action).toContain(
        `background-color:${accentFillColor(theme)};color:${
          theme.palette.common.white
        };`
      );
      expect(declarations(css, actionClass(other))).toContain(
        `background-color:${theme.palette.background.default};color:${theme.palette.text.primary};`
      );
    }
  );

  test("marks no cell, or several, as the page says", () => {
    const pressed = (activeIds: string[]) =>
      rendered({ activeIds })
        .cells.filter((cell) => attribute(cell, "aria-pressed") === "true")
        .map((cell) => attribute(cell, "data-view"));
    expect(pressed([])).toEqual([]);
    expect(pressed(["slowest"])).toEqual(["slowest"]);
    expect(pressed(["unhealthy", "most_ci_time"])).toEqual([
      "unhealthy",
      "most_ci_time",
    ]);
    // A view the options no longer offer marks nothing.
    expect(pressed(["least_healthy"])).toEqual([]);
  });

  test("gives Showing up for Clear under the pointer and the keyboard's focus", () => {
    const { cells, css } = rendered({ activeIds: ["flaky_main"] });
    const chosen = cells[2];
    // A cell marked from the start, a page opened on a view's URL, swaps.
    expect(attribute(chosen, "class")?.split(" ")).toContain("ViewBand-swaps");
    expect(attribute(cells[0], "class")?.split(" ")).not.toContain(
      "ViewBand-swaps"
    );
    const name = cellClass(chosen);
    // Clear is out of sight until it takes Showing's place.
    expect(declarations(css, name, " .ViewBand-clear")).toBe(
      "visibility:hidden;"
    );
    for (const state of [":hover", ".Mui-focusVisible"]) {
      const swapping = `.ViewBand-swaps${state}`;
      expect(declarations(css, name, `${swapping} .ViewBand-showing`)).toBe(
        "visibility:hidden;"
      );
      expect(declarations(css, name, `${swapping} .ViewBand-clear`)).toBe(
        "visibility:visible;"
      );
      // Never without the class: straight after the click that chose the
      // view, the button still says what happened.
      expect(
        declarations(css, name, `${state} .ViewBand-showing`)
      ).toBeUndefined();
    }
  });

  test.each(MODES)(
    "marks the defaults' cell when the page opens, with nothing to clear (%s)",
    (mode) => {
      const { theme } = THEMES[mode];
      const { cells, css } = rendered({ activeIds: [HOME] }, mode);
      const home = cells[0];
      expect(attribute(home, "data-view")).toBe("unhealthy");
      expect(attribute(home, "aria-pressed")).toBe("true");
      // Marked whole, as any shown view is.
      const accent = theme.palette.primary.main;
      const wash = alpha(accent, theme.palette.action.selectedOpacity);
      const name = cellClass(home);
      expect(declarations(css, name)).toContain(
        `background-color:${wash};box-shadow:`
      );
      expect(declarations(css, name)).toContain(`,inset 0 -2px 0 ${accent};`);
      expect(declarations(css, labelClass(home))).toContain(
        `color:${accentTextColor(theme)};`
      );
      // It says Showing and goes on saying it: clearing the defaults would
      // lead to the defaults, so the cell offers no Clear, does not answer
      // the pointer, and does not look pressable.
      expect(attribute(home, "class")?.split(" ")).not.toContain(
        "ViewBand-swaps"
      );
      expect(words(home)).toBe(
        "Unhealthy 20 failing or flaky, 3 hours Showing"
      );
      expect(home).not.toContain("ViewBand-clear");
      expect(declarations(css, name)).toContain("cursor:default;");
      expect(declarations(css, name, ":hover")).toBe(
        `background-color:${wash};`
      );
      expect(declarations(css, name, ":active")).toBe(
        `background-color:${wash};`
      );
      // An unmarked cell is pressable, and so is a marked one that clears.
      expect(declarations(css, cellClass(cells[1]))).toContain(
        "cursor:pointer;"
      );
      const other = rendered({ activeIds: ["flaky_main"] }, mode);
      expect(declarations(other.css, cellClass(other.cells[2]))).toContain(
        "cursor:pointer;"
      );
    }
  );

  test("answers the pointer only where one can rest on a cell", () => {
    const { cells, css } = rendered({ activeIds: ["flaky_main"] });
    const hover = atRule(css, "@media (hover: hover)");
    // A touch leaves its hover behind until the next: no wash, no Clear.
    expect(hover.outside).not.toContain(":hover");
    for (const cell of cells) {
      expect(hover.inside).toContain(`.${cellClass(cell)}:hover{`);
    }
    expect(hover.inside).toContain(
      `.${cellClass(
        cells[2]
      )}.ViewBand-swaps:hover .ViewBand-clear{visibility:visible;}`
    );
    // The outline of an unchosen cell's button darkens with the cell.
    expect(hover.inside).toContain(
      `.${cellClass(cells[0])}:hover .ViewBand-action{border-color:`
    );
  });

  test("drops the button's word in a cell too narrow for it beside the caption", () => {
    const { cells, css } = rendered({ activeIds: ["flaky_main"] });
    const narrow = atRule(css, "@container (max-width: 249px)");
    for (const cell of [cells[0], cells[2]]) {
      const name = actionClass(cell);
      // A square of the button's height, its icon alone.
      expect(narrow.inside).toContain(
        `.${name}{width:24px;padding:0px;justify-items:center;}`
      );
      expect(narrow.inside).toContain(`.${name} .ViewBand-word{display:none;}`);
      expect(declarations(css, name)).toContain("height:24px;");
    }
    // The cell is the container the rule measures.
    expect(declarations(css, cellClass(cells[0]))).toContain(
      "container-type:inline-size;"
    );
    // Every word a narrow cell leaves out is marked as one.
    expect(
      words(cells[0].replace(/<span class="ViewBand-word">[^<]*/g, ""))
    ).toBe("Unhealthy 20 failing or flaky, 3 hours");
    expect(
      words(cells[2].replace(/<span class="ViewBand-word">[^<]*/g, ""))
    ).toBe("Flaky on main 1,502 passed on retry");
  });

  test("holds each figure's place while the figures load", () => {
    const { cells } = rendered({ summary: undefined, figuresLoading: true });
    expect(cells.map(words)).toEqual([
      "Unhealthy failing or flaky, 3 hours Show",
      "Blocking viable/strict pull and trunk, 12 hours Show",
      "Flaky on main passed on retry Show",
      "Flaky on PRs passed on retry Show",
      "Slowest mean passed duration Show",
      "Most CI time of tests, all attempts Show",
    ]);
    for (const cell of cells) {
      expect(cell.match(/<span class="MuiSkeleton-root/g)).toHaveLength(1);
      // A cell works before its figure arrives.
      expect(cell).not.toContain("disabled");
    }
  });

  test("sets a dash where there is no figure, and says nothing of it", () => {
    // The summary failed.
    const failed = rendered({ summary: undefined, figuresLoading: false });
    for (const cell of failed.cells) {
      expect(cell).toContain('<span aria-hidden="true">—</span>');
      expect(cell).not.toContain("MuiSkeleton-root");
    }
    expect(words(failed.cells[0])).toBe(
      "Unhealthy — failing or flaky, 3 hours Show"
    );

    // Nothing passed, so no test is slowest; and a view the summary does
    // not answer.
    const partial = rendered({
      summary: {
        ...SUMMARY,
        views: [
          figure("unhealthy", { count: 20 }),
          figure("slowest", { kind: "slowest" }),
        ],
      },
    });
    expect(partial.cells.map(words)).toEqual([
      "Unhealthy 20 failing or flaky, 3 hours Show",
      "Blocking viable/strict — pull and trunk, 12 hours Show",
      "Flaky on main — passed on retry Show",
      "Flaky on PRs — passed on retry Show",
      "Slowest — mean passed duration Show",
      "Most CI time — of tests, all attempts Show",
    ]);
    expect(attribute(partial.cells[4], "title")).toBe(
      `${view("slowest").description}\nNo test passed in the last 3 hours.`
    );
  });

  test.each(MODES)(
    "gives a cell a dot for each status it is about, in the status's color, and grey for a count of none (%s)",
    (mode) => {
      const { theme } = THEMES[mode];
      const { cells, css } = rendered({}, mode);
      const [unhealthy, blocking, flaky, , slowest, total] = cells;
      // The colors of a cell's dots, in order.
      const dots = (cell: string) =>
        dotClasses(cell).map(
          (name) =>
            /background-color:([^;]*);/.exec(declarations(css, name) ?? "")?.[1]
        );
      const red = solidHueColor(theme, "red");
      const yellow = solidHueColor(theme, "yellow");
      // The first cell counts the failing and the flaky: a dot for each.
      expect(dots(unhealthy)).toEqual([red, yellow]);
      expect(dots(flaky)).toEqual([yellow]);
      // None failing in pull and trunk: grey, the dot and the figure.
      expect(dots(blocking)).toEqual([theme.palette.text.disabled]);
      expect(declarations(css, figureClass(blocking))).toContain(
        `color:${theme.palette.text.disabled};`
      );
      expect(declarations(css, figureClass(unhealthy))).toContain(
        "color:inherit;"
      );
      // A view of every status has no dot.
      for (const cell of [slowest, total]) {
        expect(dots(cell)).toEqual([]);
      }
      // The dots are for the eye: the cell's name and caption say the same.
      expect(unhealthy).toMatch(
        /<span class="MuiBox-root css-[\w-]+" aria-hidden="true"><span class="MuiBox-root css-[\w-]+"><\/span><span class="MuiBox-root css-[\w-]+"><\/span><\/span>/
      );
    }
  );

  test("greys every dot of a cell that counts none", () => {
    const { cells, css } = rendered({
      summary: {
        ...SUMMARY,
        views: SUMMARY.views.map((each) =>
          each.id === HOME ? { ...each, count: 0 } : each
        ),
      },
    });
    const grey = THEMES.light.theme.palette.text.disabled;
    expect(
      dotClasses(cells[0]).map(
        (name) =>
          /background-color:([^;]*);/.exec(declarations(css, name) ?? "")?.[1]
      )
    ).toEqual([grey, grey]);
  });

  test("sets a cell on two lines: its name, then its figure with the caption beside it, and the button beside both", () => {
    const { cells, css } = rendered({ activeIds: ["flaky_main"] });
    for (const cell of cells) {
      // Two lines of fixed height, so a cell is as tall before its figure
      // arrives as after, whatever the figure is.
      expect(declarations(css, cellClass(cell))).toContain(
        "grid-template-columns:auto minmax(0, 1fr) auto;grid-template-rows:18px 26px;"
      );
      expect(declarations(css, cellClass(cell))).toContain(
        "padding:9px 12px 8px 14px;"
      );
      expect(declarations(css, labelClass(cell))).toContain(
        "grid-column:1/3;grid-row:1;"
      );
      expect(declarations(css, figureClass(cell))).toContain(
        "grid-column:1;grid-row:2;"
      );
      // The caption takes what the figure and the button leave of the line,
      // and ends in an ellipsis when that is too little.
      const caption = declarations(css, captionClass(cell));
      expect(caption).toContain("grid-column:2;grid-row:2;min-width:0;");
      expect(caption).toContain(
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
      );
      // The button, chosen or not, is centered on the two lines.
      const action = declarations(css, actionClass(cell));
      expect(action).toContain("grid-column:3;grid-row:1/3;");
      expect(action).toContain("align-self:center;");
    }
    // The figure and its caption stand on one baseline.
    expect(declarations(css, cellClass(cells[0]))).toContain(
      "align-items:baseline;"
    );
  });

  test("keeps every cell as tall with a unit beside its figure as without", () => {
    const { cells, css } = rendered();
    for (const cell of cells) {
      expect(declarations(css, figureClass(cell))).toContain(
        "height:26px;font-size:19px;font-weight:700;line-height:26px;"
      );
    }
    // The unit is its own word after a space, so "21.6 min" is read as two.
    expect(cells[4]).toMatch(/>21\.6<span class="[^"]*"> min<\/span>/);
    expect(cells[5]).toMatch(/>1,240<span class="[^"]*"> h<\/span>/);
  });
});

describe("choosing and clearing a view", () => {
  let renderer: ReactTestRenderer | undefined;
  const onChoose = jest.fn();
  const onClear = jest.fn();

  beforeEach(() => {
    // The tooltip around each cell waits on timers when the pointer leaves.
    jest.useFakeTimers();
    onChoose.mockClear();
    onClear.mockClear();
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    jest.useRealTimers();
  });

  // The band on a page that marks what was chosen, as the tests page does
  // once the URL has changed: it opens on the defaults, the first view, and
  // clearing a view leads back to them. In MUI's default theme, with no
  // provider: the provider reaches for a document, which this environment
  // has none of.
  function Page({ initial }: { initial: string[] }) {
    const [active, setActive] = useState(initial);
    return band({
      activeIds: active,
      onChoose: (chosen) => {
        onChoose(chosen);
        setActive([chosen.id]);
      },
      onClear: (cleared) => {
        onClear(cleared);
        setActive([HOME]);
      },
    });
  }

  function mount(initial: string[] = [HOME]) {
    act(() => {
      renderer = create(<Page initial={initial} />);
    });
    const cell = (id: string) => {
      const found = renderer!.root
        .findAllByType(ButtonBase)
        .find((node) => node.props["data-view"] === id);
      if (found === undefined) throw new Error(`No cell ${id}`);
      return found;
    };
    // An event as far as the handlers on the way read one.
    const event = () => ({
      target: { matches: () => false },
      currentTarget: { matches: () => false },
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    const fire = (id: string, handler: "onClick" | "onMouseLeave" | "onBlur") =>
      act(() => {
        cell(id).props[handler](event());
        jest.runOnlyPendingTimers();
      });
    return {
      click: (id: string) => fire(id, "onClick"),
      leave: (id: string) => fire(id, "onMouseLeave"),
      blur: (id: string) => fire(id, "onBlur"),
      pressed: (id: string) => cell(id).props["aria-pressed"] as boolean,
      // Whether the cell's button gives Showing up for Clear under the
      // pointer or the focus.
      swaps: (id: string) =>
        String(cell(id).props.className ?? "")
          .split(" ")
          .includes("ViewBand-swaps"),
    };
  }

  test("a click on a cell chooses its view, and a click on the marked cell clears it to the defaults", () => {
    const page = mount();
    expect(page.pressed("unhealthy")).toBe(true);
    page.click("flaky_main");
    expect(onChoose.mock.calls).toEqual([[view("flaky_main")]]);
    expect(onClear).not.toHaveBeenCalled();
    expect(page.pressed("flaky_main")).toBe(true);
    expect(page.pressed("unhealthy")).toBe(false);

    page.click("flaky_main");
    expect(onClear.mock.calls).toEqual([[view("flaky_main")]]);
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(page.pressed("flaky_main")).toBe(false);
    // The defaults are a view too: the first cell is marked again.
    expect(page.pressed("unhealthy")).toBe(true);
  });

  test("a click on another cell moves the mark there", () => {
    const page = mount(["flaky_main"]);
    page.click("slowest");
    expect(onChoose.mock.calls).toEqual([[view("slowest")]]);
    expect(onClear).not.toHaveBeenCalled();
    expect(page.pressed("flaky_main")).toBe(false);
    expect(page.pressed("slowest")).toBe(true);
  });

  test("the defaults' cell, marked when the page opens, ignores a click and never offers Clear", () => {
    const page = mount();
    expect(page.pressed("unhealthy")).toBe(true);
    expect(page.swaps("unhealthy")).toBe(false);
    page.click("unhealthy");
    page.leave("unhealthy");
    page.blur("unhealthy");
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(page.pressed("unhealthy")).toBe(true);
    expect(page.swaps("unhealthy")).toBe(false);
  });

  test("the defaults' cell is the way back from another view", () => {
    const page = mount(["slowest"]);
    expect(page.pressed("unhealthy")).toBe(false);
    page.click("unhealthy");
    expect(onChoose.mock.calls).toEqual([[view("unhealthy")]]);
    expect(onClear).not.toHaveBeenCalled();
    expect(page.pressed("unhealthy")).toBe(true);
    expect(page.pressed("slowest")).toBe(false);
    // Chosen or found marked, it has nothing to clear.
    page.leave("unhealthy");
    expect(page.swaps("unhealthy")).toBe(false);
  });

  test.each([["leave"], ["blur"]] as const)(
    "the chosen cell's button says Showing until the pointer or the focus has left the cell (%s)",
    (away) => {
      const page = mount();
      page.click("flaky_pull_requests");
      // The pointer is still on the cell it clicked: Clear there would read
      // as if the click had done nothing.
      expect(page.pressed("flaky_pull_requests")).toBe(true);
      expect(page.swaps("flaky_pull_requests")).toBe(false);

      page[away]("flaky_pull_requests");
      expect(page.swaps("flaky_pull_requests")).toBe(true);
      // Coming back, the next click clears.
      page.click("flaky_pull_requests");
      expect(onClear.mock.calls).toEqual([[view("flaky_pull_requests")]]);
      expect(page.swaps("flaky_pull_requests")).toBe(false);
    }
  );

  test("a cell marked when the page opens on its view offers Clear at once, and an unmarked one never does", () => {
    const page = mount(["most_ci_time"]);
    expect(page.swaps("most_ci_time")).toBe(true);
    expect(page.swaps("slowest")).toBe(false);
    // Leaving a cell that was not chosen changes nothing.
    page.leave("slowest");
    expect(page.swaps("slowest")).toBe(false);
  });

  test("choosing another view from a fresh one leaves the first unmarked and the second fresh", () => {
    const page = mount();
    page.click("flaky_main");
    page.click("slowest");
    expect(page.pressed("flaky_main")).toBe(false);
    expect(page.swaps("flaky_main")).toBe(false);
    expect(page.swaps("slowest")).toBe(false);
    page.leave("slowest");
    expect(page.swaps("slowest")).toBe(true);
  });
});

// The marking's colors against what is behind them. Small text needs 4.5:1
// (WCAG 2.1, 1.4.3); the edge of a control, 3:1 (1.4.11).
describe("the marked cell's colors", () => {
  // A translucent color as it shows over an opaque one.
  function over(top: string, bottom: string): string {
    const [red, green, blue, opacity = 1] = decomposeColor(top).values;
    const under = decomposeColor(bottom).values;
    const mixed = [red, green, blue].map((value, index) =>
      Math.round(value * opacity + under[index] * (1 - opacity))
    );
    return `rgb(${mixed.join(", ")})`;
  }
  // The backgrounds a cell's words can sit on: the page, the chosen cell's
  // wash, and the wash under the pointer.
  function grounds(theme: Theme, page: string) {
    const accent = theme.palette.primary.main;
    const { selectedOpacity, hoverOpacity } = theme.palette.action;
    return {
      page,
      wash: over(alpha(accent, selectedOpacity), page),
      washHover: over(alpha(accent, selectedOpacity + hoverOpacity), page),
    };
  }

  test.each(MODES)(
    "the accent as text reads on the page and on the wash (%s)",
    (mode) => {
      const { theme, page } = THEMES[mode];
      const text = accentTextColor(theme);
      const { wash, washHover } = grounds(theme, page);
      expect(getContrastRatio(text, page)).toBeGreaterThanOrEqual(5.1);
      expect(getContrastRatio(text, wash)).toBeGreaterThanOrEqual(5.1);
      expect(getContrastRatio(text, washHover)).toBeGreaterThanOrEqual(4.6);
      // The accent itself would not, which is why the text is a step off it.
      expect(getContrastRatio(theme.palette.primary.main, wash)).toBeLessThan(
        4.5
      );
    }
  );

  test("the accent itself reads at 4.6:1 on the light page, 4.2:1 and 4.1:1 on the washes", () => {
    const ratio = (mode: Mode, ground: "page" | "wash") => {
      const { theme, page } = THEMES[mode];
      return getContrastRatio(
        theme.palette.primary.main,
        grounds(theme, page)[ground]
      ).toFixed(1);
    };
    expect(ratio("light", "page")).toBe("4.6");
    expect(ratio("light", "wash")).toBe("4.2");
    expect(ratio("dark", "wash")).toBe("4.1");
  });

  test.each(MODES)("white reads on the Showing button's fill (%s)", (mode) => {
    const { theme } = THEMES[mode];
    const white = theme.palette.common.white;
    expect(
      getContrastRatio(white, accentFillColor(theme))
    ).toBeGreaterThanOrEqual(4.6);
  });

  test("white on the accent itself would fall short in dark mode, at 3.3:1", () => {
    const { theme } = THEMES.dark;
    expect(
      getContrastRatio(
        theme.palette.common.white,
        theme.palette.primary.main
      ).toFixed(1)
    ).toBe("3.3");
    expect(accentFillColor(theme)).toBe(theme.palette.primary.dark);
    // In light mode the accent is the fill.
    expect(accentFillColor(THEMES.light.theme)).toBe(
      THEMES.light.theme.palette.primary.main
    );
  });

  test.each(MODES)(
    "the caption and the figure read on the wash (%s)",
    (mode) => {
      const { theme, page } = THEMES[mode];
      for (const ground of Object.values(grounds(theme, page))) {
        for (const text of [
          theme.palette.text.primary,
          theme.palette.text.secondary,
        ]) {
          // The light theme's text colors are translucent black.
          expect(
            getContrastRatio(over(text, ground), ground)
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  );

  test.each(MODES)(
    "the Showing button and the foot rule stand off the wash (%s)",
    (mode) => {
      const { theme, page } = THEMES[mode];
      const accent = theme.palette.primary.main;
      const { wash, washHover } = grounds(theme, page);
      // The button's edge and the rule along the cell's foot are the accent.
      expect(getContrastRatio(accent, wash)).toBeGreaterThanOrEqual(3);
      expect(getContrastRatio(accent, washHover)).toBeGreaterThanOrEqual(3);
    }
  );
});
