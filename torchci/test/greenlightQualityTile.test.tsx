// Pins QualityTile's chart toggle: the disclosure button a keyboard and a screen
// reader get, the outline states a mouse user sees in both themes, and which
// clicks on the tile toggle its chart.
//
// The click rules are checked with stub events, jsdom not being a dependency
// here. The rule reads nothing of an event but its detail, pointer position,
// target and current target, and is handed the press and the selection. Whole
// gestures run through the tile's own handlers, which @mui/material's Paper is
// wrapped to record, over a stub window whose selection each step sets.

import QualityTile, {
  isToggleClick,
  isToggleDoubleClick,
  TilePress,
} from "components/greenlight/quality/QualityTile";
import { MouseEvent } from "react";
import {
  attribute,
  cssOf,
  renderThemed,
  STYLE_RE,
  tags,
  ThemeMode,
  THEMES,
} from "./greenlightQuality.helpers";

const mockPapers: any[] = [];

jest.mock("@mui/material", () => {
  const actual = jest.requireActual("@mui/material");
  const { createElement } = jest.requireActual("react");
  return {
    ...actual,
    Paper: (props: any) => {
      mockPapers.push(props);
      return createElement(actual.Paper, props);
    },
  };
});

const CONTROLS = "greenlight-quality-chart-verdicts";
const CAVEAT = "Every LAND and NO_LAND row GreenLight emitted.";

function tile(
  mode: ThemeMode,
  toggle: { selected?: boolean; onToggle?: () => void } = {}
): string {
  return renderThemed(
    <QualityTile
      label="Verdicts"
      value="12"
      sub="3 no verdict"
      caveat={CAVEAT}
      controlsId={CONTROLS}
      {...toggle}
    />,
    mode
  );
}

function disclosures(markup: string) {
  return tags(markup).filter(
    (tag) => attribute(tag.attributes, "aria-expanded") !== undefined
  );
}

describe.each(["light", "dark"] as const)(
  "a toggleable tile in %s mode",
  (mode) => {
    const theme = THEMES[mode];

    test.each([
      ["closed", false],
      ["open", true],
    ])(
      "the %s tile is one disclosure button named for its chart",
      (_state, selected) => {
        const markup = tile(mode, { selected, onToggle: () => {} });
        const [button, ...others] = disclosures(markup);
        expect(others).toEqual([]);
        expect(button.name).toBe("button");
        expect(attribute(button.attributes, "type")).toBe("button");
        expect(attribute(button.attributes, "aria-label")).toBe(
          "Verdicts chart"
        );
        expect(attribute(button.attributes, "aria-expanded")).toBe(
          String(selected)
        );
        // A closed chart is unmounted, and aria-controls must name what exists.
        expect(attribute(button.attributes, "aria-controls")).toBe(
          selected ? CONTROLS : undefined
        );
        expect(attribute(button.attributes, "aria-labelledby")).toBeUndefined();
      }
    );

    test("the button covers the tile without catching the pointer or holding the info affordance", () => {
      const markup = tile(mode, { onToggle: () => {} });
      const button = disclosures(markup)[0];
      const css = cssOf(markup, button.attributes);
      expect(css).toMatch(/[{;]position:absolute;/);
      expect(css).toMatch(/[{;]inset:0(px)?;/);
      expect(css).toMatch(/[{;]pointer-events:none;/);
      expect(markup.replace(STYLE_RE, "")).toMatch(
        /aria-expanded="false"[^>]*><\/button>/
      );
      expect(cssOf(markup, tags(markup)[0].attributes)).toMatch(
        /[{;]position:relative;/
      );
      expect(
        tags(markup)
          .filter((tag) => tag.name === "button")
          .map((tag) => attribute(tag.attributes, "aria-label"))
      ).toEqual(["Verdicts chart", `Verdicts: ${CAVEAT}`]);
    });

    // Three states a mouse or keyboard user must tell apart, none of them a fill
    // behind the figures: hovering a closed tile, an open tile, keyboard focus.
    test("a closed tile hovers in a neutral outline, never the open tile's colour", () => {
      const markup = tile(mode, { selected: false, onToggle: () => {} });
      const paperCss = cssOf(markup, tags(markup)[0].attributes);
      expect(paperCss).toContain("outline:1px solid transparent;");
      expect(paperCss).toContain(
        `:hover{outline-color:${theme.palette.text.secondary};}`
      );
      expect(paperCss).not.toContain(theme.palette.primary.main);
      expect(paperCss).not.toMatch(/:hover\{[^}]*background/);
    });

    test("an open tile carries a 2px outline in the primary colour, hovered or not", () => {
      const markup = tile(mode, { selected: true, onToggle: () => {} });
      const paperCss = cssOf(markup, tags(markup)[0].attributes);
      expect(paperCss).toContain(
        `outline:2px solid ${theme.palette.primary.main};`
      );
      expect(paperCss).not.toContain(":hover");
    });

    test("keyboard focus draws a dashed ring set off the tile, unlike the open outline", () => {
      const markup = tile(mode, { selected: true, onToggle: () => {} });
      const button = cssOf(markup, disclosures(markup)[0].attributes);
      expect(button).toContain(
        `.Mui-focusVisible{outline:2px dashed ${theme.palette.text.primary};outline-offset:4px;}`
      );
      expect(button.match(/background-color:[^;]*/g)).toEqual([
        "background-color:transparent",
      ]);
    });

    test("a tile without a chart renders no disclosure and no pointer affordance", () => {
      const markup = tile(mode, { selected: true });
      expect(markup.replace(STYLE_RE, "")).not.toMatch(
        /aria-(expanded|controls|labelledby)=/
      );
      expect(
        tags(markup)
          .filter((tag) => tag.name === "button")
          .map((tag) => attribute(tag.attributes, "aria-label"))
      ).toEqual([`Verdicts: ${CAVEAT}`]);
      expect(cssOf(markup, tags(markup)[0].attributes)).not.toMatch(
        /cursor:pointer|position:relative|outline/
      );
    });
  }
);

test("tiles side by side each name their own chart", () => {
  const markup = renderThemed(
    <>
      <QualityTile label="Verdicts" value="12" onToggle={() => {}} />
      <QualityTile label="PRs evaluated" value="7" onToggle={() => {}} />
    </>,
    "light"
  );
  expect(
    disclosures(markup).map((tag) => attribute(tag.attributes, "aria-label"))
  ).toEqual(["Verdicts chart", "PRs evaluated chart"]);
});

interface Node {
  tag: string;
  parent?: Node;
  contains(_other: Node): boolean;
  closest(_selector: string): Node | null;
}

function node(tag: string, parent?: Node): Node {
  return {
    tag,
    parent,
    contains(other) {
      for (let n: Node | undefined = other; n; n = n.parent) {
        if (n === this) {
          return true;
        }
      }
      return false;
    },
    closest(selector) {
      for (let n: Node | undefined = this; n; n = n.parent) {
        if (n.tag === selector) {
          return n;
        }
      }
      return null;
    },
  };
}

const body = node("body");
const paper = node("div", body);
const figure = node("span", paper);
const infoButton = node("button", paper);
const infoIcon = node("path", node("svg", infoButton));
// An open tooltip renders in a portal under the body, and React still bubbles
// its clicks to the tile.
const tooltipText = node("span", node("div", body));

function event(
  target: Node,
  detail: number,
  x = 10,
  y = 10
): MouseEvent<HTMLElement> {
  return {
    target,
    currentTarget: paper,
    detail,
    clientX: x,
    clientY: y,
  } as unknown as MouseEvent<HTMLElement>;
}

describe("which clicks toggle the chart", () => {
  const still: TilePress = { x: 10, y: 10, selection: "" };

  test.each([
    ["a click on a figure", figure, 1],
    ["a click on the tile's padding", paper, 1],
    ["a keyboard-dispatched click, of detail 0", figure, 0],
  ])("%s toggles", (_case, target, detail) => {
    expect(isToggleClick(event(target, detail), still, "")).toBe(true);
  });

  test.each([
    ["the second click of a double-click", figure, 2],
    ["the third click of a triple-click", figure, 3],
    ["a click on the info button", infoButton, 1],
    ["a click on the icon inside the info button", infoIcon, 1],
    ["a keyboard click on the info button", infoButton, 0],
    ["a click inside the open tooltip", tooltipText, 1],
  ])("%s does not", (_case, target, detail) => {
    expect(isToggleClick(event(target, detail), still, "")).toBe(false);
  });

  test("a press that travelled 5 px is a click, one that travelled 5.01 px a drag", () => {
    expect(isToggleClick(event(figure, 1, 13, 14), still, "")).toBe(true);
    expect(isToggleClick(event(figure, 1, 15.01, 10), still, "")).toBe(false);
  });

  test("a click that leaves the press's selection as it was, or clears it, toggles", () => {
    const onSelected = { ...still, selection: "PRs" };
    expect(isToggleClick(event(figure, 1), onSelected, "PRs")).toBe(true);
    expect(isToggleClick(event(figure, 1), onSelected, "")).toBe(true);
  });

  test("a click that changed a selection does not, however little it moved", () => {
    expect(isToggleClick(event(figure, 1, 12, 12), still, "P")).toBe(false);
    expect(
      isToggleClick(
        event(figure, 1),
        { ...still, selection: "PRs" },
        "PRs evaluated"
      )
    ).toBe(false);
  });

  test("a keyboard click is not judged against the press", () => {
    expect(isToggleClick(event(figure, 0, 400, 300), still, "PRs")).toBe(true);
  });

  test("a click with no press recorded is judged by the selection alone", () => {
    expect(isToggleClick(event(figure, 1, 50, 50), undefined, "")).toBe(true);
    expect(isToggleClick(event(figure, 1, 50, 50), undefined, "x")).toBe(false);
  });

  test.each([
    ["a figure", true, figure],
    ["the tile's padding", true, paper],
    ["the info icon", false, infoIcon],
    ["the open tooltip", false, tooltipText],
  ])("a double-click on %s toggles: %p", (_case, toggles, target) => {
    expect(isToggleDoubleClick(event(target, 2))).toBe(toggles);
  });
});

describe("a gesture's toggles, through the tile's own handlers", () => {
  let selection = "";
  const realWindow = (globalThis as any).window;
  beforeAll(() => {
    (globalThis as any).window = {
      getSelection: () => ({ toString: () => selection }),
    };
  });
  afterAll(() => {
    (globalThis as any).window = realWindow;
  });

  // One rendered tile's handlers, driven step by step; each step sets the
  // selection the page holds when its event fires.
  function gesture() {
    const onToggle = jest.fn();
    mockPapers.length = 0;
    renderThemed(
      <QualityTile label="Verdicts" value="12" onToggle={onToggle} />,
      "light"
    );
    const handlers = mockPapers.find(
      (props) => typeof props.onMouseDown === "function"
    );
    const steps = {
      down(x: number, y: number, selected: string) {
        selection = selected;
        handlers.onMouseDown(event(figure, 1, x, y));
        return steps;
      },
      click(detail: number, x: number, y: number, selected: string) {
        selection = selected;
        handlers.onClick(event(figure, detail, x, y));
        return steps;
      },
      clickOn(target: Node, detail: number) {
        handlers.onClick(event(target, detail));
        return steps;
      },
      dblclick(target: Node = figure) {
        handlers.onDoubleClick(event(target, 2));
        return steps;
      },
      toggles: () => onToggle.mock.calls.length,
    };
    return steps;
  }

  test("a drag that selects text does not toggle", () => {
    expect(
      gesture().down(10, 10, "").click(1, 60, 12, "PRs evaluated").toggles()
    ).toBe(0);
  });

  test("a click on text already selected, leaving it so, toggles", () => {
    expect(
      gesture().down(10, 10, "PRs").click(1, 10, 10, "PRs").toggles()
    ).toBe(1);
  });

  test("a shift+click extending a selection does not toggle", () => {
    expect(
      gesture().down(60, 10, "PRs").click(1, 60, 10, "PRs evaluated").toggles()
    ).toBe(0);
  });

  test("a drag that comes back within 5 px but changed the selection does not toggle", () => {
    expect(gesture().down(10, 10, "").click(1, 13, 14, "P").toggles()).toBe(0);
  });

  test("a keyboard click after a press that never clicked toggles", () => {
    expect(
      gesture().down(10, 10, "").click(0, 400, 300, "PRs evaluated").toggles()
    ).toBe(1);
  });

  test("5 px of travel is a click, 5.01 px a drag", () => {
    expect(gesture().down(10, 10, "").click(1, 13, 14, "").toggles()).toBe(1);
    expect(gesture().down(10, 10, "").click(1, 15.01, 10, "").toggles()).toBe(
      0
    );
  });

  test("a press judges only the click that ends it", () => {
    expect(
      gesture()
        .down(10, 10, "")
        .click(1, 10, 10, "")
        .click(1, 100, 100, "")
        .toggles()
    ).toBe(2);
  });

  // An even count leaves the chart as it was.
  test("a double-click leaves the chart as it was", () => {
    expect(
      gesture()
        .down(10, 10, "")
        .click(1, 10, 10, "")
        .down(10, 10, "")
        .click(2, 10, 10, "PRs")
        .dblclick()
        .toggles()
    ).toBe(2);
  });

  test("a triple-click leaves the chart as it was", () => {
    expect(
      gesture()
        .down(10, 10, "")
        .click(1, 10, 10, "")
        .down(10, 10, "")
        .click(2, 10, 10, "PRs")
        .dblclick()
        .down(10, 10, "PRs")
        .click(3, 10, 10, "PRs evaluated")
        .toggles()
    ).toBe(2);
  });

  test.each([
    ["the info button", infoButton],
    ["the icon inside it", infoIcon],
    ["the open tooltip", tooltipText],
  ])(
    "clicks, keyboard clicks and double-clicks on %s never toggle",
    (_case, target) => {
      expect(
        gesture()
          .down(10, 10, "")
          .clickOn(target, 1)
          .clickOn(target, 0)
          .dblclick(target)
          .toggles()
      ).toBe(0);
    }
  );
});
