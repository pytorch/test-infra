// The row at the top of a repository's pages in the hub: a link to each
// page, the page's own marked as the current one, in both themes; inert
// places until the repository is known; the word a page gets before the
// browser follows a tab; and the row as the page's title, with the page's
// heading out of sight, the page's choices at its right end and its
// hairline under the tabs' line.

import { createTheme, ThemeProvider } from "@mui/material";
import HubTabs, { HubTabsProps } from "components/tests/HubTabs";
import { testsPagePath } from "lib/api/tests/pages/parameters";
import { costPagePath } from "lib/tests/cost/query";
import { accentTextColor, headerRuleColor } from "lib/tests/headerColors";
import NextLink from "next/link";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, ReactTestRenderer } from "react-test-renderer";

const REPO = "pytorch/pytorch";
const MODES = ["light", "dark"] as const;
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

function rendered(props: HubTabsProps, mode: "light" | "dark" = "light") {
  const markup = renderToStaticMarkup(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <HubTabs {...props} />
    </ThemeProvider>
  );
  const html = markup.replace(STYLE, "");
  return {
    html,
    // The tabs alone: the repository and the pages.
    nav: /<nav\b[\s\S]*<\/nav>/.exec(html)?.[0] ?? "",
    css: Array.from(markup.matchAll(STYLE), (match) => match[1]).join("\n"),
    // The links, in order: each one's own tag and its words.
    links: Array.from(
      html.matchAll(/(<a\b[^>]*>)([\s\S]*?)<\/a>/g),
      (match) => ({
        tag: match[1],
        words: words(match[2]),
      })
    ),
  };
}

function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

// The declarations Emotion wrote for a tag's class: its own rule, or the one
// with the suffix given, ":hover", "::after".
function declarations(
  css: string,
  tag: string,
  suffix = ""
): string | undefined {
  const className = /css-[\w-]+/.exec(attribute(tag, "class") ?? "")?.[0];
  if (className === undefined) return undefined;
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${className}${escaped}\\{([^}]*)\\}`).exec(css)?.[1];
}

describe("HubTabs", () => {
  test("names the repository and leads to each of its pages", () => {
    const { nav, links } = rendered({ repo: REPO, current: "tests" });
    expect(nav).toMatch(/^<nav class="[^"]*" aria-label="Pages">/);
    expect(words(nav)).toBe("pytorch/pytorch Tests Cost");
    expect(
      links.map((link) => [link.words, attribute(link.tag, "href")])
    ).toEqual([
      // The repository's name is the way to its first page.
      ["pytorch/pytorch", "/tests/pytorch/pytorch"],
      ["Tests", "/tests/pytorch/pytorch"],
      ["Cost", "/tests/pytorch/pytorch/cost"],
    ]);
    // The pages' own paths, with no parameters: each page as a reader
    // arrives on it, the tests page's own tab the way back to its defaults.
    expect(attribute(links[1].tag, "href")).toBe(testsPagePath(REPO));
    expect(attribute(links[2].tag, "href")).toBe(costPagePath(REPO));
  });

  test("leads to another repository's pages on its own", () => {
    const { links } = rendered({ repo: "pytorch/executorch", current: "cost" });
    expect(links.map((link) => attribute(link.tag, "href"))).toEqual([
      "/tests/pytorch/executorch",
      "/tests/pytorch/executorch",
      "/tests/pytorch/executorch/cost",
    ]);
  });

  test.each([
    ["tests", "Tests"],
    ["cost", "Cost"],
  ] as const)(
    "marks the %s page's own tab as the current page",
    (current, label) => {
      const { links } = rendered({ repo: REPO, current });
      expect(
        links
          .filter((link) => attribute(link.tag, "aria-current") !== undefined)
          .map((link) => [link.words, attribute(link.tag, "aria-current")])
      ).toEqual([[label, "page"]]);
    }
  );

  test.each(MODES)(
    "sets the page's own tab in the accent over an accent rule, the others grey until the pointer is on them (%s)",
    (mode) => {
      const theme = createTheme({ palette: { mode } });
      const { css, links } = rendered({ repo: REPO, current: "tests" }, mode);
      const [, own, other] = links.map((link) => link.tag);

      expect(declarations(css, own)).toContain(
        `color:${accentTextColor(theme)};`
      );
      expect(declarations(css, own, "::after")).toContain(
        `background-color:${theme.palette.primary.main};`
      );
      expect(declarations(css, own, "::after")).toContain("transform:none;");
      // The pointer changes nothing on the page's own tab.
      expect(declarations(css, own, ":hover")).toBe(
        `color:${accentTextColor(theme)};`
      );

      expect(declarations(css, other)).toContain(
        `color:${theme.palette.text.secondary};`
      );
      // Its rule is there, grey, drawn out only under the pointer.
      expect(declarations(css, other, "::after")).toContain(
        `background-color:${headerRuleColor(theme)};`
      );
      expect(declarations(css, other, "::after")).toContain(
        "transform:scaleX(0);"
      );
      expect(declarations(css, other, ":hover")).toBe(
        `color:${theme.palette.text.primary};`
      );
      expect(declarations(css, other, ":hover::after")).toContain(
        "transform:none;"
      );
      // The keyboard's focus is ringed in the accent, inside the tab.
      for (const tab of [own, other]) {
        expect(declarations(css, tab, ":focus-visible")).toContain(
          `outline:2px solid ${theme.palette.primary.main};outline-offset:-2px;`
        );
      }
    }
  );

  test("bold on purpose: a tab is larger and heavier than the repository's name", () => {
    const { css, links } = rendered({ repo: REPO, current: "tests" });
    const [repository, own, other] = links.map((link) => link.tag);
    for (const tab of [own, other]) {
      expect(declarations(css, tab)).toContain(
        "font-size:16px;font-weight:500;"
      );
    }
    expect(declarations(css, repository)).toContain("font-size:13.5px;");
    // The rule is three pixels, on the row's hairline.
    expect(declarations(css, own, "::after")).toContain(
      "bottom:-1px;height:3px;"
    );
  });

  test("draws each tab's icon for the eye only", () => {
    const { html } = rendered({ repo: REPO, current: "tests" });
    const icons = html.match(/<svg\b[^>]*>/g) ?? [];
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(attribute(icon, "aria-hidden")).toBe("true");
    }
  });

  test("holds the tabs' places, leading nowhere, until the repository is known", () => {
    const { html, links } = rendered({ repo: undefined, current: "cost" });
    expect(links).toHaveLength(0);
    // The repository's place is held; the tabs already say their pages.
    expect(html.match(/<span class="MuiSkeleton-root/g)).toHaveLength(1);
    expect(words(html)).toBe("Tests Cost");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("aria-current");
  });
});

describe("the row as the page's title", () => {
  const HEADING = /<h1\b[^>]*>([\s\S]*?)<\/h1>/;
  const CHOICES =
    /<div class="[^"]*" role="group" aria-label="Page choices">([\s\S]*?)<\/div>/;
  const choice = <button type="button">Window 12 hours</button>;

  test("gives the page its heading, out of sight, naming the page and the repository", () => {
    const { html, css } = rendered({ repo: REPO, current: "tests" });
    const heading = HEADING.exec(html);
    expect(heading?.[1]).toBe("Tests of pytorch/pytorch");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    // Ahead of the tabs, so it is what a reader of headings meets first.
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<nav"));
    // Clipped to a pixel and taken out of the row's flow, not hidden: what
    // is hidden is not read out either.
    const style = declarations(css, heading![0]);
    expect(style).toContain("position:absolute;width:1px;height:1px;");
    expect(style).toContain(
      "overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;"
    );
    expect(style).not.toContain("display:none");
    expect(style).not.toContain("visibility");
  });

  test("names the page alone until the repository is known", () => {
    const { html } = rendered({ repo: undefined, current: "tests" });
    expect(HEADING.exec(html)?.[1]).toBe("Tests");
  });

  test("leaves the heading to a page that still has a title of its own", () => {
    // The cost page's sentence is its heading until it moves to the row.
    expect(rendered({ repo: REPO, current: "cost" }).html).not.toContain("<h1");
  });

  test("sets the page's choices at the row's right end, after the tabs", () => {
    const { html, nav, css } = rendered({
      repo: REPO,
      current: "tests",
      children: choice,
    });
    const choices = CHOICES.exec(html);
    expect(choices?.[1]).toBe('<button type="button">Window 12 hours</button>');
    // After the tabs and not among them: a choice is no link to a page.
    expect(html.indexOf("</nav>")).toBeLessThan(choices!.index);
    expect(nav).not.toContain("Window");
    // Against the right end, on the tabs' line or on lines of their own.
    const style = declarations(css, choices![0]);
    expect(style).toContain("margin-left:auto;");
    expect(style).toContain(";flex-wrap:wrap;");
    expect(style).toContain(";justify-content:flex-end;");
  });

  test("keeps no place for choices on a page that has none", () => {
    const { html } = rendered({ repo: REPO, current: "tests" });
    expect(html).not.toContain('role="group"');
    expect(html).not.toContain("Page choices");
  });

  test.each(MODES)(
    "keeps its hairline under the tabs' line, with or without choices beside them (%s)",
    (mode) => {
      const theme = createTheme({ palette: { mode } });
      for (const children of [undefined, choice]) {
        const { html, nav, css } = rendered(
          { repo: REPO, current: "tests", children },
          mode
        );
        const row = /^<div\b[^>]*>/.exec(html)![0];
        // The choices drop under the tabs when the row is too narrow for
        // both, so the line is not the row's own edge: it is drawn at the
        // foot of the tabs' line, and ahead of the tabs, so the rule of the
        // page's own tab lies on it.
        expect(declarations(css, row)).toContain("flex-wrap:wrap;");
        expect(declarations(css, row)).not.toContain("border");
        expect(declarations(css, row, "::before")).toContain(
          `left:0;right:0;top:51px;height:1px;background-color:${theme.palette.divider};`
        );
        expect(html.indexOf("<nav")).toBeGreaterThan(0);
        // The tabs' line is as tall as it was, the hairline its last pixel.
        expect(declarations(css, nav)).toContain(
          "height:52px;padding-bottom:1px;"
        );
      }
    }
  );
});

describe("following a tab", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  function mount(props: HubTabsProps) {
    // Next's link schedules its prefetch check through `self`, which the
    // browser has and this environment does not.
    (globalThis as { self?: unknown }).self = globalThis;
    act(() => {
      renderer = create(<HubTabs {...props} />);
    });
    return renderer!.root.findAllByType(NextLink);
  }

  test("tells the page which tab, before the browser follows it", () => {
    const onNavigate = jest.fn();
    const links = mount({ repo: REPO, current: "tests", onNavigate });
    expect(links.map((link) => link.props.href)).toEqual([
      "/tests/pytorch/pytorch",
      "/tests/pytorch/pytorch",
      "/tests/pytorch/pytorch/cost",
    ]);
    for (const link of links) {
      act(() => link.props.onClick());
    }
    // The repository's name is the tests page's; the page's own tab is told
    // of too, since it leads to the page without its parameters.
    expect(onNavigate.mock.calls).toEqual([["tests"], ["tests"], ["cost"]]);
  });

  test("leaves the link to the browser: no page is fetched ahead, and a click is not held up", () => {
    const links = mount({ repo: REPO, current: "cost" });
    for (const link of links) {
      expect(link.props.prefetch).toBe(false);
      // No page has to listen: a click without a listener is a plain link's.
      expect(() => act(() => link.props.onClick())).not.toThrow();
    }
  });
});
