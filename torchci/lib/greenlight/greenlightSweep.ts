// The literals Dr.CI's re-render sweep greps a comment body for, and the single
// pass that breaks them. drci.ts spells those predicates and greenlightRender.ts
// has to break exactly the ones it spells, so the vocabulary the two share sits
// below both rather than inside either. A second copy is a copy that can be
// widened alone, and a predicate the sweep looks for and the renderer no longer
// breaks pins its PR into every sweep for as long as the comment stands.

import { ADVISOR_PENDING_ALT_ATTR } from "lib/advisor/advisorBadge";

export const ZERO_WIDTH_SPACE = "\u200b";

// The in-progress sentinel, shaped like the advisor's alt attribute (see
// ADVISOR_PENDING_ALT_ATTR in lib/advisor/advisorBadge.ts) so both AI surfaces
// in the comment are matched by the same cheap substring search. It is emitted
// ONLY while a review is live; every terminal render omits it, which is how the
// Dr.CI re-render candidate set self-clears once a verdict lands.
const GREENLIGHT_PENDING_ALT = "Green Light: in progress";
export const GREENLIGHT_PENDING_ALT_ATTR = `alt="${GREENLIGHT_PENDING_ALT}"`;

// Every literal getPRsNeedingCommentRefresh (drci.ts) pins a PR into the sweep
// on. Those predicates run over the RAW comment body, and the greenlight message
// is the only model-authored text in it that is not HTML-escaped -- the fence in
// defangGreenlightMessage stops the text RENDERING as markup but leaves the
// characters themselves intact -- so a terminal render that carries one pins the
// PR into every sweep forever, defeating the self-clearing the sentinel design
// rests on.
export const SWEEP_SENTINELS = [
  GREENLIGHT_PENDING_ALT_ATTR,
  ADVISOR_PENDING_ALT_ATTR,
];
// The sweep's third predicate is the regex `\d Pending`, meant to match the
// comment's own "3 Pending" job count. Text merely describing the PR's CI state
// trips it with no adversary involved, so break the token rather than delete a
// word the reader needs.
const SWEEP_PENDING_WORD = "Pending";
const SWEEP_PENDING_WORD_DEFUSED = `P${ZERO_WIDTH_SPACE}ending`;
// Shortest raw-body text any of those predicates can match: both attributes are
// far longer than a `\d Pending` match, which is a digit and a space ahead of the
// word. Renderer output too short to reach this cannot carry a predicate however
// it is crafted, which is the only thing that lets a value skip the defuse.
export const SWEEP_PREDICATE_MIN_LENGTH = Math.min(
  ...SWEEP_SENTINELS.map((sentinel) => sentinel.length),
  SWEEP_PENDING_WORD.length + 2
);

// Substituting a zero-width space for each sentinel, rather than deleting it, is
// what makes a single pass sufficient. No sentinel contains that character, so a
// surviving occurrence would have to lie wholly inside one fragment of a split
// that by construction has none: neither a nested forgery
// (`alt="Green alt="Green Light: in progress"Light: in progress"`) nor one
// sentinel spliced together across the gap left by removing another can
// reassemble, and no later substitution can put one back. Deleting would need a
// fixpoint loop instead, which is quadratic in the message length -- `message` is
// an unbounded ClickHouse String and the cap in defangGreenlightMessage is
// applied after this, so a deeply nested 600 KB payload blocks the event loop for
// seconds in a shared handler.
export function defuseSweepSentinels(text: string): string {
  let out = text;
  for (const sentinel of SWEEP_SENTINELS) {
    out = out.split(sentinel).join(ZERO_WIDTH_SPACE);
  }
  return out.split(SWEEP_PENDING_WORD).join(SWEEP_PENDING_WORD_DEFUSED);
}
