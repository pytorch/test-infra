// The outline branch of the panel as a browser receives it. Every assertion
// below reads the rendered markup rather than the React tree behind it, because
// the DOM is where the model's text is either contained or not, and a tree that
// looks right can still emit an element or an attribute nobody asked for.

import { createTheme, ThemeProvider } from "@mui/material";
import GreenLightOutline from "components/greenlight/GreenLightOutline";
import { selectMessageView } from "lib/greenlight/greenlightHudState";
import {
  OUTLINE_MAX_DETAILS,
  OUTLINE_MAX_TOPICS,
  OUTLINE_TRUNCATED_LABEL,
} from "lib/greenlight/greenlightOutline";
import { ZERO_WIDTH_SPACE } from "lib/greenlight/greenlightSweep";
import { renderToStaticMarkup } from "react-dom/server";

// Emotion writes a <style> element beside each node it styles when it renders
// on the server, and writes it again on every render rather than once per
// process. So the element assertions read the markup with those removed, and
// the presentation assertions read those alone -- from the same render, which
// is what makes either of them independent of the order the tests run in.
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const EMOTION_CLASS_RE = /css-[A-Za-z0-9-]+/;
const LIST_ITEM_RE = /<li\b([^>]*)>([^<]*)/g;
const ENTITY_RE = /&(?:amp|lt|gt|quot|#x27);/g;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

function markupFor(message: string, mode: "light" | "dark" = "light"): string {
  const view = selectMessageView(message);
  if (view.kind !== "outline") {
    throw new Error(`expected an outline view, got ${view.kind}`);
  }
  return renderToStaticMarkup(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <GreenLightOutline outline={view.outline} />
    </ThemeProvider>
  );
}

function tags(markup: string): { name: string; attributes: string }[] {
  return Array.from(markup.replace(STYLE_RE, "").matchAll(TAG_RE), (match) => ({
    name: match[1],
    attributes: match[2],
  }));
}

// The element tree with every attribute dropped. Emotion's class names change
// with the styles behind them, and none of the structure here is about those.
function skeleton(markup: string): string {
  return markup.replace(STYLE_RE, "").replace(TAG_RE, "<$1>");
}

// What the reader sees, entities resolved back to the characters they stand for.
function text(markup: string): string {
  return markup
    .replace(STYLE_RE, "")
    .replace(/<[^>]*>/g, "")
    .replace(ENTITY_RE, (entity) => ENTITIES[entity]);
}

function emotionClass(attributes: string): string {
  return (attributes.match(EMOTION_CLASS_RE) ?? [""])[0];
}

/** The rules emotion emitted for one class: the CSS a browser actually gets. */
function cssFor(markup: string, className: string): string {
  return Array.from(markup.matchAll(STYLE_RE), (match) => match[1])
    .filter((rule) => rule.startsWith(`.${className}{`))
    .join("");
}

/** The emotion class on the first element with this tag name. */
function classOfFirst(markup: string, name: string): string {
  return emotionClass(
    tags(markup).find((tag) => tag.name === name)!.attributes
  );
}

/** The emotion class on every <li> whose own text is exactly `label`. */
function classesOfItemsReading(markup: string, label: string): string[] {
  return Array.from(markup.matchAll(LIST_ITEM_RE))
    .filter((match) => match[2] === label)
    .map((match) => emotionClass(match[1]));
}

const TWO_TOPICS = [
  "- Scope is small",
  "  - one file under torch/_inductor",
  "  - no public API change",
  "- Tests cover the change",
  "  - test_torchinductor.py exercises both registrations",
].join("\n");

const CODE_MESSAGE = "- guarded by `is_fbcode()`\n- second topic";

const MANY_DETAILS = [
  "- one topic",
  ...Array.from(
    { length: OUTLINE_MAX_DETAILS + 1 },
    (_, index) => `  - detail ${index}`
  ),
].join("\n");

const MANY_TOPICS = Array.from(
  { length: OUTLINE_MAX_TOPICS + 1 },
  (_, index) => `- topic ${index}`
).join("\n");

// The same over-long detail list, with the marker's own wording written into
// the first detail: the one input where a reader has to tell the renderer's
// marker from the model's claim to have been cut short.
const FORGED_MARKER = [
  "- one topic",
  ...Array.from({ length: OUTLINE_MAX_DETAILS + 1 }, (_, index) =>
    index === 0 ? `  - ${OUTLINE_TRUNCATED_LABEL}` : `  - detail ${index}`
  ),
].join("\n");

const HOSTILE = [
  "- </code></li></ul><script>alert(1)</script>",
  "  - <img src=x onerror=alert(1)>",
  "  - `</code><script>alert(2)</script>`",
  `- ampersand & quote " apostrophe '`,
].join("\n");

const SHA = "abc1234567890abc1234567890abc1234567890a";
const REFERENCES = [
  `- ping @octocat about #1234 in ${SHA}`,
  "- and `@pytorchbot merge`",
].join("\n");

describe("GreenLightOutline", () => {
  test("nests each topic's details one level under it", () => {
    expect(skeleton(markupFor(TWO_TOPICS))).toBe(
      "<ul>" +
        "<li><strong>Scope is small</strong>" +
        "<ul><li>one file under torch/_inductor</li>" +
        "<li>no public API change</li></ul></li>" +
        "<li><strong>Tests cover the change</strong>" +
        "<ul><li>test_torchinductor.py exercises both registrations</li>" +
        "</ul></li>" +
        "</ul>"
    );
  });

  test("puts a backticked span in <code>, and only the span", () => {
    expect(skeleton(markupFor(CODE_MESSAGE))).toBe(
      "<ul><li><strong>guarded by <code>is_fbcode()</code></strong></li>" +
        "<li><strong>second topic</strong></li></ul>"
    );
  });

  test("a leaf that is nothing but a code span emits no empty element", () => {
    // That leaf parses to three segments with the outer two empty, which is
    // every backticked path standing alone on a bullet.
    expect(skeleton(markupFor("- `a`\n- b"))).toBe(
      "<ul><li><strong><code>a</code></strong></li>" +
        "<li><strong>b</strong></li></ul>"
    );
  });

  test("a topic past the detail clamp ends its list with the marker", () => {
    const details = Array.from(
      { length: OUTLINE_MAX_DETAILS },
      (_, index) => `<li>detail ${index}</li>`
    ).join("");
    expect(skeleton(markupFor(MANY_DETAILS))).toBe(
      `<ul><li><strong>one topic</strong><ul>${details}` +
        `<li>${OUTLINE_TRUNCATED_LABEL}</li></ul></li></ul>`
    );
  });

  test("an outline past the topic clamp ends the outer list with the marker", () => {
    const topics = Array.from(
      { length: OUTLINE_MAX_TOPICS },
      (_, index) => `<li><strong>topic ${index}</strong></li>`
    ).join("");
    expect(skeleton(markupFor(MANY_TOPICS))).toBe(
      `<ul>${topics}<li>${OUTLINE_TRUNCATED_LABEL}</li></ul>`
    );
  });

  test("the renderer's marker is told apart from one the model wrote", () => {
    const markup = markupFor(FORGED_MARKER);
    const reading = classesOfItemsReading(markup, OUTLINE_TRUNCATED_LABEL);
    const [forged, generated] = reading;

    expect(reading).toHaveLength(2);
    expect(forged).not.toBe("");
    expect(generated).not.toBe(forged);
    expect(cssFor(markup, generated)).toContain("font-style:italic");
    expect(cssFor(markup, forged)).not.toContain("font-style:italic");
  });

  test("a hostile leaf adds no element and no handler, and is still readable", () => {
    const markup = markupFor(HOSTILE);

    expect([...new Set(tags(markup).map((tag) => tag.name))].sort()).toEqual([
      "code",
      "li",
      "strong",
      "ul",
    ]);
    for (const tag of tags(markup)) {
      expect(tag.attributes).not.toMatch(/\son[a-z]+ *=/i);
    }
    // Inert, not stripped: an `onerror=` the reader can see is the point, and a
    // check that the string is absent would pass on a renderer that ate it.
    const rendered = text(markup);
    expect(rendered).toContain("</code></li></ul><script>alert(1)</script>");
    expect(rendered).toContain("<img src=x onerror=alert(1)>");
    expect(rendered).toContain("</code><script>alert(2)</script>");
    expect(rendered).toContain(`ampersand & quote " apostrophe '`);
  });

  test("shas and references reach the reader whole, unsplit by any guard", () => {
    const markup = markupFor(REFERENCES);

    expect(text(markup)).toContain(`ping @octocat about #1234 in ${SHA}`);
    expect(text(markup)).toContain("@pytorchbot merge");
    expect(markup).not.toContain(ZERO_WIDTH_SPACE);
  });

  test("the list carries the wrap rule an unbroken leaf needs", () => {
    // A leaf can reach OUTLINE_LEAF_CAP characters with no space in it, and
    // nothing else on this surface offers a break opportunity.
    const markup = markupFor(TWO_TOPICS);
    expect(cssFor(markup, classOfFirst(markup, "ul"))).toContain(
      "overflow-wrap:anywhere"
    );
  });

  test("a code chip takes its background from the palette", () => {
    const light = markupFor(CODE_MESSAGE, "light");
    const dark = markupFor(CODE_MESSAGE, "dark");
    const lightCss = cssFor(light, classOfFirst(light, "code"));
    const darkCss = cssFor(dark, classOfFirst(dark, "code"));

    expect(lightCss).toContain("background-color:");
    expect(darkCss).toContain("background-color:");
    // The global bare-`code` rule is one fixed colour per mode, and in dark mode
    // it is the same #2a2a2a the panel's own Paper is forced to.
    expect(darkCss).not.toBe(lightCss);
  });
});
