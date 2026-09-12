r"""Render a model-authored verdict outline as a self-contained HTML bullet list.

The reviewer writes ``message`` as a short markdown outline -- a few topic bullets, each with
a few detail bullets. That text is attacker-influenceable (a PR diff can prompt-inject the
reviewer) and it lands permanently on a public PR, so the rendering has to hold whatever the
model was talked into writing.

Containment takes two defences answering two shapes of injection, and neither covers the other.
Escaping each leaf answers the HTML shapes -- ``</details>``, ``<script>``, ``<img>``, attribute
smuggling -- and holds wherever the leaf ends up. The markdown shapes are answered by a CommonMark
type-6 raw HTML block: a ``<ul>`` opening at column 0 with no blank line anywhere inside it, within
which CommonMark runs no inline parsing, leaving ``# heading``, ``---``, ``1.``, ``[^1]``,
``[x]: y``, ``[text](url)``, ``![alt](src)``, code fences and emphasis inert and stopping bare URLs
and email addresses autolinking -- the last one unreachable with markdown bullets, where even a
fully backslash-escaped ``a\-\@b\.co`` still autolinks to ``mailto:``. ``html.escape`` touches
``& < > " '`` and nothing else, so all of those markdown shapes reach the comment verbatim and the
block is the only thing holding them. A blank line ends the block and hands the rest of the comment
back to the markdown parser, so the single global invariant is that the returned block holds no
line break at all; every other defence is per-leaf. ``ul``, ``ol``, ``li``, ``b`` and ``code`` are
all on GitHub's sanitizer allowlist.

``torchci/lib/greenlight/greenlightOutline.ts`` renders the same message into the Dr. CI comment
and has to produce byte-identical output. That is why no pattern here uses a shorthand character
class: Python and JavaScript disagree on ``\s`` (29 code points against 25; within ASCII, Python
alone counts ``U+001C``-``U+001F``, and each language counts one the other does not -- ``U+0085``
here, ``U+FEFF`` there), on ``\d`` (Unicode digits against ASCII only) and on ``\b``/``\w`` (an
e-acute is a word character in Python and not in JavaScript), so one shared shorthand renders two
different comments from one row. Every character set below is a single-line literal for that
reason: the drift test scrapes both files and compares the literals.

The mirror is not symmetrical. That module also exports a parse layer with no counterpart here --
``parseOutline`` and the ``OutlineSegment``, ``OutlineTopic`` and ``ParsedOutline`` shapes it
returns -- feeding the HUD's Green Light panel, which builds DOM nodes rather than markup. Every
clamp acting on structure sits in that layer there, where this module applies the topic clamp in
``render_outline_html``, the detail clamp in ``_topic_html`` and the code-span split in
``_leaf_html``. The gates compare finished HTML and scraped literals, so neither sees where either
side computes it.
"""

from __future__ import annotations

import html
import re
from typing import NamedTuple

__all__ = ["is_outline", "render_outline_html"]

# Same budget the fenced renderer caps on, applied before escaping: escaping inflates the text up
# to sixfold, so capping after it would let a sixth of a message through.
MESSAGE_CAP = 4000
LEAF_CAP = 400
MAX_TOPICS = 12
MAX_DETAILS = 8
# Nothing downstream bounds the body: torchci/lib/drciUtils.ts hands the whole Dr. CI comment to
# updateComment with no length guard, and this section is one part of that body. What ceiling
# GitHub enforces on it is not established -- Dr. CI comments well past 65,536 characters are live
# on pytorch/pytorch today. This is a bound greenlight puts on its own contribution, not a measured
# limit: the clamps above bound the block only after a worst-case escaping blowup.
BLOCK_BUDGET = 12000
TRUNCATED_ITEM = "<li>(truncated)</li>"
TRUNCATION_SUFFIX = "\u2026"
# One bullet-shaped line in a paragraph is not an outline. Routing a paragraph here would show the
# reader one leaf clipped to LEAF_CAP where the fenced renderer shows the whole message.
MIN_BULLETS = 2
SHA_LENGTH = 40
SHA_SPLIT_COLUMN = 20

ZERO_WIDTH_SPACE = "\u200b"
LINE_BREAKS = "\n\r"
HORIZONTAL_SPACE = " \t"
BULLET_MARKERS = "-*+"
ORDERED_TERMINATORS = ".)"
DIGITS = "0-9"
HEX_DIGITS = "0-9a-fA-F"
ALPHANUMERIC = "0-9A-Za-z"
# What GitHub accepts between the two colons of an emoji shortcode. Every name in its set is
# lowercase, so an uppercase letter cannot be part of one.
SHORTCODE_CHARACTERS = "a-z0-9_+-"
# Everything that can end the HTML block, hide text from a reader, or reorder what they see, in
# three groups. C0/C1 controls -- the line breaks among them -- plus DEL and the soft hyphen:
FLATTEN_CONTROL_CODEPOINTS = "0000-001F,007F,0080-009F,00AD"
# The bidi controls and isolates, the zero-width and word-joiner range, the line and paragraph
# separators, the deprecated shaping and digit-shape controls, interlinear annotation, the
# Egyptian and shorthand format controls, musical-notation controls, and the whole tag and
# variation-selector-supplement block:
FLATTEN_FORMAT_CODEPOINTS = (
    "061C,200B-200F,2028-202E,2060-2064,2066-2069,206A-206F,FFF9-FFFB,13430-1343F,1BCA0-1BCA3,1D173-1D17A,E0000-E0FFF"
)
# And the characters that occupy space while showing nothing: the combining grapheme joiner, the
# Hangul fillers, the inherent Khmer vowels, the Mongolian vowel separator and its free variation
# selectors, braille blank, variation selectors, BOM, object replacement.
FLATTEN_BLANK_CODEPOINTS = "034F,115F,1160,17B4-17B5,180B-180F,2800,3164,FE00-FE0F,FEFF,FFA0,FFFC"
FLATTEN_CODEPOINTS = f"{FLATTEN_CONTROL_CODEPOINTS},{FLATTEN_FORMAT_CODEPOINTS},{FLATTEN_BLANK_CODEPOINTS}"

# Re-declared from torchci/lib/greenlight/greenlightSweep.ts and lib/advisor/advisorBadge.ts
# rather than imported, for the one reason nothing can fix: Python cannot import TypeScript. The
# drift test scrapes both files and fails when a value there moves apart from the one here.
GREENLIGHT_PENDING_ALT_ATTR = 'alt="Green Light: in progress"'
ADVISOR_PENDING_ALT_ATTR = 'alt="AI verdict: pending"'
SWEEP_SENTINELS = (GREENLIGHT_PENDING_ALT_ATTR, ADVISOR_PENDING_ALT_ATTR)
SWEEP_PENDING_WORD = "Pending"
SWEEP_PENDING_WORD_DEFUSED = "P" + ZERO_WIDTH_SPACE + "ending"


def _codepoint_class(spec: str) -> str:
    """Turn a ``"0000-001F,007F"`` range spec into a regex character class."""
    parts = ["-".join(f"\\U{bound.zfill(8)}" for bound in entry.split("-")) for entry in spec.split(",")]
    return "[" + "".join(parts) + "]"


_BULLET_PREFIX_RE = re.compile(
    f"^([{HORIZONTAL_SPACE}]*)(?:[{BULLET_MARKERS}]|[{DIGITS}]+[{ORDERED_TERMINATORS}])[{HORIZONTAL_SPACE}]+"
)
_FLATTEN_RE = re.compile(_codepoint_class(FLATTEN_CODEPOINTS))
_SPACE_RUN_RE = re.compile(" +")
_BACKTICK_RUN_RE = re.compile("`+")
_HASH_REF_RE = re.compile(f"#(?=[{DIGITS}])")
_GH_REF_RE = re.compile(f"([gG][hH]-)(?=[{DIGITS}])")
_SHORTCODE_RE = re.compile(f":(?=[{SHORTCODE_CHARACTERS}])")
# Lookarounds rather than \b, which disagrees across the two languages on any non-ASCII letter.
_SHA_RE = re.compile(
    f"(?<![{ALPHANUMERIC}])([{HEX_DIGITS}]{{{SHA_SPLIT_COLUMN}}})"
    f"([{HEX_DIGITS}]{{{SHA_LENGTH - SHA_SPLIT_COLUMN}}})(?![{ALPHANUMERIC}])"
)


class _Leaf(NamedTuple):
    depth: int
    text: str


class _Topic(NamedTuple):
    text: str
    details: list[str]


def _split_lines(text: str) -> list[str]:
    return text.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _bullet_body(line: str) -> tuple[str, str] | None:
    """Split a bullet line into its leading indent and the text after the marker."""
    match = _BULLET_PREFIX_RE.match(line)
    if match is None:
        return None
    return match.group(1), line[match.end() :]


def is_outline(message: str) -> bool:
    """Whether ``message`` is a bullet outline rather than the fenced prose paragraph.

    Deliberately conservative, for two reasons that hold independently. Nothing enforces the
    outline shape, so a paragraph is a valid verdict and belongs on the fence; and no row stored
    before the outline format existed carries a bullet marker at all, so every one of them stays
    there too. It reads the same ``MESSAGE_CAP`` prefix the renderer does, so a bullet the
    renderer never sees cannot decide which renderer runs.
    """
    bullets = 0
    for line in _split_lines(message[:MESSAGE_CAP]):
        body = _bullet_body(line)
        if body is not None and body[1] != "":
            bullets += 1
            if bullets >= MIN_BULLETS:
                return True
    return False


def _flatten(text: str) -> str:
    """Collapse one leaf to a single line of visible text, marking it when the cap clips it.

    Substitutes a space for each stripped character instead of deleting it. A deletion splices
    what sat either side together, and ``9 Pen<stripped>ding`` re-forms into a live ``9 Pending``
    -- one of the predicates that pins a PR into Dr. CI's re-render sweep forever.
    """
    substituted = _FLATTEN_RE.sub(" ", text)
    collapsed = _SPACE_RUN_RE.sub(" ", substituted).strip(" ")
    if len(collapsed) <= LEAF_CAP:
        return collapsed
    return collapsed[:LEAF_CAP] + TRUNCATION_SUFFIX


def _leaves(message: str) -> list[_Leaf]:
    parsed = [(line, _bullet_body(line)) for line in _split_lines(message[:MESSAGE_CAP])]
    # Depth is relative to the shallowest bullet in the message. A model that indents the whole
    # outline still means its outermost bullets as topics, and against an absolute threshold every
    # one of them would read as a detail of whichever leaf happened to come first.
    baseline = min((len(body[0]) for _, body in parsed if body is not None), default=0)
    leaves: list[_Leaf] = []
    wrapping = False
    for line, body in parsed:
        if body is not None:
            indent, text = body
            leaves.append(_Leaf(depth=1 if len(indent) > baseline else 0, text=text))
            wrapping = True
            continue
        if line.strip(HORIZONTAL_SPACE) == "":
            # The one unambiguous signal that what follows is not a wrap of the bullet above.
            wrapping = False
            continue
        if wrapping:
            # A model wrapping a long detail across lines means the continuation to be part of
            # the bullet above it, so join rather than promote it to a bullet of its own.
            leaves[-1] = leaves[-1]._replace(text=f"{leaves[-1].text} {line}")
            continue
        leaves.append(_Leaf(depth=0, text=line))
        wrapping = True
    return leaves


def _group(leaves: list[_Leaf]) -> list[_Topic]:
    """Group flattened leaves into topics, dropping the ones that flattened to nothing.

    The drop belongs here rather than ahead of the grouping because it destroys the one thing the
    grouping needs. A top-level bullet whose text flattens away is still a boundary the reviewer
    wrote, and dropping it first leaves everything below reading as though it never existed --
    which renders a ``NO_LAND`` detail as evidence for whichever unrelated topic came before it.

    A detail with no topic to attach to is promoted: dropping it would silently discard text the
    reader was meant to see, and adopting it would assert a relationship the reviewer never wrote.
    Promotion never turns the promoted leaf into a parent for the details behind it, because peers
    stay peers. Two details are siblings whether they were written before the first top-level
    bullet or under one whose text flattened away, and subordinating the second to the first
    invents a parent and child out of two of the reviewer's own claims -- permanently, in public,
    and it is the exact relationship promotion exists to prevent.
    """
    topics: list[_Topic] = []
    attachable = False
    for leaf in leaves:
        if leaf.depth == 0:
            attachable = leaf.text != ""
            if attachable:
                topics.append(_Topic(text=leaf.text, details=[]))
            continue
        if leaf.text == "":
            continue
        if attachable:
            topics[-1].details.append(leaf.text)
            continue
        topics.append(_Topic(text=leaf.text, details=[]))
    return topics


def _escape(text: str) -> str:
    """HTML-escape, matching lodash's ``_.escape`` byte for byte.

    Python and lodash escape the same five characters and differ only on the apostrophe entity.
    ``&#x27;`` is the form both sides settle on because the alternative, ``&#39;``, carries a
    ``#`` followed by a digit -- which the reference guard below would then split, turning every
    apostrophe in the message into a visible, broken entity.
    """
    return html.escape(text, quote=True)


def _defuse_sweep(text: str) -> str:
    """Break the literals Dr. CI's re-render sweep greps a comment body for.

    The sweep reads Dr. CI's own comment and nothing else -- its query filters on that bot's login
    and on a ``<!-- drci-comment-start -->`` body prefix -- so a comment greenlight posts is never
    a candidate. This runs on the Python side anyway because the TypeScript mirror renders the
    same row into that comment, and the two have to emit the same bytes.

    Applied to code spans too: the sweep matches the body, not the rendered HTML, so a predicate
    inside a ``<code>`` pins the PR just as hard as one in prose. Substituting a zero-width space
    for each sentinel rather than deleting it is what makes a single pass enough -- no sentinel
    contains that character, so neither a nested forgery nor two sentinels spliced across the gap
    left by removing a third can reassemble.

    Both sentinels are spelled with ``"``, which ``_escape`` has already turned into ``&quot;`` by
    the time the render path reaches here, so the loop matches nothing and the ``Pending``
    substitution is the pass that fires. The loop stays as cover for a predicate spelled without
    a quote, and for callers that hand this raw text.
    """
    out = text
    for sentinel in SWEEP_SENTINELS:
        out = out.replace(sentinel, ZERO_WIDTH_SPACE)
    return out.replace(SWEEP_PENDING_WORD, SWEEP_PENDING_WORD_DEFUSED)


def _guard_references(text: str) -> str:
    """Stop GitHub turning the text into a mention, a cross-reference, a backlink, or an emoji.

    The sha guard splits the run rather than prefixing it. A zero-width space is a non-word
    character, so a prefixed one leaves both anchor styles GitHub's filters use -- ``\\b...\\b``
    and ``(?:^|\\W)`` -- matching the untouched 40 hex digits behind it.

    Text segments only, which is safe for two separate reasons. ``code`` is in GitHub's
    MentionFilter.IGNORE_PARENTS, so a code span raises no mention in the rendered comment; and
    pytorchbot reads the RAW body, matching ``^ *@pytorch(merge|)bot .+$`` per line (see
    torchci/lib/bot/cliParser.ts), which nothing here can satisfy while the whole block is one
    line opening ``<ul><li><b>``. Pretty-printing this block across several lines would make that
    second reason false. A zero-width space inside a span corrupts a path or a sha the reader
    copies out.
    """
    out = text.replace("@", "@" + ZERO_WIDTH_SPACE)
    # Bare `#` is left alone so `#ifdef`, `#include` and `#pragma` survive intact.
    out = _HASH_REF_RE.sub("#" + ZERO_WIDTH_SPACE, out)
    out = _GH_REF_RE.sub(r"\1" + ZERO_WIDTH_SPACE, out)
    # GitHub's EmojiFilter skips `pre`, `code` and `tt` -- not `li` -- so `:white_check_mark:` in a
    # bullet renders as a green tick the reviewer never drew. Only the opening colon needs breaking:
    # a name cannot start anywhere but immediately after one.
    out = _SHORTCODE_RE.sub(":" + ZERO_WIDTH_SPACE, out)
    return _SHA_RE.sub(r"\1" + ZERO_WIDTH_SPACE + r"\2", out)


def _segments(leaf: str) -> list[str]:
    """Split a leaf into alternating text and code-span segments, text first.

    An odd number of backtick runs means the spans do not close, so the whole leaf goes out as one
    text segment: backticks carry no meaning inside a raw HTML block, so an unpaired run renders
    as itself rather than opening something that never ends.
    """
    parts = _BACKTICK_RUN_RE.split(leaf)
    if (len(parts) - 1) % 2 == 1:
        return [leaf]
    return parts


def _leaf_html(leaf: str) -> str:
    rendered: list[str] = []
    for index, segment in enumerate(_segments(leaf)):
        defused = _defuse_sweep(_escape(segment))
        if index % 2 == 1:
            rendered.append(f"<code>{defused}</code>")
        else:
            rendered.append(_guard_references(defused))
    return "".join(rendered)


def _topic_html(topic: _Topic) -> str:
    parts = [f"<li><b>{_leaf_html(topic.text)}</b>"]
    details = topic.details[:MAX_DETAILS]
    if details:
        parts.append("<ul>")
        parts += [f"<li>{_leaf_html(detail)}</li>" for detail in details]
        if len(topic.details) > MAX_DETAILS:
            parts.append(TRUNCATED_ITEM)
        parts.append("</ul>")
    parts.append("</li>")
    return "".join(parts)


def _assert_contained(block: str) -> None:
    if any(char in block for char in LINE_BREAKS):
        raise RuntimeError("verdict outline holds a line break, which would end the HTML block")
    if block.count("<code>") != block.count("</code>"):
        raise RuntimeError("verdict outline has unbalanced <code> tags")


def render_outline_html(message: str) -> str:
    """Render ``message`` as one contiguous HTML bullet list, or ``""`` if it produces no item.

    Two inputs produce none: one whose every leaf flattened away, and one whose first item alone
    overruns the budget, where a marker is all that would be left. Both send the message out
    fenced, which shows the reader the text capped rather than an empty section or a bare marker.
    Every clamp that drops text marks itself: a clipped leaf ends in an ellipsis, and a dropped
    topic, detail, over-budget item or over-cap tail leaves a truncation item behind, so a reader
    can never mistake a cut list for a complete one.
    """
    topics = _group([leaf._replace(text=_flatten(leaf.text)) for leaf in _leaves(message)])
    if not topics:
        return ""

    items: list[str] = []
    used = 0
    # A message past the cap was cut before the first leaf was read, so the list is short whatever
    # the topic count says.
    truncated = len(topics) > MAX_TOPICS or len(message) > MESSAGE_CAP
    for topic in topics[:MAX_TOPICS]:
        item = _topic_html(topic)
        # Measured before the append, not after: testing the running total alone leaves whichever
        # item crosses the budget unbounded, and one maximally escaped item is worth 21,000 bytes.
        if used + len(item) > BLOCK_BUDGET:
            truncated = True
            break
        items.append(item)
        used += len(item)
    if truncated:
        items.append(TRUNCATED_ITEM)
    if items == [TRUNCATED_ITEM]:
        return ""

    block = "<ul>" + "".join(items) + "</ul>"
    _assert_contained(block)
    return block
