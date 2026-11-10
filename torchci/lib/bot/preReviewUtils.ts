import { PRE_REVIEW_START_DATE } from "lib/prStatus";

// Rotate a bounded batch without storing a cursor. Callers supply stable order.
export function getRotatingBatch<T>(
  items: T[],
  run: number,
  size: number
): T[] {
  if (items.length <= size) return items;
  const offset = (run * size) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)].slice(0, size);
}

/** Open, non-draft PRs created on or after the workflow rollout. */
export function isInPreReview(pr: {
  state?: string;
  draft?: boolean;
  created_at?: string;
}): boolean {
  return (
    PRE_REVIEW_START_DATE !== null &&
    pr.state === "open" &&
    !pr.draft &&
    pr.created_at !== undefined &&
    Date.parse(pr.created_at) >= Date.parse(PRE_REVIEW_START_DATE)
  );
}
