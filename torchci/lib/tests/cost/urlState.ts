import type { DrillQuery, TrendsQuery } from "lib/api/tests/cost/contracts";
import { COST_PAGE_RETIRED_PARAMETERS } from "lib/api/tests/cost/pageV2";
import {
  type CostQuery,
  costUrlParams,
  resolveCostQuery,
} from "lib/tests/cost/queryV2";
import { mergedUrlQuery } from "lib/tests/url";
import Router from "next/router";

// A change to the page's state: any top-level choice, and any part of the
// trends' or the drill-down's.
export type CostQueryPatch = Partial<Omit<CostQuery, "trends" | "drill">> & {
  trends?: Partial<TrendsQuery>;
  drill?: Partial<DrillQuery>;
};

// What the writer needs of Next's router (the Router singleton in the page).
export interface CostRouter {
  pathname: string;
  query: Record<string, string | string[] | undefined>;
  push(
    _url: unknown,
    _as?: unknown,
    _options?: unknown
  ): Promise<boolean> | void;
  replace(
    _url: unknown,
    _as?: unknown,
    _options?: unknown
  ): Promise<boolean> | void;
}

export type CostUrlWriter = (
  _patch: CostQueryPatch,
  _how?: "push" | "replace"
) => void;

function mergePatch(a: CostQueryPatch, b: CostQueryPatch): CostQueryPatch {
  const { trends: at, drill: ad, ...aRest } = a;
  const { trends: bt, drill: bd, ...bRest } = b;
  const merged: CostQueryPatch = { ...aRest, ...bRest };
  if (at !== undefined || bt !== undefined) merged.trends = { ...at, ...bt };
  if (ad !== undefined || bd !== undefined) merged.drill = { ...ad, ...bd };
  return merged;
}

export function applyPatch(base: CostQuery, patch: CostQueryPatch): CostQuery {
  const { trends, drill, ...rest } = patch;
  return {
    ...base,
    ...rest,
    trends: { ...base.trends, ...trends },
    drill: { ...base.drill, ...drill },
  };
}

// The page's one URL writer. Patches made in one tick (a click that sets
// the trail and clears cfg, say) merge and are written once, on a
// microtask. Each write starts from the query this writer last wrote while
// that write is in flight (the router's query catches up only when it
// lands), else from the router's query, so quick writes never undo one
// another. It pushes a history entry when any merged patch asked to (the
// workflow scope), else replaces; always shallow, never scrolling, and it
// never drops a name for being absent from an answer. Retired parameters
// (split_by) and an older link's owner and machine, which the trail now
// says, leave the URL with the first write.
export function costUrlWriter(router: CostRouter): CostUrlWriter {
  let pending: { patch: CostQueryPatch; push: boolean } | null = null;
  let inFlight: { query: CostQuery } | null = null;
  const flush = () => {
    if (pending === null) return;
    const { patch, push } = pending;
    pending = null;
    const base = inFlight?.query ?? resolveCostQuery(router.query);
    const params = costUrlParams(applyPatch(base, patch));
    // The query as the URL will read back: canonical (cmp gone once a and b
    // are set, defaults off), so the next patch starts where the URL is.
    const token = { query: resolveCostQuery(params) };
    inFlight = token;
    const retired = Object.fromEntries(
      COST_PAGE_RETIRED_PARAMETERS.map((name) => [name, undefined])
    );
    const url = {
      pathname: router.pathname,
      query: mergedUrlQuery(router.query, { ...retired, ...params }),
    };
    const options = { shallow: true, scroll: false };
    const done = push
      ? router.push(url, undefined, options)
      : router.replace(url, undefined, options);
    const settle = () => {
      if (inFlight === token) inFlight = null;
    };
    Promise.resolve(done).then(settle, settle);
  };
  return (patch, how = "replace") => {
    if (pending === null) {
      pending = { patch: {}, push: false };
      queueMicrotask(flush);
    }
    pending = {
      patch: mergePatch(pending.patch, patch),
      push: pending.push || how === "push",
    };
  };
}

let shared: CostUrlWriter | null = null;

// The cost page's URL writer: one per app, so every caller's patches in a
// tick share one write and one in-flight base.
export function useCostUrl(): CostUrlWriter {
  if (shared === null) shared = costUrlWriter(Router as unknown as CostRouter);
  return shared;
}
