import { useDashboardSelector, useDashboardStore } from "lib/benchmark/store/benchmark_dashboard_provider";
import { NextRouter, useRouter } from "next/router";
import { useEffect, useRef } from "react";

// -------- Utilities --------
// Normalize query object (so arrays and single values compare fairly)
function stableQuerySig(q: Record<string, any>): string {
  const map: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : [v];
    map[k] = arr.map(String).sort(); // insensitive to ordering
  }
  const keys = Object.keys(map).sort();
  const pairs: [string, string][] = [];
  for (const k of keys) for (const v of map[k]) pairs.push([k, v]);
  return new URLSearchParams(pairs).toString();
}

function sameQuery(a: Record<string, any>, b: Record<string, any>) {
  return stableQuerySig(a) === stableQuerySig(b);
}

/** Convert state -> flat query params */
export function stateToQuery(obj: Record<string, any>): Record<string, string | string[]> {
  const q: Record<string, string | string[]> = {};

  const walk = (prefix: string, value: any) => {
    if (value == null) return;

    if (Array.isArray(value)) {
      q[prefix] = value.map(String);
      return;
    }
    if (value instanceof Date || (value?.toISOString && typeof value.toISOString === "function")) {
      q[prefix] = value.toISOString();
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        walk(prefix ? `${prefix}.${k}` : k, v);
      }
      return;
    }
    q[prefix] = String(value);
  };

  for (const [k, v] of Object.entries(obj ?? {})) {
    walk(k, v);
  }

  return q;
}

/** Convert query object -> nested state */
export function queryToState(query: Record<string, any>): Record<string, any> {
  const result: any = {};

  for (const [rawKey, value] of Object.entries(query ?? {})) {
    const parts = rawKey.split(".");
    let cur = result;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1) {
        const arr = Array.isArray(value) ? value : [value];
        cur[p] = arr.length > 1 ? arr.map(String) : String(arr[0]);
      } else {
        cur[p] = cur[p] || {};
        cur = cur[p];
      }
    }
  }

  return result;
}


// -------- Hook --------

/**
 * General URL <-> Store sync
 * @param router next/router
 * @param state current committed state
 * @param hydrate function to apply parsed URL state into store
 */

export function useUrlStoreSync<T extends Record<string, any>>(
  router: NextRouter,
  state: T,
  hydrate: (parsed: any) => void
) {
  const isApplyingUrlRef = useRef(false);
  const didInitRef = useRef(false);
  const lastPushedSigRef = useRef<string>("");

  // URL -> Store (init once when router is ready)
  useEffect(() => {
    if (!router.isReady || didInitRef.current) return;
    didInitRef.current = true;

    isApplyingUrlRef.current = true;
    try {
      const parsed = queryToState(router.query);
      hydrate(parsed);
    } finally {
      // release in next tick to avoid immediate store->url bounce
      setTimeout(() => { isApplyingUrlRef.current = false; }, 0);
    }
  }, [router.isReady]); // only depends on readiness

  // Store -> URL (call this when you want to sync, e.g., on Confirm)
  const pushUrlFromStore = () => {
    if (!router.isReady || isApplyingUrlRef.current) return;

    const nextQueryObj = stateToQuery(state);
    const currQueryObj = router.query as Record<string, any>;

    const nextSig = stableQuerySig(nextQueryObj);
    const currSig = stableQuerySig(currQueryObj);

    // prevent no-op replace and re-pushing the same thing
    if (nextSig === currSig || nextSig === lastPushedSigRef.current) return;

    // briefly mark as syncing to avoid URL->store echo
    isApplyingUrlRef.current = true;
    router
      .replace({ pathname: router.pathname, query: nextQueryObj }, undefined, { shallow: true })
      .finally(() => {
        lastPushedSigRef.current = nextSig;
        setTimeout(() => { isApplyingUrlRef.current = false; }, 0);
      });
  };

  return { pushUrlFromStore };
}
