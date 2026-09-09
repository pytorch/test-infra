// Renders an untrusted scalar -- a verdict reason, a commit sha -- as a markdown
// inline code span. The span is containment against the value breaking the line
// it sits on, and nothing more: it neither escapes nor defuses, so a caller that
// puts one in the comment body owns running defuseSweepSentinels over the
// FINISHED line. Not over the value on its way in -- stripInlineBreakers deletes,
// and a deletion splices the text on either side of it together, so a predicate
// broken by exactly one backtick is invisible to a defuse that ran before it.

// Characters that would end an inline code span or the line holding it.
export const INLINE_BREAKERS_RE = /[`\r\n]/g;

function stripInlineBreakers(value: string): string {
  return value.replace(INLINE_BREAKERS_RE, "");
}

export function inlineCode(value: string): string {
  return `\`${stripInlineBreakers(value)}\``;
}

// shortSha is the one rendered value that never reaches defuseSweepSentinels.
// What makes that safe is arithmetic: kept under SWEEP_PREDICATE_MIN_LENGTH in
// greenlightSweep.ts, no sha it emits is long enough to spell a predicate,
// whatever the sha holds.
export const SHORT_SHA_LENGTH = 7;

export function shortSha(sha: string): string {
  return inlineCode(sha.trim().slice(0, SHORT_SHA_LENGTH));
}
