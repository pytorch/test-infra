// The commit header's one pill for the pull request and the commit: a pill
// with a chip set inside its end (FactPill's chip), the chip's colors, and
// the header's use of it for a pull request head, a merged commit and a
// commit of no pull request.

import { createTheme, ThemeProvider } from "@mui/material";
import { darken } from "@mui/material/styles";
import CommitHeader from "components/tests/CommitHeader";
import FactPill from "components/tests/FactPill";
import type { CommitRecord } from "lib/api/tests/commit/summary/types";
import { headerBandColor, pillChipColors } from "lib/tests/headerColors";
import { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const REPO = "pytorch/pytorch";
const SHA = "573c889f49603f0bd8d0033ef6a49e3016d863d3";
const PULL = "https://github.com/pytorch/pytorch/pull/204150";
const COMMIT = `https://github.com/pytorch/pytorch/commit/${SHA}`;
const MODES = ["light", "dark"] as const;

const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;

function rendered(element: ReactElement, mode: "light" | "dark" = "light") {
  const markup = renderToStaticMarkup(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      {element}
    </ThemeProvider>
  );
  return {
    // The markup without the styles Emotion writes beside it, and those.
    html: markup.replace(STYLE, ""),
    css: Array.from(markup.matchAll(STYLE), (match) => match[1]).join("\n"),
  };
}

function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Tag {
  name: string;
  attributes: Record<string, string>;
}

// The opening tags of the markup, in order, each with its attributes.
function tags(html: string): Tag[] {
  return Array.from(html.matchAll(/<(\w+)((?:\s[^>]*)?)>/g), (match) => ({
    name: match[1],
    attributes: Object.fromEntries(
      Array.from(match[2].matchAll(/([\w-]+)="([^"]*)"/g), (attribute) => [
        attribute[1],
        attribute[2],
      ])
    ),
  }));
}

// The declarations Emotion wrote for a tag's own class: its base rule, or
// the one with the suffix given, ":hover", "::after".
function rule(css: string, tag: Tag, suffix = ""): string | undefined {
  const className = /css-\w+/.exec(tag.attributes.class ?? "")?.[0];
  if (className === undefined) return undefined;
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${className}${escaped}\\{([^}]*)\\}`).exec(css)?.[1];
}

const chip = {
  href: COMMIT,
  name: "Commit 573c889",
  title: SHA,
  children: "573c889",
};

function twoLinks(mode: "light" | "dark" = "light") {
  const { html, css } = rendered(
    <FactPill label="PR" href={PULL} chip={chip}>
      #204150
    </FactPill>,
    mode
  );
  const [pill, pillLink, , , chipLink] = tags(html);
  return { html, css, pill, pillLink, chipLink };
}

function oneLink(mode: "light" | "dark" = "light") {
  const { html, css } = rendered(<FactPill label="Commit" chip={chip} />, mode);
  const [pill, wordsSpan, , chipLink] = tags(html);
  return { html, css, pill, wordsSpan, chipLink };
}

describe("pillChipColors", () => {
  test("is the page's background in the primary ink, lifted in the light mode and edged in the dark one", () => {
    const light = createTheme({ palette: { mode: "light" } });
    expect(pillChipColors(light)).toEqual({
      background: light.palette.background.default,
      text: light.palette.text.primary,
      rest: "0 1px 1.5px rgba(0, 0, 0, 0.1)",
      hover: `inset 0 0 0 1px ${light.palette.text.secondary}, 0 1px 1.5px rgba(0, 0, 0, 0.1)`,
    });
    const dark = createTheme({ palette: { mode: "dark" } });
    expect(pillChipColors(dark)).toEqual({
      background: dark.palette.background.default,
      text: dark.palette.text.primary,
      rest: "inset 0 0 0 1px rgba(255, 255, 255, 0.1)",
      hover: `inset 0 0 0 1px ${dark.palette.text.secondary}`,
    });
  });

  test("the background is the page's, not a card's", () => {
    const theme = createTheme({
      palette: { background: { default: "#010203", paper: "#040506" } },
    });
    expect(pillChipColors(theme).background).toBe("#010203");
  });

  test("under the pointer the chip is ringed in the secondary ink, in both modes", () => {
    for (const mode of MODES) {
      const theme = createTheme({ palette: { mode } });
      const colors = pillChipColors(theme);
      expect(colors.hover).not.toBe(colors.rest);
      expect(colors.hover).toContain(
        `inset 0 0 0 1px ${theme.palette.text.secondary}`
      );
    }
  });
});

describe("FactPill with a chip", () => {
  test("holds two links, the pill's and then the chip's, the chip named and tipped", () => {
    const { html, pill, pillLink, chipLink } = twoLinks();
    expect(words(html)).toBe("PR #204150 573c889");
    // The pill itself is not a link: it holds the two.
    expect(pill.name).toBe("span");
    expect(tags(html).filter((tag) => tag.name === "a")).toHaveLength(2);
    expect(pillLink.name).toBe("a");
    expect(pillLink.attributes.href).toBe(PULL);
    expect(pillLink.attributes["aria-label"]).toBeUndefined();
    expect(chipLink.name).toBe("a");
    expect(chipLink.attributes).toMatchObject({
      href: COMMIT,
      "aria-label": "Commit 573c889",
      title: SHA,
    });
    // The pill's link holds the pill's words, and the chip is not in it.
    expect(html).toMatch(
      /<a [^>]*href="[^"]*\/pull\/204150"[^>]*>.*#204150.*?<\/a><a /
    );
  });

  test("sets the chip inside the pill's end, on the page's background, in both modes", () => {
    for (const mode of MODES) {
      const theme = createTheme({ palette: { mode } });
      const colors = pillChipColors(theme);
      const { css, pill, chipLink } = twoLinks(mode);
      const pillRule = rule(css, pill);
      // A pill's height in the facts' grey, the chip 2px inside its end.
      expect(pillRule).toContain("height:26px;");
      expect(pillRule).toContain("padding-left:0px;padding-right:2px;");
      expect(pillRule).toContain(`background-color:${headerBandColor(theme)};`);
      const chipRule = rule(css, chipLink);
      expect(chipRule).toContain("height:22px;");
      expect(chipRule).toContain("border-radius:999px;");
      expect(chipRule).toContain(`background-color:${colors.background};`);
      expect(chipRule).toContain(`color:${colors.text};`);
      expect(chipRule).toContain(`box-shadow:${colors.rest};`);
    }
  });

  test("each part answers the pointer alone", () => {
    for (const mode of MODES) {
      const theme = createTheme({ palette: { mode } });
      const { css, pill, pillLink, chipLink } = twoLinks(mode);
      // On the pill's words the pill darkens, as a link's pill does.
      expect(rule(css, pill, ":has(> a:first-of-type:hover)")).toBe(
        `background-color:${darken(headerBandColor(theme), 0.12)};`
      );
      // Not wherever the pointer is on it: the chip is its own.
      expect(rule(css, pill, ":hover")).toBeUndefined();
      expect(rule(css, pillLink, ":hover")).toBeUndefined();
      // On the chip the chip is ringed (Emotion writes a list of shadows
      // without the space after its comma).
      expect(rule(css, chipLink, ":hover")).toBe(
        `box-shadow:${pillChipColors(theme).hover.replace("), ", "),")};`
      );
    }
  });

  test("from the keyboard the pill's link rings the pill, and the chip's the chip", () => {
    const theme = createTheme();
    const ring = `outline:2px solid ${theme.palette.primary.main};outline-offset:2px;`;
    const { css, pill, pillLink, chipLink } = twoLinks();
    expect(rule(css, pill, ":has(> a:first-of-type:focus-visible)")).toBe(ring);
    // The words alone are not ringed: they are half a pill.
    expect(rule(css, pillLink)).toContain("outline:none;");
    expect(rule(css, pillLink, ":focus-visible")).toBeUndefined();
    expect(rule(css, chipLink, ":focus-visible")).toBe(ring);
  });

  test("the chip is pressed out to the pill's edge, over its whole height", () => {
    const { css, chipLink } = twoLinks();
    expect(rule(css, chipLink)).toContain("position:relative;");
    expect(rule(css, chipLink, "::after")).toBe(
      'content:"";position:absolute;inset:-2px;border-radius:999px;'
    );
  });

  describe("and no link of its own", () => {
    test("says its word once, and is the chip's link whole", () => {
      const { html, pill, wordsSpan, chipLink } = oneLink();
      expect(words(html)).toBe("Commit 573c889");
      expect(pill.name).toBe("span");
      // One link, the chip's, which names the fact; the word beside it is
      // not said again.
      expect(tags(html).filter((tag) => tag.name === "a")).toHaveLength(1);
      expect(wordsSpan.name).toBe("span");
      expect(wordsSpan.attributes["aria-hidden"]).toBe("true");
      expect(chipLink.attributes).toMatchObject({
        href: COMMIT,
        "aria-label": "Commit 573c889",
        title: SHA,
      });
      // No value of its own: nothing between the word and the chip.
      expect(html).toMatch(/<span>Commit<\/span><\/span><a /);
    });

    test("is pressed anywhere, and answers as one link does", () => {
      for (const mode of MODES) {
        const theme = createTheme({ palette: { mode } });
        const ring = `outline:2px solid ${theme.palette.primary.main};outline-offset:2px;`;
        const { css, pill, chipLink } = oneLink(mode);
        // The chip's link covers the pill.
        expect(rule(css, pill)).toContain("position:relative;");
        expect(rule(css, chipLink)).toContain("position:static;");
        expect(rule(css, chipLink, "::after")).toBe(
          'content:"";position:absolute;inset:0;border-radius:999px;'
        );
        // The pill darkens under the pointer and is ringed from the
        // keyboard; the chip does neither alone.
        expect(rule(css, pill, ":hover")).toBe(
          `background-color:${darken(headerBandColor(theme), 0.12)};`
        );
        expect(rule(css, pill, ":has(> a:focus-visible)")).toBe(ring);
        expect(
          rule(css, pill, ":has(> a:first-of-type:hover)")
        ).toBeUndefined();
        expect(rule(css, chipLink, ":hover")).toBeUndefined();
        expect(rule(css, chipLink, ":focus-visible")).toBeUndefined();
        expect(rule(css, chipLink)).toContain("outline:none;");
      }
    });
  });

  test("a pill without a chip is one element, as it was", () => {
    const { html, css } = rendered(
      <FactPill label="Branch" href="https://github.com/pytorch/pytorch">
        main
      </FactPill>
    );
    const [pill, ...rest] = tags(html);
    expect(pill.name).toBe("a");
    expect(rest.filter((tag) => tag.name === "a")).toHaveLength(0);
    expect(rule(css, pill)).toContain("padding-left:10px;padding-right:10px;");
    expect(rule(css, pill, ":hover")).toBeDefined();
    expect(css).not.toContain(":has(");
    expect(css).not.toContain("::after");
  });
});

describe("the commit header's pull request and commit", () => {
  const head: CommitRecord = {
    sha: SHA,
    url: COMMIT,
    title: "[dynamo] Trim per-instruction work in step() and popn()",
    author: { name: "Guilherme Leobas", login: "guilhermeleobas" },
    committed_at: "2026-11-10T01:49:00.000Z",
    branch: "gh/guilhermeleobas/620/head",
    pull_request_head: true,
    pull_request: {
      number: 204150,
      url: PULL,
      title: "[dynamo] Trim per-instruction work in step() and popn()",
    },
    newer_sha: null,
    older_sha: null,
  };
  // The commit a pull request landed as: the API names no pull request for
  // it, and its title ends in the number.
  const landed: CommitRecord = {
    ...head,
    title: "[FakeTensor] Extract real-output validation helpers (#204301)",
    branch: "main",
    pull_request_head: false,
    pull_request: null,
  };
  // A merge bot's revert: the number in its title is the reverted pull
  // request's, not its own.
  const revert: CommitRecord = {
    ...landed,
    title: 'Revert "[futures] set_exception completes the future (#204279)"',
  };

  // The header's facts, after its headline, and the links among them that
  // lead to GitHub.
  function facts(commit: CommitRecord, mode: "light" | "dark" = "light") {
    const { html, css } = rendered(
      <CommitHeader repo={REPO} commit={commit} />,
      mode
    );
    const after = html.slice(html.indexOf("</h1>"));
    return {
      css,
      said: words(after),
      links: tags(after).filter((tag) =>
        tag.attributes.href?.startsWith("https://github.com/")
      ),
    };
  }

  test("a pull request head is one pill: the pull request's, the commit set inside it", () => {
    const { said, links } = facts(head);
    // The SHA has no word beside it inside the pull request.
    expect(said).toBe(
      "PR #204150 573c889 Author Guilherme Leobas Committed Branch gh/guilhermeleobas/620/head"
    );
    expect(links.map((link) => link.attributes.href)).toEqual([PULL, COMMIT]);
    expect(links[1].attributes).toMatchObject({
      "aria-label": "Commit 573c889",
      title: SHA,
    });
  });

  test("the commit a pull request landed as names the pull request its title ends in", () => {
    const { said, links } = facts(landed);
    expect(said.startsWith("PR #204301 573c889 Author")).toBe(true);
    expect(links.map((link) => link.attributes.href)).toEqual([
      "https://github.com/pytorch/pytorch/pull/204301",
      COMMIT,
    ]);
  });

  test("a commit of no pull request has the same pill saying Commit, its one link the commit's", () => {
    const { said, links } = facts(revert);
    expect(said.startsWith("Commit 573c889 Author")).toBe(true);
    expect(links.map((link) => link.attributes.href)).toEqual([COMMIT]);
    expect(links[0].attributes).toMatchObject({
      "aria-label": "Commit 573c889",
      title: SHA,
    });
  });

  test("the pill is in the facts' grey in both modes: the header's only color is a status's", () => {
    for (const mode of MODES) {
      const theme = createTheme({ palette: { mode } });
      for (const commit of [head, landed, revert]) {
        const { css } = facts(commit, mode);
        expect(css).toContain(`background-color:${headerBandColor(theme)};`);
        // GitHub's blue, which the pull request's pill had.
        expect(css.toLowerCase()).not.toContain("#0969da");
        expect(css.toLowerCase()).not.toContain("#1f6feb");
      }
    }
  });
});
