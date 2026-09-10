import { readFileSync } from "fs";
import { ADVISOR_PENDING_ALT_ATTR } from "lib/advisor/advisorBadge";
import {
  isOutline,
  OUTLINE_BLOCK_BUDGET,
  OUTLINE_LEAF_CAP,
  OUTLINE_MAX_DETAILS,
  OUTLINE_MAX_TOPICS,
  OUTLINE_MESSAGE_CAP,
  OUTLINE_TRUNCATED_ITEM,
  OUTLINE_TRUNCATION_SUFFIX,
  renderOutlineHtml,
} from "lib/greenlight/greenlightOutline";
import { SHA_SPLIT_COLUMN } from "lib/greenlight/greenlightReferenceGuards";
import {
  GREENLIGHT_PENDING_ALT_ATTR,
  ZERO_WIDTH_SPACE,
} from "lib/greenlight/greenlightSweep";
import * as path from "path";

const ZWSP = ZERO_WIDTH_SPACE;
const SHA = "abc1234567890abc1234567890abc1234567890a";
const SPLIT_SHA =
  SHA.slice(0, SHA_SPLIT_COLUMN) + ZWSP + SHA.slice(SHA_SPLIT_COLUMN);
const SENTINEL = GREENLIGHT_PENDING_ALT_ATTR;
const ADVISOR_SENTINEL = ADVISOR_PENDING_ALT_ATTR;
// Spelled by code point so no invisible character has to survive in this source.
const NBSP = String.fromCharCode(0xa0);
const EM_SPACE = String.fromCharCode(0x2003);
const EACUTE = String.fromCharCode(0xe9);
const ARABIC_DIGITS = String.fromCharCode(0x661, 0x662, 0x663);
const UNICODE_BULLET = String.fromCharCode(0x2022);
const BOM = String.fromCharCode(0xfeff);

// Everything this module is allowed to put in the comment.
const ALLOWED_TAGS = [
  "<ul>",
  "</ul>",
  "<li>",
  "</li>",
  "<b>",
  "</b>",
  "<code>",
  "</code>",
];
const TAG_RE = /<[^>]*>/g;
// The predicate Dr. CI's re-render sweep runs over the raw comment body.
const SWEEP_PENDING_RE = /[0-9] Pending/;

// A paragraph verdict: one unbroken prose line carrying no bullet marker.
// Nothing enforces the outline shape, so a reviewer can still write one of these,
// and every row stored before the outline format existed is one.
const STORED_PROSE =
  "This PR adds a guard to torch/_inductor/lowering.py so make_fallback no longer registers " +
  "aten.index_put_ twice when the decomposition table is rebuilt; the change is confined to " +
  "the registration path and every existing caller keeps the same behaviour, because the new " +
  "branch only fires when the op is already present in the table. The accompanying test in " +
  "test/inductor/test_torchinductor.py exercises both the first and the second registration " +
  "and asserts the fallback is unchanged. The remaining diff is a docstring correction in " +
  "torch/_inductor/decomposition.py that renames the argument to match the signature, plus a " +
  "type annotation on _register_fallback that mypy already inferred. Nothing in the change " +
  "touches the runtime kernels, the autograd formulas, or any serialized artifact, so the " +
  "blast radius is limited to compile-time registration and the risk of a silent numerical " +
  "regression is nil. CI is green on the inductor shards that cover this file.";

const HOSTILE_PAYLOADS = [
  "</details>",
  "</summary>",
  "# FAKE LAND VERDICT",
  "---",
  "***",
  "1. x",
  "| a | b |",
  "[^1]",
  "[x]: y",
  "```",
  "<ul>",
  "</li>",
  "<script>alert(1)</script>",
  "<img src=x onerror=y>",
  '<a href="https://evil.example">click</a>',
  'x" onload="y',
  "x' onload='y",
  "<![CDATA[ x ]]>",
  "<!-- y -->",
  "&amp;",
  "&lt;",
  "</b></li></ul><script>x</script><ul><li><b>",
];

// Line-break shapes that would end the raw HTML block if any survived the render.
const BLANK_LINE_BREAKOUTS = ["\n\n", "\r\r", "\r\n\r\n", "\n   \n", "\n\t\n"];

function tagsOf(block: string): string[] {
  return block.match(TAG_RE) ?? [];
}

function countOf(block: string, needle: string): number {
  return block.split(needle).length - 1;
}

// Every guarantee the block makes to the comment it is embedded in.
function expectContained(block: string): void {
  expect(block).not.toContain("\n");
  expect(block).not.toContain("\r");
  const tags = tagsOf(block);
  // No `<` survives outside a tag this module emitted, so nothing in the message
  // can open one.
  expect(countOf(block, "<")).toBe(tags.length);
  for (const tag of tags) expect(ALLOWED_TAGS).toContain(tag);
  expect(countOf(block, "<code>")).toBe(countOf(block, "</code>"));
  expect(block).not.toMatch(SWEEP_PENDING_RE);
}

function bullet(...leaves: string[]): string {
  return leaves.join("\n");
}

describe("isOutline", () => {
  it("leaves a prose verdict on the fenced renderer", () => {
    expect(isOutline(STORED_PROSE)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["no marker", "No bullets here at all."],
    ["no space after the marker", "-no space after the marker"],
    ["marker with no text", "- "],
    ["marker with a tab and no text", "-\t"],
    ["ordered marker with no space", "1.no space"],
    ["dash mid line", "a - b"],
    ["indented prose", "  indented prose"],
    ["unicode bullet", `${UNICODE_BULLET} a unicode bullet`],
    ["unicode digits", `${ARABIC_DIGITS}. arabic-indic digits are not [0-9]`],
    ["a single bullet", "- x"],
    ["one bullet after prose", "prose first\n- then one bullet"],
    ["one bullet before prose", "- one bullet\nthen prose"],
    ["a paragraph with one bullet appended", `${STORED_PROSE}\n- x`],
  ])("is not an outline: %s", (_name, message) => {
    expect(isOutline(message)).toBe(false);
  });

  it("leaves a paragraph with one bullet on the fenced renderer", () => {
    // The cheap attack on the switch: two characters appended to a long
    // paragraph move it onto a renderer that shows the reader one leaf of it
    // and clips the rest.
    expect(STORED_PROSE.length).toBeGreaterThan(OUTLINE_LEAF_CAP);
    expect(isOutline(`${STORED_PROSE}\n- x`)).toBe(false);
    expect(isOutline(`${STORED_PROSE}\n- x\n- y`)).toBe(true);
  });

  it.each([
    ["dash", "- x\n- y"],
    ["star", "* x\n* y"],
    ["plus", "+ x\n+ y"],
    ["ordered dot", "1. x\n2. y"],
    ["ordered paren", "2) x\n3) y"],
    ["tab indent", "\t- x\n\t- y"],
    ["space indent", "   - x\n   - y"],
    ["tab after marker", "-\tx\n-\ty"],
    ["bullet after prose", "prose first\n- then a bullet\n- and another"],
    ["crlf", "- x\r\n- y"],
    ["lone cr", "- x\r- y"],
  ])("is an outline: %s", (_name, message) => {
    expect(isOutline(message)).toBe(true);
  });

  it("reads the same prefix the renderer does", () => {
    // Bullets past the cap are text the renderer never sees, so they cannot
    // decide which renderer runs -- otherwise the outline path receives a
    // message it renders as a single clipped leaf.
    const beyond = "x".repeat(OUTLINE_MESSAGE_CAP) + "\n- a\n- b";
    expect(isOutline(beyond)).toBe(false);
    expect(isOutline("- a\n- b\n" + beyond)).toBe(true);
  });
});

describe("renderOutlineHtml structure", () => {
  it("nests details under their topic", () => {
    expect(
      renderOutlineHtml(
        bullet("- Topic one", "  - detail a", "  - detail b", "- Topic two")
      )
    ).toBe(
      "<ul><li><b>Topic one</b><ul><li>detail a</li><li>detail b</li></ul></li>" +
        "<li><b>Topic two</b></li></ul>"
    );
  });

  it("emits no inner list for a topic with no details", () => {
    expect(renderOutlineHtml("- Only a topic")).toBe(
      "<ul><li><b>Only a topic</b></li></ul>"
    );
  });

  it("caps a bullet-free paragraph at the leaf cap", () => {
    const clipped =
      Array.from(STORED_PROSE).slice(0, OUTLINE_LEAF_CAP).join("") +
      OUTLINE_TRUNCATION_SUFFIX;
    expect(renderOutlineHtml(STORED_PROSE)).toBe(
      `<ul><li><b>${clipped}</b></li></ul>`
    );
  });

  it("joins a continuation line onto the bullet above it", () => {
    expect(
      renderOutlineHtml(
        bullet("- Topic that the model", "  wrapped over two lines")
      )
    ).toBe(
      "<ul><li><b>Topic that the model wrapped over two lines</b></li></ul>"
    );
  });

  it("joins a continuation line onto a detail", () => {
    expect(
      renderOutlineHtml(bullet("- Topic", "  - detail that", "    kept going"))
    ).toBe(
      "<ul><li><b>Topic</b><ul><li>detail that kept going</li></ul></li></ul>"
    );
  });

  it("ends a continuation at a blank line", () => {
    // A closing paragraph is not evidence for the last detail above it, and the
    // blank line is the one signal in the format that says so.
    expect(
      renderOutlineHtml(
        bullet("- Scope", "  - one file", "", "Overall this looks safe.")
      )
    ).toBe(
      "<ul><li><b>Scope</b><ul><li>one file</li></ul></li>" +
        "<li><b>Overall this looks safe.</b></li></ul>"
    );
  });

  it("ends a prose continuation at a blank line", () => {
    expect(
      renderOutlineHtml(
        bullet("first paragraph", "still the first", "", "second")
      )
    ).toBe(
      "<ul><li><b>first paragraph still the first</b></li>" +
        "<li><b>second</b></li></ul>"
    );
  });

  it("flattens numbered markers to the same shape", () => {
    expect(
      renderOutlineHtml(bullet("1. First", "2) Second", "   1. nested"))
    ).toBe(
      "<ul><li><b>First</b></li><li><b>Second</b><ul><li>nested</li></ul></li></ul>"
    );
  });

  it("treats the shallowest bullet as the top level", () => {
    expect(renderOutlineHtml(" - one space")).toBe(
      "<ul><li><b>one space</b></li></ul>"
    );
  });

  it("keeps the shape of a uniformly indented outline", () => {
    // Against an absolute threshold every one of these is a detail, so the
    // second topic renders as evidence for the first -- a relationship the
    // reviewer never wrote, posted permanently.
    expect(
      renderOutlineHtml(
        bullet("  - Testing", "    - covers it", "  - Scope", "    - one file")
      )
    ).toBe(
      "<ul><li><b>Testing</b><ul><li>covers it</li></ul></li>" +
        "<li><b>Scope</b><ul><li>one file</li></ul></li></ul>"
    );
  });

  it.each([
    ["one space", " "],
    ["one tab", "\t"],
    ["two spaces", "  "],
    ["two tabs", "\t\t"],
  ])("nests a bullet indented by %s", (_name, indent) => {
    expect(renderOutlineHtml(bullet("- topic", `${indent}- nested`))).toBe(
      "<ul><li><b>topic</b><ul><li>nested</li></ul></li></ul>"
    );
  });

  it("clamps depth to one", () => {
    expect(
      renderOutlineHtml(bullet("- topic", "  - detail", "      - deeper still"))
    ).toBe(
      "<ul><li><b>topic</b><ul><li>detail</li><li>deeper still</li></ul></li></ul>"
    );
  });

  it("promotes a detail written before any topic", () => {
    expect(renderOutlineHtml(bullet("  - nested first", "- topic after"))).toBe(
      "<ul><li><b>nested first</b></li><li><b>topic after</b></li></ul>"
    );
  });

  it("promotes every leading orphan", () => {
    // Two orphans are peers. Promoting only the first makes the second read as
    // evidence for it.
    expect(
      renderOutlineHtml(
        bullet("  - first orphan", "  - second orphan", "- topic after")
      )
    ).toBe(
      "<ul><li><b>first orphan</b></li><li><b>second orphan</b></li>" +
        "<li><b>topic after</b></li></ul>"
    );
  });

  it("keeps details whose topic flattened away", () => {
    expect(renderOutlineHtml(bullet(`- ${ZWSP}${ZWSP}`, "  - survivor"))).toBe(
      "<ul><li><b>survivor</b></li></ul>"
    );
  });

  it.each([
    ["empty", "- "],
    ["tab", "-\t"],
    ["zero width", `- ${ZWSP}${ZWSP}`],
    ["invisibles", `- ${BOM} ${String.fromCharCode(0)}`],
  ])(
    "never hands a dropped topic's details to the topic above it: %s",
    (_name, dropped) => {
      // One stray empty bullet, and a blocker renders as evidence for an
      // unrelated topic -- exactly the relationship promotion exists to prevent,
      // and posted permanently. No adversary needed.
      expect(
        renderOutlineHtml(
          bullet(
            "- Scope",
            "  - one file",
            dropped,
            "  - NO_LAND: secrets leak"
          )
        )
      ).toBe(
        "<ul><li><b>Scope</b><ul><li>one file</li></ul></li>" +
          "<li><b>NO_LAND: secrets leak</b></li></ul>"
      );
    }
  );

  it("keeps a dropped topic between two real ones from joining them", () => {
    expect(
      renderOutlineHtml(bullet("- Scope", "- ", "  - promoted", "- Testing"))
    ).toBe(
      "<ul><li><b>Scope</b></li><li><b>promoted</b></li>" +
        "<li><b>Testing</b></li></ul>"
    );
  });

  it("keeps details under a dropped topic as peers", () => {
    // Two details of one dropped marker are siblings, exactly as two leading
    // orphans are. Nesting the second under the first invents a parent and child
    // out of two of the reviewer's claims.
    expect(
      renderOutlineHtml(
        bullet("- Scope", "- ", "  - promoted", "  - second claim")
      )
    ).toBe(
      "<ul><li><b>Scope</b></li><li><b>promoted</b></li>" +
        "<li><b>second claim</b></li></ul>"
    );
  });

  it("drops a detail that flattens away without a trace", () => {
    expect(
      renderOutlineHtml(bullet("- topic", `  - ${ZWSP}`, "  - kept"))
    ).toBe("<ul><li><b>topic</b><ul><li>kept</li></ul></li></ul>");
  });

  it("emits no list item for an empty leaf", () => {
    expect(renderOutlineHtml(bullet("- ", "- kept", "- \t"))).toBe(
      "<ul><li><b>kept</b></li></ul>"
    );
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["newlines", "\n\n\n"],
    ["zero width", `- ${ZWSP}`],
    [
      "invisibles",
      `- ${String.fromCharCode(0)}${String.fromCharCode(0x7f)}${BOM}`,
    ],
  ])("returns empty so the message goes out fenced: %s", (_name, message) => {
    expect(renderOutlineHtml(message)).toBe("");
  });
});

describe("containment", () => {
  it.each(HOSTILE_PAYLOADS)("stays contained: %s", (payload) => {
    const block = renderOutlineHtml(bullet(`- ${payload}`, `  - ${payload}`));
    expectContained(block);
    expect(tagsOf(block)).toEqual([
      "<ul>",
      "<li>",
      "<b>",
      "</b>",
      "<ul>",
      "<li>",
      "</li>",
      "</ul>",
      "</li>",
      "</ul>",
    ]);
  });

  it.each(HOSTILE_PAYLOADS)(
    "stays one line with a blank line: %s",
    (payload) => {
      for (const breakout of BLANK_LINE_BREAKOUTS) {
        expectContained(
          renderOutlineHtml(`- ${payload}${breakout}- ${payload}`)
        );
      }
    }
  );

  it("escapes markup rather than stripping it", () => {
    expect(renderOutlineHtml("- <script>alert(1)</script>")).toBe(
      "<ul><li><b>&lt;script&gt;alert(1)&lt;/script&gt;</b></li></ul>"
    );
  });

  it("double-escapes a pre-encoded entity", () => {
    expect(renderOutlineHtml("- &amp; &lt;")).toBe(
      "<ul><li><b>&amp;amp; &amp;lt;</b></li></ul>"
    );
  });

  it("uses the apostrophe entity the reference guard leaves alone", () => {
    // `&#39;` would carry a `#` followed by a digit, which the issue-reference
    // guard then splits into a broken entity the reader sees verbatim.
    expect(renderOutlineHtml("- it's")).toBe(
      "<ul><li><b>it&#x27;s</b></li></ul>"
    );
  });

  it("escapes quotes", () => {
    expect(renderOutlineHtml('- x" onload="y')).toBe(
      "<ul><li><b>x&quot; onload=&quot;y</b></li></ul>"
    );
  });

  it("agrees with Python on all five escaped characters", () => {
    expect(renderOutlineHtml("- & < > \" '")).toBe(
      "<ul><li><b>&amp; &lt; &gt; &quot; &#x27;</b></li></ul>"
    );
  });
});

describe("flattening", () => {
  it("substitutes rather than deletes an invisible character", () => {
    // A deletion would splice `Pen` onto `ding` and hand the sweep a live
    // predicate.
    const block = renderOutlineHtml(`- 9 Pen${ZWSP}ding jobs`);
    expect(block).toBe("<ul><li><b>9 Pen ding jobs</b></li></ul>");
    expect(block).not.toMatch(SWEEP_PENDING_RE);
  });

  it("collapses space runs and strips the edges", () => {
    expect(renderOutlineHtml("-    a     b   ")).toBe(
      "<ul><li><b>a b</b></li></ul>"
    );
  });

  it("leaves non-ASCII spaces alone", () => {
    // `\s` would have eaten these in Python and not here, which is the whole
    // reason no shorthand class appears in either implementation.
    expect(renderOutlineHtml(`- a${NBSP}b${EM_SPACE}c`)).toBe(
      `<ul><li><b>a${NBSP}b${EM_SPACE}c</b></li></ul>`
    );
  });

  it("caps the leaf before escaping", () => {
    expect(renderOutlineHtml("- " + "<".repeat(500))).toBe(
      `<ul><li><b>${"&lt;".repeat(
        OUTLINE_LEAF_CAP
      )}${OUTLINE_TRUNCATION_SUFFIX}</b></li></ul>`
    );
  });

  it("does not mark a leaf that lands exactly on the cap", () => {
    const block = renderOutlineHtml("- " + "x".repeat(OUTLINE_LEAF_CAP));
    expect(block).toBe(
      `<ul><li><b>${"x".repeat(OUTLINE_LEAF_CAP)}</b></li></ul>`
    );
    expect(block).not.toContain(OUTLINE_TRUNCATION_SUFFIX);
  });

  it("marks a clipped leaf", () => {
    // Without the mark, a bullet cut mid-word reads as the whole of what the
    // reviewer wrote.
    const block = renderOutlineHtml("- " + "x".repeat(OUTLINE_LEAF_CAP + 1));
    expect(block.endsWith(`${OUTLINE_TRUNCATION_SUFFIX}</b></li></ul>`)).toBe(
      true
    );
  });

  it("caps the message in code points, not UTF-16 units", () => {
    const block = renderOutlineHtml("- " + "\u{1f600}".repeat(4100));
    const leaf =
      "\u{1f600}".repeat(OUTLINE_LEAF_CAP) + OUTLINE_TRUNCATION_SUFFIX;
    expect(block).toBe(
      `<ul><li><b>${leaf}</b></li>${OUTLINE_TRUNCATED_ITEM}</ul>`
    );
  });

  it.each([
    ["lf", "\n"],
    ["cr", "\r"],
    ["vertical tab", "\v"],
    ["form feed", "\f"],
    ["nel", String.fromCharCode(0x85)],
    ["line separator", String.fromCharCode(0x2028)],
    ["paragraph separator", String.fromCharCode(0x2029)],
  ])("flattens the %s line break", (_name, char) => {
    expect(renderOutlineHtml(`- a${char}b`)).toBe(
      "<ul><li><b>a b</b></li></ul>"
    );
  });

  it.each([
    ["variation selector", 0xfe00],
    ["emoji variation selector", 0xfe0f],
    ["tag block start", 0xe0000],
    ["tag letter", 0xe0041],
    ["tag block end", 0xe007f],
    ["interlinear anchor", 0xfff9],
    ["interlinear terminator", 0xfffb],
    ["musical notation control", 0x1d173],
    ["musical notation control end", 0x1d17a],
    ["hangul choseong filler", 0x115f],
    ["object replacement", 0xfffc],
    ["combining grapheme joiner", 0x034f],
    ["hangul jungseong filler", 0x1160],
    ["halfwidth hangul filler", 0xffa0],
    ["khmer inherent vowel aq", 0x17b4],
    ["khmer inherent vowel aa", 0x17b5],
    ["mongolian free variation selector one", 0x180b],
    ["mongolian free variation selector four", 0x180f],
    ["inhibit symmetric swapping", 0x206a],
    ["nominal digit shapes", 0x206f],
    ["egyptian format control", 0x13430],
    ["shorthand format control", 0x1bca0],
    ["variation selector supplement start", 0xe0100],
    ["variation selector supplement end", 0xe01ef],
    ["supplementary special-purpose tail", 0xe0fff],
  ])("flattens the invisible %s", (_name, code) => {
    expect(renderOutlineHtml(`- a${String.fromCodePoint(code)}b`)).toBe(
      "<ul><li><b>a b</b></li></ul>"
    );
  });

  it("flattens a message smuggled in the tag block", () => {
    // The tag block spells ASCII in characters no reader sees; a whole hidden
    // sentence has to collapse to whitespace rather than ride along under the
    // visible text.
    const smuggled = Array.from("LAND")
      .map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0)))
      .join("");
    expect(renderOutlineHtml(`- ${smuggled}`)).toBe("");
  });

  it("lets no BMP code point survive as a line break", () => {
    let probe = "";
    for (let code = 0; code <= 0xffff; code++) {
      // Lone surrogates cannot appear in a decoded ClickHouse string.
      if (code >= 0xd800 && code <= 0xdfff) continue;
      probe += String.fromCharCode(code);
    }
    const block = renderOutlineHtml(`- ${probe}`);
    expect(block).not.toContain("\n");
    expect(block).not.toContain("\r");
  });
});

describe("sweep sentinels", () => {
  it("defuses a pending job count", () => {
    const block = renderOutlineHtml("- 3 Pending checks were still running");
    expect(block).toBe(
      `<ul><li><b>3 P${ZWSP}ending checks were still running</b></li></ul>`
    );
    expect(block).not.toMatch(SWEEP_PENDING_RE);
  });

  it("defuses a pending count inside a code span", () => {
    // The sweep greps the raw body, so a predicate inside <code> pins the PR
    // just as hard.
    expect(renderOutlineHtml("- `4 Pending` jobs")).toBe(
      `<ul><li><b><code>4 P${ZWSP}ending</code> jobs</b></li></ul>`
    );
  });

  it.each([
    ["greenlight", SENTINEL],
    ["advisor", ADVISOR_SENTINEL],
  ])(
    "cannot splice a pending count with the %s sentinel",
    (_name, sentinel) => {
      const block = renderOutlineHtml(`- 9 Pen${sentinel}ding jobs`);
      expectContained(block);
      expect(block).not.toContain("Pending");
      expect(block).not.toContain(sentinel);
    }
  );

  it.each([
    ["greenlight", SENTINEL],
    ["advisor", ADVISOR_SENTINEL],
  ])("never lets the %s sentinel through", (_name, sentinel) => {
    expect(renderOutlineHtml(`- ${sentinel}`)).not.toContain(sentinel);
  });

  it("cannot be tricked by a nested sentinel forgery", () => {
    const forged =
      'alt="Green alt="Green Light: in progress"Light: in progress"';
    expect(renderOutlineHtml(`- ${forged}`)).not.toContain(SENTINEL);
  });

  it("cannot build a pending count while defusing one", () => {
    expect(renderOutlineHtml("- 7 PenPendingding")).not.toContain("Pending");
  });
});

describe("reference guards", () => {
  it.each([
    ["mention", "@user", `@${ZWSP}user`],
    ["double mention", "@@double", `@${ZWSP}@${ZWSP}double`],
    ["issue", "#1234", `#${ZWSP}1234`],
    ["issue zero", "#0", `#${ZWSP}0`],
    ["gh", "GH-42", `GH-${ZWSP}42`],
    ["lowercase gh", "gh-42", `gh-${ZWSP}42`],
    ["title case gh", "Gh-42", `Gh-${ZWSP}42`],
    ["mixed case gh", "gH-42", `gH-${ZWSP}42`],
    ["bare sha", SHA, SPLIT_SHA],
    [
      "sha in a sentence",
      `landed as ${SHA} yesterday`,
      `landed as ${SPLIT_SHA} yesterday`,
    ],
    // A word character in Python and not here: `\b` would have guarded on one
    // side of the mirror only.
    ["sha after an accent", `caf${EACUTE}${SHA}`, `caf${EACUTE}${SPLIT_SHA}`],
  ])("guards a %s", (_name, message, expected) => {
    expect(renderOutlineHtml(`- ${message}`)).toBe(
      `<ul><li><b>${expected}</b></li></ul>`
    );
  });

  it("splits the sha run rather than prefixing it", () => {
    // A zero-width space is a non-word character, so one sitting in front of the
    // run leaves both `\b...\b` and `(?:^|\W)` matching the 40 intact hex digits
    // behind it.
    const body = renderOutlineHtml(`- ${SHA}`).slice(
      "<ul><li><b>".length,
      -"</b></li></ul>".length
    );
    expect(body).not.toBe(`${ZWSP}${SHA}`);
    expect(body).not.toContain(SHA);
    expect(body.split(ZWSP).join("")).toBe(SHA);
    expect(body.indexOf(ZWSP)).toBe(SHA_SPLIT_COLUMN);
  });

  it.each([
    ["ifdef", "#ifdef"],
    ["include", "#include <stdio.h>"],
    ["pragma", "#pragma once"],
    ["gh with a letter", "GH-x"],
    ["bare gh", "GH-"],
    ["39 hex", "a".repeat(39)],
    ["41 hex", "a".repeat(41)],
    ["sha with an alnum prefix", `z${SHA}`],
    ["sha with an alnum suffix", `${SHA}z`],
  ])("does not guard %s", (_name, message) => {
    expect(renderOutlineHtml(`- ${message}`)).not.toContain(ZWSP);
  });

  it("leaves a sha inside a code span intact", () => {
    // `code` is in GitHub's MentionFilter.IGNORE_PARENTS, and a zero-width space
    // here would corrupt the sha a reader copies out.
    expect(renderOutlineHtml(`- see \`${SHA}\` there`)).toBe(
      `<ul><li><b>see <code>${SHA}</code> there</b></li></ul>`
    );
  });

  it("leaves a mention inside a code span intact", () => {
    expect(renderOutlineHtml("- `@echo off`")).toBe(
      "<ul><li><b><code>@echo off</code></b></li></ul>"
    );
  });

  it.each([
    [
      "check mark",
      ":white_check_mark: APPROVED",
      `:${ZWSP}white_check_mark: APPROVED`,
    ],
    ["shipit", ":shipit:", `:${ZWSP}shipit:`],
    ["plus one", ":+1:", `:${ZWSP}+1:`],
    ["hyphenated name", ":e-mail:", `:${ZWSP}e-mail:`],
    ["mid word", "done:tada:now", `done:${ZWSP}tada:${ZWSP}now`],
    ["doubled colons", "::smile::", `::${ZWSP}smile::`],
    ["two shortcodes", ":a::b:", `:${ZWSP}a::${ZWSP}b:`],
  ])("stops an emoji shortcode rendering: %s", (_name, message, expected) => {
    // GitHub's EmojiFilter ignores pre, code and tt -- not li -- so an unguarded
    // shortcode draws a green tick beside a verdict only the renderer is trusted
    // to state.
    expect(renderOutlineHtml(`- ${message}`)).toBe(
      `<ul><li><b>${expected}</b></li></ul>`
    );
  });

  it.each([
    ["colon before a space", "Scope: one file"],
    ["colon between spaces", "the ratio is 3 : 1"],
    ["colon before a capital", "cast to Tensor:Long"],
    ["scheme separator", "https://hud.pytorch.org"],
    ["bare double colon", "::"],
  ])("leaves a colon that cannot open a shortcode alone: %s", (_n, message) => {
    // A name is lowercase and starts immediately after the colon, so nothing here
    // can open one -- and a zero-width space in ordinary prose is a character the
    // reader copies out unawares.
    expect(renderOutlineHtml(`- ${message}`)).not.toContain(ZWSP);
  });

  it("leaves an emoji shortcode inside a code span intact", () => {
    // `code` is one of the parents EmojiFilter ignores, so the span is already
    // inert, and a zero-width space here would corrupt what the reader copies out.
    expect(renderOutlineHtml("- `:shipit:`")).toBe(
      "<ul><li><b><code>:shipit:</code></b></li></ul>"
    );
  });

  it("fires the GH- guard on every occurrence", () => {
    // A missed GH- guard writes a permanent backlink onto an unrelated issue, so
    // one per leaf is not enough -- including the occurrences sitting between
    // escaped characters.
    expect(renderOutlineHtml('- GH-42 & "gh-7"')).toBe(
      `<ul><li><b>GH-${ZWSP}42 &amp; &quot;gh-${ZWSP}7&quot;</b></li></ul>`
    );
  });
});

describe("code spans", () => {
  it("round-trips a balanced span", () => {
    expect(renderOutlineHtml("- call `foo(bar)` now")).toBe(
      "<ul><li><b>call <code>foo(bar)</code> now</b></li></ul>"
    );
  });

  it("falls back to text on unbalanced backticks", () => {
    expect(renderOutlineHtml("- one ` backtick")).toBe(
      "<ul><li><b>one ` backtick</b></li></ul>"
    );
  });

  it("keeps a leaf that is only backticks as text", () => {
    expect(renderOutlineHtml("- ```")).toBe("<ul><li><b>```</b></li></ul>");
  });

  it("cannot close the block from inside a span", () => {
    const block = renderOutlineHtml("- `</code></li></ul></details>`");
    expect(block).toBe(
      "<ul><li><b><code>&lt;/code&gt;&lt;/li&gt;&lt;/ul&gt;&lt;/details&gt;</code></b></li></ul>"
    );
    expectContained(block);
  });

  it("does not split a backtick run", () => {
    expect(renderOutlineHtml("- ``a`b`` tail")).toBe(
      "<ul><li><b>``a`b`` tail</b></li></ul>"
    );
  });

  it("alternates several spans", () => {
    expect(renderOutlineHtml("- `a` and `b`")).toBe(
      "<ul><li><b><code>a</code> and <code>b</code></b></li></ul>"
    );
  });
});

// A bullet whose rendered `<li>` is exactly `itemLength` characters long. Each
// `"` escapes to the six characters of `&quot;`; each `x` stays one and is not
// hex, so it cannot join a sha guard. Spending as much of the length as possible
// on quotes keeps the leaf itself under the leaf cap, where nothing clips it.
function sizedTopic(itemLength: number): string {
  const body = itemLength - "<li><b></b></li>".length;
  return "- " + '"'.repeat(Math.floor(body / 6)) + "x".repeat(body % 6);
}

// A `topics`-bullet outline exactly `length` characters long, no leaf near the
// leaf cap.
function sizedMessage(length: number, topics: number): string {
  const body = length - (topics - 1) - topics * "- ".length;
  const base = Math.floor(body / topics);
  const spare = body % topics;
  return bullet(
    ...Array.from(
      { length: topics },
      (_v, index) => "- " + "x".repeat(base + (index < spare ? 1 : 0))
    )
  );
}

describe("bounds", () => {
  it("clamps the topic count", () => {
    const block = renderOutlineHtml(
      bullet(...Array.from({ length: 20 }, (_v, index) => `- topic ${index}`))
    );
    expect(countOf(block, "<li><b>")).toBe(OUTLINE_MAX_TOPICS);
    expect(block).toContain("topic 11");
    expect(block).not.toContain("topic 12");
    // A NO_LAND whose thirteenth bullet held the blocker must not read as a
    // complete list.
    expect(block.endsWith(`${OUTLINE_TRUNCATED_ITEM}</ul>`)).toBe(true);
  });

  it("does not mark exactly the topic clamp as truncated", () => {
    const block = renderOutlineHtml(
      bullet(
        ...Array.from(
          { length: OUTLINE_MAX_TOPICS },
          (_v, index) => `- topic ${index}`
        )
      )
    );
    expect(countOf(block, "<li><b>")).toBe(OUTLINE_MAX_TOPICS);
    expect(block).not.toContain(OUTLINE_TRUNCATED_ITEM);
  });

  it("clamps the detail count per topic", () => {
    const block = renderOutlineHtml(
      bullet(
        "- topic",
        ...Array.from({ length: 20 }, (_v, index) => `  - detail ${index}`)
      )
    );
    expect(countOf(block, "<li>detail")).toBe(OUTLINE_MAX_DETAILS);
    expect(block).toContain("detail 7");
    expect(block).not.toContain("detail 8");
    // The marker belongs inside the detail list: it is the details that were
    // dropped.
    expect(block.endsWith(`${OUTLINE_TRUNCATED_ITEM}</ul></li></ul>`)).toBe(
      true
    );
  });

  it("does not mark exactly the detail clamp as truncated", () => {
    const block = renderOutlineHtml(
      bullet(
        "- topic",
        ...Array.from(
          { length: OUTLINE_MAX_DETAILS },
          (_v, index) => `  - detail ${index}`
        )
      )
    );
    expect(countOf(block, "<li>detail")).toBe(OUTLINE_MAX_DETAILS);
    expect(block).not.toContain(OUTLINE_TRUNCATED_ITEM);
  });

  it("stops the emit at the block budget", () => {
    const block = renderOutlineHtml(
      bullet(...Array.from({ length: 10 }, () => "- " + '"'.repeat(390)))
    );
    expect(block.endsWith(`${OUTLINE_TRUNCATED_ITEM}</ul>`)).toBe(true);
    expect(countOf(block, "<li><b>")).toBeLessThan(10);
    expectContained(block);
  });

  it("keeps an item that exactly fills the budget", () => {
    // The boundary the emit loop turns on. Five of these reach the budget to the
    // character, so testing `>=` rather than `>` would silently drop the last
    // item that fits.
    const item = 2400;
    const topics = Math.floor(OUTLINE_BLOCK_BUDGET / item);
    const block = renderOutlineHtml(
      bullet(...Array.from({ length: topics + 1 }, () => sizedTopic(item)))
    );
    expect(countOf(block, "<li><b>")).toBe(topics);
    expect(block.length).toBe(
      OUTLINE_BLOCK_BUDGET + "<ul></ul>".length + OUTLINE_TRUNCATED_ITEM.length
    );
  });

  it("never emits a block over the budget", () => {
    // The last item used to be unbounded: the check ran before the append and
    // the increment after, so one maximally escaped topic could carry the block
    // past the budget by 9,000 characters.
    const ceiling =
      OUTLINE_BLOCK_BUDGET + "<ul></ul>".length + OUTLINE_TRUNCATED_ITEM.length;
    const quotes = '"'.repeat(OUTLINE_LEAF_CAP);
    const widest = bullet(
      ...Array.from({ length: OUTLINE_MAX_TOPICS }, () => `- ${quotes}`)
    );
    expect(renderOutlineHtml(widest).length).toBeLessThanOrEqual(ceiling);
    const deepest = bullet(
      `- ${quotes}`,
      ...Array.from({ length: OUTLINE_MAX_DETAILS }, () => `  - ${quotes}`)
    );
    expect(renderOutlineHtml(deepest).length).toBeLessThanOrEqual(ceiling);
  });

  it("hands the message to the fence when one item is over the budget", () => {
    // One topic with eight maximally escaped details is worth 21,000 characters
    // on its own. It is dropped rather than emitted, so the bound above holds
    // for every input -- and with nothing left but the marker there is no list to
    // post, so the caller falls through to the fence, where the reader gets the
    // message capped rather than a bare "(truncated)".
    const quotes = '"'.repeat(OUTLINE_LEAF_CAP);
    const deepest = bullet(
      `- ${quotes}`,
      ...Array.from({ length: OUTLINE_MAX_DETAILS }, () => `  - ${quotes}`)
    );
    expect(renderOutlineHtml(deepest)).toBe("");
  });

  it("does not mark a message within budget as truncated", () => {
    expect(renderOutlineHtml(bullet("- a", "- b"))).not.toContain(
      OUTLINE_TRUNCATED_ITEM
    );
  });

  it("does not mark a message exactly at the cap as truncated", () => {
    const block = renderOutlineHtml(sizedMessage(OUTLINE_MESSAGE_CAP, 10));
    expect(countOf(block, "<li><b>")).toBe(10);
    expect(block).not.toContain(OUTLINE_TRUNCATED_ITEM);
  });

  it("says the list is short when the message runs past the cap", () => {
    // The cap cuts the message before the first bullet is parsed, so no later
    // clamp can notice it: without this mark, a list missing whatever the reviewer
    // wrote past 4,000 characters -- and ending mid-sentence -- reads as the whole
    // verdict.
    const block = renderOutlineHtml(sizedMessage(OUTLINE_MESSAGE_CAP + 1, 10));
    // Neither of the clamps that already marked themselves fired here: ten topics
    // is under the clamp, and no leaf is long enough to be clipped.
    expect(countOf(block, "<li><b>")).toBe(10);
    expect(block).not.toContain(OUTLINE_TRUNCATION_SUFFIX);
    expect(block.endsWith(`${OUTLINE_TRUNCATED_ITEM}</ul>`)).toBe(true);
  });
});

// The fixture is generated from the Python implementation, which is the source
// of truth; both suites assert against it, so neither language can drift without
// the other's suite going red.
interface ParityCase {
  name: string;
  message: string;
  isOutline: boolean;
  html: string;
}

const PARITY_CASES: ParityCase[] = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "..",
      "..",
      "greenlight",
      "tests",
      "outline_parity_cases.json"
    ),
    "utf-8"
  )
);

describe("cross-language parity", () => {
  it("reads a non-empty fixture", () => {
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });

  it.each(PARITY_CASES.map((row): [string, ParityCase] => [row.name, row]))(
    "matches Python on %s",
    (_name, row) => {
      expect(isOutline(row.message)).toBe(row.isOutline);
      expect(renderOutlineHtml(row.message)).toBe(row.html);
    }
  );
});
