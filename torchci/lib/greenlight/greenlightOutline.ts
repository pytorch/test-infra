// Renders a model-authored verdict outline as a self-contained HTML bullet
// list, mirroring greenlight/src/greenlight/verdict_outline.py byte for byte --
// that one Python module against this one and greenlightReferenceGuards.ts
// together. Python is the source of truth; tests/test_verdict_outline.py scrapes
// the literals in both and a shared fixture pins the implementations to the same
// output for the same input.
//
// The reviewer writes `message` as a short markdown outline -- a few topic
// bullets, each with a few detail bullets. That text is attacker-influenceable
// (a PR diff can prompt-inject the reviewer) and it lands permanently on a
// public PR, so the rendering has to hold whatever the model was talked into
// writing.
//
// Containment is a CommonMark type-6 raw HTML block: a `<ul>` opening at column
// 0 with no blank line anywhere inside it. CommonMark runs no inline parsing
// inside such a block, which is what leaves `</details>`, `# heading`, `---`,
// `1.`, `[^1]`, `[x]: y`, code fences, `<script>`, `<img>` and attribute
// smuggling inert, and what stops bare URLs and email addresses autolinking --
// the last one is unreachable with markdown bullets, where even a fully
// backslash-escaped `a\-\@b\.co` still autolinks to `mailto:`. A blank line ends
// the block and hands the rest of the comment back to the markdown parser, so
// the single global invariant is that the returned block holds no line break at
// all; every other defence is per-leaf. `ul`, `ol`, `li`, `b` and `code` are all
// on GitHub's sanitizer allowlist.
//
// No pattern here uses a shorthand character class: JavaScript and Python
// disagree on `\s` (25 code points against 29; within ASCII, Python alone counts
// `U+001C`-`U+001F`, and each language counts one the other does not -- `U+FEFF`
// here, `U+0085` there), on `\d` (ASCII only against Unicode digits) and on
// `\b`/`\w` (an e-acute is a word character in Python and not here), so one
// shared shorthand renders two different comments from one row. Every character
// set is a single-line literal for that reason.

import {
  DIGITS,
  guardReferences,
} from "lib/greenlight/greenlightReferenceGuards";
import { defuseSweepSentinels } from "lib/greenlight/greenlightSweep";
import _ from "lodash";

// Same budget the fenced renderer caps on, applied before escaping: escaping
// inflates the text up to sixfold, so capping after it would let a sixth of a
// message through.
export const OUTLINE_MESSAGE_CAP = 4000;
export const OUTLINE_LEAF_CAP = 400;
export const OUTLINE_MAX_TOPICS = 12;
export const OUTLINE_MAX_DETAILS = 8;
// Nothing downstream bounds the body: lib/drciUtils.ts hands the whole Dr. CI
// comment to updateComment with no length guard, and this section is one part of
// that body. What ceiling GitHub enforces on it is not established -- Dr. CI
// comments well past 65,536 characters are live on pytorch/pytorch today. This is
// a bound greenlight puts on its own contribution, not a measured limit: the
// clamps above bound the block only after a worst-case escaping blowup.
export const OUTLINE_BLOCK_BUDGET = 12000;
export const OUTLINE_TRUNCATED_ITEM = "<li>(truncated)</li>";
export const OUTLINE_TRUNCATION_SUFFIX = "\u2026";
// One bullet-shaped line in a paragraph is not an outline. Routing a paragraph
// here would show the reader one leaf clipped to the leaf cap where the fenced
// renderer shows the whole message.
const OUTLINE_MIN_BULLETS = 2;

const OUTLINE_LINE_BREAKS = "\n\r";
const OUTLINE_HORIZONTAL_SPACE = " \t";
const OUTLINE_BULLET_MARKERS = "-*+";
const OUTLINE_ORDERED_TERMINATORS = ".)";
// Everything that can end the HTML block, hide text from a reader, or reorder
// what they see, in three groups. C0/C1 controls -- the line breaks among them
// -- plus DEL and the soft hyphen:
const OUTLINE_FLATTEN_CONTROL_CODEPOINTS = "0000-001F,007F,0080-009F,00AD";
// The bidi controls and isolates, the zero-width and word-joiner range, the line
// and paragraph separators, the deprecated shaping and digit-shape controls,
// interlinear annotation, the Egyptian and shorthand format controls,
// musical-notation controls, and the whole tag and variation-selector-supplement
// block:
const OUTLINE_FLATTEN_FORMAT_CODEPOINTS =
  "061C,200B-200F,2028-202E,2060-2064,2066-2069,206A-206F,FFF9-FFFB,13430-1343F,1BCA0-1BCA3,1D173-1D17A,E0000-E0FFF";
// And the characters that occupy space while showing nothing: the combining
// grapheme joiner, the Hangul fillers, the inherent Khmer vowels, the Mongolian
// vowel separator and its free variation selectors, braille blank, variation
// selectors, BOM, object replacement.
const OUTLINE_FLATTEN_BLANK_CODEPOINTS =
  "034F,115F,1160,17B4-17B5,180B-180F,2800,3164,FE00-FE0F,FEFF,FFA0,FFFC";
const OUTLINE_FLATTEN_CODEPOINTS = `${OUTLINE_FLATTEN_CONTROL_CODEPOINTS},${OUTLINE_FLATTEN_FORMAT_CODEPOINTS},${OUTLINE_FLATTEN_BLANK_CODEPOINTS}`;

// Turns a "0000-001F,007F" range spec into a regex character class. The `u` flag
// its user carries is what makes the astral bounds legal and match by code
// point rather than by surrogate half.
function codepointClass(spec: string): string {
  const parts = spec.split(",").map((entry) =>
    entry
      .split("-")
      .map((bound) => `\\u{${bound}}`)
      .join("-")
  );
  return `[${parts.join("")}]`;
}

const BULLET_PREFIX_RE = new RegExp(
  `^([${OUTLINE_HORIZONTAL_SPACE}]*)` +
    `(?:[${OUTLINE_BULLET_MARKERS}]|[${DIGITS}]+[${OUTLINE_ORDERED_TERMINATORS}])` +
    `[${OUTLINE_HORIZONTAL_SPACE}]+`
);
const FLATTEN_RE = new RegExp(codepointClass(OUTLINE_FLATTEN_CODEPOINTS), "gu");
const SPACE_RUN_RE = / +/g;
const BACKTICK_RUN_RE = /`+/;

interface Leaf {
  depth: number;
  text: string;
}

interface Topic {
  text: string;
  details: string[];
}

// Python slices and measures in code points; a UTF-16 slice would count an
// astral character twice, cut a surrogate pair in half, and trip the block
// budget at a different leaf. A string's UTF-16 length is never below its
// code-point count, so one at or under the limit by that measure is under it by
// this one too and needs no split: every stored message but a pathological one
// takes that branch, and the rest of each caller's work is linear in the text
// either way.
export function capCodePoints(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit).join("");
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

// Python's str.strip(" "): ASCII space only, both ends. A space is never half of
// a surrogate pair, so indexing by UTF-16 unit cannot split one.
function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === " ") start += 1;
  while (end > start && text[end - 1] === " ") end -= 1;
  return text.slice(start, end);
}

function isHorizontalSpaceOnly(line: string): boolean {
  for (const char of line) {
    if (!OUTLINE_HORIZONTAL_SPACE.includes(char)) return false;
  }
  return true;
}

function splitLines(text: string): string[] {
  return text.split("\r\n").join("\n").split("\r").join("\n").split("\n");
}

// A bullet line's leading indent and the text after its marker, or null.
function bulletBody(line: string): [string, string] | null {
  const match = BULLET_PREFIX_RE.exec(line);
  if (match === null) return null;
  return [match[1], line.slice(match[0].length)];
}

// Whether `message` is a bullet outline rather than the fenced prose paragraph.
// Deliberately conservative, for two reasons that hold independently. Nothing
// enforces the outline shape, so a paragraph is a valid verdict and belongs on
// the fence; and no row stored before the outline format existed carries a bullet
// marker at all, so every one of them stays there too. It reads the same message
// cap the renderer does, so a bullet the renderer never sees cannot decide which
// renderer runs.
export function isOutline(message: string): boolean {
  let bullets = 0;
  for (const line of splitLines(capCodePoints(message, OUTLINE_MESSAGE_CAP))) {
    const body = bulletBody(line);
    if (body !== null && body[1] !== "") {
      bullets += 1;
      if (bullets >= OUTLINE_MIN_BULLETS) return true;
    }
  }
  return false;
}

// Collapses one leaf to a single line of visible text, marking it when the cap
// clips it. Substitutes a space for each stripped character instead of deleting
// it: a deletion splices what sat either side together, and
// `9 Pen<stripped>ding` re-forms into a live `9 Pending` -- one of the predicates
// that pins a PR into Dr. CI's re-render sweep forever.
function flatten(text: string): string {
  const substituted = text.replace(FLATTEN_RE, " ");
  const collapsed = trimSpaces(substituted.replace(SPACE_RUN_RE, " "));
  if (codePointLength(collapsed) <= OUTLINE_LEAF_CAP) return collapsed;
  return capCodePoints(collapsed, OUTLINE_LEAF_CAP) + OUTLINE_TRUNCATION_SUFFIX;
}

function readLeaves(message: string): Leaf[] {
  const parsed = splitLines(capCodePoints(message, OUTLINE_MESSAGE_CAP)).map(
    (line): [string, [string, string] | null] => [line, bulletBody(line)]
  );
  // Depth is relative to the shallowest bullet in the message. A model that
  // indents the whole outline still means its outermost bullets as topics, and
  // against an absolute threshold every one of them would read as a detail of
  // whichever leaf happened to come first.
  const indents = parsed.flatMap(([, body]) =>
    body === null ? [] : [body[0].length]
  );
  const baseline = indents.length > 0 ? Math.min(...indents) : 0;
  const leaves: Leaf[] = [];
  let wrapping = false;
  for (const [line, body] of parsed) {
    if (body !== null) {
      const [indent, text] = body;
      leaves.push({ depth: indent.length > baseline ? 1 : 0, text });
      wrapping = true;
      continue;
    }
    if (isHorizontalSpaceOnly(line)) {
      // The one unambiguous signal that what follows is not a wrap of the
      // bullet above.
      wrapping = false;
      continue;
    }
    if (wrapping) {
      // A model wrapping a long detail across lines means the continuation to
      // be part of the bullet above it, so join rather than promote it to a
      // bullet of its own.
      const last = leaves[leaves.length - 1];
      last.text = `${last.text} ${line}`;
      continue;
    }
    leaves.push({ depth: 0, text: line });
    wrapping = true;
  }
  return leaves;
}

// Groups flattened leaves into topics, promoting every detail that has no topic
// above it. Promotion covers two cases with one rule: nested bullets the model
// wrote before any top-level one, and details whose topic was dropped for
// flattening to nothing. It runs until a real topic appears rather than once,
// because orphans are peers of each other -- making the second one a detail of
// the first asserts a relationship the reviewer never wrote. Dropping them
// instead would silently discard text the reader was meant to see.
function group(leaves: Leaf[]): Topic[] {
  const topics: Topic[] = [];
  let seenTopic = false;
  for (const leaf of leaves) {
    if (leaf.depth === 0 || !seenTopic) {
      topics.push({ text: leaf.text, details: [] });
      seenTopic = seenTopic || leaf.depth === 0;
      continue;
    }
    topics[topics.length - 1].details.push(leaf.text);
  }
  return topics;
}

// HTML-escape, matching Python's html.escape(text, quote=True) byte for byte.
// The two escape the same five characters and differ only on the apostrophe
// entity. `&#x27;` is the form both sides settle on because the alternative,
// lodash's `&#39;`, carries a `#` followed by a digit -- which the reference
// guard below would then split, turning every apostrophe in the message into a
// visible, broken entity.
function escape(text: string): string {
  return _.escape(text).split("&#39;").join("&#x27;");
}

// Splits a leaf into alternating text and code-span segments, text first. An odd
// number of backtick runs means the spans do not close, so the whole leaf goes
// out as one text segment: backticks carry no meaning inside a raw HTML block,
// so an unpaired run renders as itself rather than opening something that never
// ends.
function segments(leaf: string): string[] {
  const parts = leaf.split(BACKTICK_RUN_RE);
  if ((parts.length - 1) % 2 === 1) return [leaf];
  return parts;
}

function leafHtml(leaf: string): string {
  const rendered: string[] = [];
  segments(leaf).forEach((segment, index) => {
    const defused = defuseSweepSentinels(escape(segment));
    rendered.push(
      index % 2 === 1 ? `<code>${defused}</code>` : guardReferences(defused)
    );
  });
  return rendered.join("");
}

function topicHtml(topic: Topic): string {
  const parts = [`<li><b>${leafHtml(topic.text)}</b>`];
  const details = topic.details.slice(0, OUTLINE_MAX_DETAILS);
  if (details.length > 0) {
    parts.push("<ul>");
    for (const detail of details) parts.push(`<li>${leafHtml(detail)}</li>`);
    if (topic.details.length > OUTLINE_MAX_DETAILS) {
      parts.push(OUTLINE_TRUNCATED_ITEM);
    }
    parts.push("</ul>");
  }
  parts.push("</li>");
  return parts.join("");
}

function assertContained(block: string): void {
  for (const char of OUTLINE_LINE_BREAKS) {
    if (block.includes(char)) {
      throw new Error(
        "verdict outline holds a line break, which would end the HTML block"
      );
    }
  }
  const opens = block.split("<code>").length - 1;
  const closes = block.split("</code>").length - 1;
  if (opens !== closes) {
    throw new Error("verdict outline has unbalanced <code> tags");
  }
}

// Renders `message` as one contiguous HTML bullet list, or "" if it produces no
// item. Two inputs produce none: one whose every leaf flattened away, and one
// whose first item alone overruns the budget, where a marker is all that would be
// left. Both send the message out fenced, which shows the reader the text capped
// rather than an empty section or a bare marker. Every clamp that drops text
// marks itself: a clipped leaf ends in an ellipsis, and a dropped topic, detail,
// over-budget item or over-cap tail leaves a truncation item behind, so a reader
// can never mistake a cut list for a complete one.
export function renderOutlineHtml(message: string): string {
  const flattened = readLeaves(message).map((leaf) => ({
    depth: leaf.depth,
    text: flatten(leaf.text),
  }));
  const topics = group(flattened.filter((leaf) => leaf.text !== ""));
  if (topics.length === 0) return "";

  const items: string[] = [];
  let used = 0;
  // A message past the cap was cut before the first leaf was read, so the list is
  // short whatever the topic count says. The length test mirrors capCodePoints:
  // a UTF-16 length at or under the cap is under it by code points too.
  let truncated =
    topics.length > OUTLINE_MAX_TOPICS ||
    (message.length > OUTLINE_MESSAGE_CAP &&
      codePointLength(message) > OUTLINE_MESSAGE_CAP);
  for (const topic of topics.slice(0, OUTLINE_MAX_TOPICS)) {
    const item = topicHtml(topic);
    // Measured before the append, not after: testing the running total alone
    // leaves whichever item crosses the budget unbounded, and one maximally
    // escaped item is worth 21,000 bytes.
    if (used + codePointLength(item) > OUTLINE_BLOCK_BUDGET) {
      truncated = true;
      break;
    }
    items.push(item);
    used += codePointLength(item);
  }
  if (truncated) items.push(OUTLINE_TRUNCATED_ITEM);
  if (items.length === 1 && items[0] === OUTLINE_TRUNCATED_ITEM) return "";

  const block = `<ul>${items.join("")}</ul>`;
  assertContained(block);
  return block;
}
