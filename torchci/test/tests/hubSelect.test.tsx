// One of a page's choices in the hub's row: a named key that says its
// choice and opens a menu of one list. How it is drawn, in both themes; what
// its menu holds and what a click on an item does, for one choice and for
// several; which item the keyboard starts on; and the placeholder that holds
// its place.

import {
  ButtonBase,
  createTheme,
  ListItemText,
  MenuItem,
  ThemeProvider,
} from "@mui/material";
import HubSelect, {
  HUB_SELECT_HEIGHT,
  HubSelectProps,
  HubSelectSkeleton,
} from "components/tests/HubSelect";
import { headerRuleColor } from "lib/tests/headerColors";
import { ReactElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  create,
  ReactTestInstance,
  ReactTestRenderer,
} from "react-test-renderer";

// The menu without its popover, which is placed in a document this
// environment has none of: while it is open, its items in MUI's own menu
// list, which still picks the item the keyboard starts on.
jest.mock("@mui/material", () => {
  const React = jest.requireActual("react");
  const actual = jest.requireActual("@mui/material");
  return {
    ...actual,
    Menu: function Menu({
      open,
      children,
      slotProps,
      ...popover
    }: Record<string, any>) {
      return open
        ? React.createElement(
            "menu-popover",
            popover,
            React.createElement(
              actual.MenuList,
              {
                autoFocusItem: true,
                variant: "selectedMenu",
                ...slotProps.list,
              },
              children
            )
          )
        : null;
    },
  };
});

const WINDOWS = [
  { value: "3h", label: "3 hours" },
  { value: "12h", label: "12 hours" },
  { value: "1d", label: "1 day" },
] as const;
type Window = (typeof WINDOWS)[number]["value"];

const LANGUAGES = [
  { value: "python", label: "Python" },
  { value: "cpp", label: "C++" },
  { value: "unknown", label: "Unknown" },
] as const;
type Language = (typeof LANGUAGES)[number]["value"];

const MODES = ["light", "dark"] as const;
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

function rendered(element: ReactElement, mode: "light" | "dark" = "light") {
  const markup = renderToStaticMarkup(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      {element}
    </ThemeProvider>
  );
  return {
    html: markup.replace(STYLE, ""),
    css: Array.from(markup.matchAll(STYLE), (match) => match[1]).join("\n"),
  };
}

// The declarations Emotion wrote for the class of the first tag the pattern
// finds: its own rule, or the one with the suffix given, ":hover".
function declarations(
  css: string,
  html: string,
  tag: RegExp,
  suffix = ""
): string {
  const className = /css-[\w-]+/.exec(tag.exec(html)?.[0] ?? "")?.[0];
  if (className === undefined) throw new Error(`No ${tag} in ${html}`);
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`\\.${className}${escaped}\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`No rule ${suffix} for ${className}`);
  return rule[1];
}

const noop = () => {};

describe("HubSelect, as it is drawn", () => {
  const select = (
    <HubSelect
      label="Window"
      display="12 hours"
      options={WINDOWS}
      value="12h"
      onChange={noop}
    />
  );

  test("says what it chooses and the choice, in one button that opens a menu", () => {
    const { html } = rendered(select);
    expect(html.match(/<button\b/g)).toHaveLength(1);
    expect(html).toMatch(
      /^<button class="[^"]*" tabindex="0" type="button" aria-haspopup="menu" aria-expanded="false">/
    );
    // Its name is its words, the two apart: no label of its own replaces
    // what a reader sees, and the chevron is for the eye.
    expect(html).not.toContain("aria-label");
    expect(html).toMatch(
      />Window<\/span> <span class="[^"]*">12 hours<\/span>/
    );
    const icons = html.match(/<svg\b[^>]*>/g) ?? [];
    expect(icons).toHaveLength(1);
    expect(icons[0]).toContain('aria-hidden="true"');
    // Closed, it has no menu on the page to point at.
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain("menu-popover");
  });

  test.each(MODES)(
    "is a key on the page's background with a ruled edge, its name muted and its choice not (%s)",
    (mode) => {
      const theme = createTheme({ palette: { mode } });
      const { html, css } = rendered(select, mode);
      const key = declarations(css, html, /^<button\b[^>]*>/);
      expect(key).toContain(`height:${HUB_SELECT_HEIGHT}px;`);
      expect(key).toContain(
        `border:1px solid ${headerRuleColor(theme)};background-color:${
          theme.palette.background.default
        };color:${theme.palette.text.primary};`
      );
      expect(key).toContain("white-space:nowrap;");
      expect(declarations(css, html, /<span class="[^"]*">Window</)).toBe(
        `color:${theme.palette.text.secondary};`
      );
      expect(declarations(css, html, /<span class="[^"]*">12 hours</)).toBe(
        "font-weight:500;"
      );
      // The edge answers the pointer, and the keyboard's focus is ringed.
      expect(declarations(css, html, /^<button\b[^>]*>/, ":hover")).toBe(
        `border-color:${theme.palette.text.secondary};`
      );
      expect(
        declarations(css, html, /^<button\b[^>]*>/, ".Mui-focusVisible")
      ).toBe(
        `outline:2px solid ${theme.palette.primary.main};outline-offset:2px;`
      );
    }
  );

  test("holds its place, at the width given, until its choices arrive", () => {
    const { html } = rendered(<HubSelectSkeleton width={154} />);
    expect(html).toMatch(/^<span class="MuiSkeleton-root [^"]*"/);
    expect(html).toContain(`style="width:154px;height:${HUB_SELECT_HEIGHT}px"`);
    expect(html).not.toContain("<button");
  });
});

describe("HubSelect, opened", () => {
  let renderer: ReactTestRenderer | undefined;
  // MUI reports an item it was to focus and could not: here an item has no
  // element, since Emotion hands on no ref where there is no document. Which
  // item was handed the focus is read off the items instead, and every
  // other error still shows.
  const report = console.error;
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).startsWith("MUI: Unable to set focus to a Menu")) {
        report(...args);
      }
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    jest.restoreAllMocks();
  });

  // Mounted in MUI's default theme, with no provider: the provider reaches
  // for a document.
  function mount(element: ReactElement) {
    act(() => {
      renderer = create(element);
    });
    const root = () => renderer!.root;
    const key = () =>
      root().find(
        (node) =>
          node.type === ButtonBase && node.props["aria-haspopup"] === "menu"
      );
    const items = () => root().findAllByType(MenuItem);
    const text = (item: ReactTestInstance) =>
      item.findByType(ListItemText).props.primary as string;
    const item = (label: string) => {
      const found = items().find((each) => text(each) === label);
      if (found === undefined) throw new Error(`No item ${label}`);
      return found;
    };
    return {
      key,
      open: () => act(() => key().props.onClick({ currentTarget: {} })),
      isOpen: () => root().findAllByType("menu-popover" as any).length === 1,
      popover: () => root().findByType("menu-popover" as any),
      list: () => root().findByType("ul" as any),
      // Each item as the menu shows it: its words, its role, and whether it
      // is marked and can be pressed.
      items: () =>
        items().map((each) => [
          text(each),
          each.props.role,
          each.props["aria-checked"],
          each.props.disabled === true ? "kept" : "free",
        ]),
      // The item the keyboard starts on.
      focused: () =>
        items()
          .filter((each) => each.props.autoFocus === true)
          .map(text),
      press: (label: string) => act(() => item(label).props.onClick()),
    };
  }

  // A page that keeps what the control hands back, as the tests page does
  // through its URL.
  function Several({
    initial,
    onChange,
    ...rest
  }: {
    initial: Language[];
    onChange: (_value: Language[]) => void;
    required?: boolean;
    hint?: string;
  }) {
    const [value, setValue] = useState(initial);
    return (
      <HubSelect
        multiple
        label="Language"
        display={value.join(" ")}
        options={LANGUAGES}
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        {...rest}
      />
    );
  }

  function single(props: Partial<HubSelectProps<Window>> = {}) {
    const onChange = jest.fn();
    const menu = mount(
      <HubSelect
        label="Window"
        display="12 hours"
        options={WINDOWS}
        value="12h"
        onChange={onChange}
        {...(props as object)}
      />
    );
    return { menu, onChange };
  }

  test("opens a menu of its options with the chosen one marked, and points at it", () => {
    const { menu } = single();
    expect(menu.isOpen()).toBe(false);
    expect(menu.key().props["aria-expanded"]).toBe(false);
    expect(menu.key().props["aria-controls"]).toBeUndefined();

    menu.open();
    expect(menu.isOpen()).toBe(true);
    expect(menu.key().props["aria-expanded"]).toBe(true);
    expect(menu.key().props["aria-controls"]).toBe(menu.popover().props.id);
    expect(menu.items()).toEqual([
      ["3 hours", "menuitemradio", false, "free"],
      ["12 hours", "menuitemradio", true, "free"],
      ["1 day", "menuitemradio", false, "free"],
    ]);
    // The keyboard starts on the choice in force.
    expect(menu.focused()).toEqual(["12 hours"]);
  });

  test("a choice of one is handed back and closes the menu", () => {
    const { menu, onChange } = single();
    menu.open();
    menu.press("1 day");
    expect(onChange.mock.calls).toEqual([["1d"]]);
    expect(menu.isOpen()).toBe(false);
    expect(menu.key().props["aria-expanded"]).toBe(false);
  });

  test("hangs its menu from its right edge, which stays put while a choice changes its width", () => {
    const { menu } = single();
    menu.open();
    expect(menu.popover().props.anchorOrigin).toEqual({
      vertical: "bottom",
      horizontal: "right",
    });
    expect(menu.popover().props.transformOrigin).toEqual({
      vertical: "top",
      horizontal: "right",
    });
  });

  test("a choice of several stays open and is handed back in the menu's order", () => {
    const onChange = jest.fn();
    const menu = mount(<Several initial={["unknown"]} onChange={onChange} />);
    menu.open();
    expect(menu.items()).toEqual([
      ["Python", "menuitemcheckbox", false, "free"],
      ["C++", "menuitemcheckbox", false, "free"],
      ["Unknown", "menuitemcheckbox", true, "free"],
    ]);
    // The keyboard starts on the first item: none is the one in force.
    expect(menu.focused()).toEqual(["Python"]);

    menu.press("C++");
    menu.press("Python");
    menu.press("Unknown");
    expect(onChange.mock.calls).toEqual([
      [["cpp", "unknown"]],
      // As the menu lists them, not as they were ticked.
      [["python", "cpp", "unknown"]],
      [["python", "cpp"]],
    ]);
    expect(menu.isOpen()).toBe(true);

    // Nothing has to stay chosen unless the page says so.
    menu.press("Python");
    menu.press("C++");
    expect(onChange.mock.calls.at(-1)).toEqual([[]]);
    expect(menu.items().map(([, , checked]) => checked)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("keeps the last one chosen where one is required, and starts the keyboard past it", () => {
    const onChange = jest.fn();
    const menu = mount(
      <Several
        required
        hint="One or more"
        initial={["python"]}
        onChange={onChange}
      />
    );
    menu.open();
    expect(menu.items()).toEqual([
      ["Python", "menuitemcheckbox", true, "kept"],
      ["C++", "menuitemcheckbox", false, "free"],
      ["Unknown", "menuitemcheckbox", false, "free"],
    ]);
    // Not on the hint, which is no item, nor on the item that cannot be
    // pressed.
    expect(menu.focused()).toEqual(["C++"]);

    // With a second one chosen either can go.
    menu.press("C++");
    expect(onChange.mock.calls).toEqual([[["python", "cpp"]]]);
    expect(menu.items().map(([, , , state]) => state)).toEqual([
      "free",
      "free",
      "free",
    ]);
    // The first item can be pressed again, and the list would start on it
    // now; the focus stays on the item just pressed.
    expect(menu.focused()).toEqual(["C++"]);

    menu.press("Python");
    expect(onChange.mock.calls.at(-1)).toEqual([["cpp"]]);
    expect(menu.items().map(([, , , state]) => state)).toEqual([
      "free",
      "kept",
      "free",
    ]);
  });

  test("says how its choices combine in a line the menu is described by, which is no item", () => {
    const menu = mount(
      <Several initial={[]} hint="None chosen means all" onChange={noop} />
    );
    menu.open();
    const hint = menu
      .list()
      .findAll(
        (node) => node.type === "li" && node.props.role === "presentation"
      );
    expect(hint).toHaveLength(1);
    expect(hint[0].props.children).toBe("None chosen means all");
    expect(menu.list().props["aria-describedby"]).toBe(hint[0].props.id);
    // The menu's items are its options and nothing else.
    expect(menu.items()).toHaveLength(LANGUAGES.length);
    expect(menu.focused()).toEqual(["Python"]);
  });

  test("has no such line, and describes its menu by nothing, without a hint", () => {
    const { menu } = single();
    menu.open();
    expect(
      menu.list().findAll((node) => node.props.role === "presentation")
    ).toHaveLength(0);
    expect(menu.list().props["aria-describedby"]).toBeUndefined();
  });

  test("leaves out of reach an option the page marks so", () => {
    const { menu, onChange } = single({
      options: WINDOWS.map((option) => ({
        ...option,
        disabled: option.value === "3h",
      })),
    });
    menu.open();
    expect(menu.items().map(([, , , state]) => state)).toEqual([
      "kept",
      "free",
      "free",
    ]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
