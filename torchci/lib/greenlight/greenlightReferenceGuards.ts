// Breaks the tokens GitHub's post-render filters would turn into something the
// reviewer never wrote -- a mention, a cross-reference, a commit backlink, an
// emoji -- by splicing a zero-width space into each one.
//
// Called on every text segment of every leaf by greenlightOutline.ts, and needing
// nothing back from it, so the two sit one above the other rather than beside
// each other. greenlight/src/greenlight/verdict_outline.py holds the Python half
// of all of this in one module; the drift test scrapes the literals below from
// here.
//
// No pattern here uses a shorthand character class, for the reason set out at the
// top of greenlightOutline.ts: JavaScript and Python disagree on what `\s`, `\d`,
// `\w` and `\b` match, so one shared shorthand renders two different comments
// from one stored row. Every character set is a single-line literal for that
// reason.

import { ZERO_WIDTH_SPACE } from "lib/greenlight/greenlightSweep";

// greenlightOutline.ts reads this same class for the ordered-list bullet marker:
// one written-out set, so the marker and the reference guards cannot drift onto
// different definitions of a digit.
export const DIGITS = "0-9";
const HEX_DIGITS = "0-9a-fA-F";
const ALPHANUMERIC = "0-9A-Za-z";
// What GitHub accepts between the two colons of an emoji shortcode. Every name in
// its set is lowercase, so an uppercase letter cannot be part of one.
const SHORTCODE_CHARACTERS = "a-z0-9_+-";
const SHA_LENGTH = 40;
export const SHA_SPLIT_COLUMN = 20;

const HASH_REF_RE = new RegExp(`#(?=[${DIGITS}])`, "g");
const GH_REF_RE = new RegExp(`([gG][hH]-)(?=[${DIGITS}])`, "g");
const SHORTCODE_RE = new RegExp(`:(?=[${SHORTCODE_CHARACTERS}])`, "g");
// Lookarounds rather than \b, which disagrees across the two languages on any
// non-ASCII letter.
const SHA_RE = new RegExp(
  `(?<![${ALPHANUMERIC}])` +
    `([${HEX_DIGITS}]{${SHA_SPLIT_COLUMN}})` +
    `([${HEX_DIGITS}]{${SHA_LENGTH - SHA_SPLIT_COLUMN}})(?![${ALPHANUMERIC}])`,
  "g"
);

// The sha guard splits the run rather than prefixing it. A zero-width space is a
// non-word character, so a prefixed one leaves both anchor styles GitHub's
// filters use -- `\b...\b` and `(?:^|\W)` -- matching the untouched 40 hex
// digits behind it.
//
// Run over text segments only, which is safe for two separate reasons. `code` is
// in GitHub's MentionFilter.IGNORE_PARENTS, so a code span raises no mention in
// the rendered comment; and pytorchbot reads the RAW body, matching
// `^ *@pytorch(merge|)bot .+$` per line (see lib/bot/cliParser.ts), which nothing
// here can satisfy while the whole block is one line opening `<ul><li><b>`.
// Pretty-printing that block across several lines would make the second reason
// false. A zero-width space inside a span corrupts a path or a sha the reader
// copies out.
export function guardReferences(text: string): string {
  let out = text.split("@").join(`@${ZERO_WIDTH_SPACE}`);
  // Bare `#` is left alone so `#ifdef`, `#include` and `#pragma` survive intact.
  out = out.replace(HASH_REF_RE, `#${ZERO_WIDTH_SPACE}`);
  out = out.replace(GH_REF_RE, `$1${ZERO_WIDTH_SPACE}`);
  // GitHub's EmojiFilter skips `pre`, `code` and `tt` -- not `li` -- so
  // `:white_check_mark:` in a bullet renders as a green tick the reviewer never
  // drew. Only the opening colon needs breaking: a name cannot start anywhere but
  // immediately after one.
  out = out.replace(SHORTCODE_RE, `:${ZERO_WIDTH_SPACE}`);
  return out.replace(SHA_RE, `$1${ZERO_WIDTH_SPACE}$2`);
}
