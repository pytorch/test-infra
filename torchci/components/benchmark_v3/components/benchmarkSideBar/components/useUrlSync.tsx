import {
  queryToState,
  stableQuerySig,
  stateToQuery,
} from "lib/helpers/urlQuery";
import { NextRouter } from "next/router";
import { useEffect, useRef, useState } from "react";

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
  update: (parsed: any) => void
) {
  const isApplyingUrlRef = useRef(false);
  const didInitRef = useRef(false);
  const lastPushedSigRef = useRef<string>("");
  const [hydrated, setHydrated] = useState(false); // 👈 expose this

  // URL -> Store (init once when router is ready)
  useEffect(() => {
    if (!router.isReady || didInitRef.current) return;
    didInitRef.current = true;

    isApplyingUrlRef.current = true;
    try {
      const parsed = queryToState(router.query);
      update(parsed);
    } finally {
      // release in next tick to avoid immediate store->url bounce
      setTimeout(() => {
        isApplyingUrlRef.current = false;
        setHydrated(true);
      }, 0);
    }
  }, [router.isReady]); // only depends on readiness

  // Store -> URL (call this when you want to sync, e.g., on Confirm)
  const pushUrlFromStore = () => {
    if (!router.isReady || isApplyingUrlRef.current) return;

    const nextQueryObj = stateToQuery(state);
    const currQueryObj = router.query as Record<string, any>;

    // prevent no-op replace and re-pushing the same thing
    const nextSig = stableQuerySig(nextQueryObj);
    const currSig = stableQuerySig(currQueryObj);

    // prevent no-op replace and re-pushing the same thing
    if (nextSig === currSig || nextSig === lastPushedSigRef.current) return;

    const [pathname] = router.asPath.split("?"); // strip query
    // briefly mark as syncing to avoid URL->store echo
    isApplyingUrlRef.current = true;
    router
      .replace({ pathname: pathname, query: nextQueryObj }, undefined, {
        shallow: true,
      })
      .finally(() => {
        lastPushedSigRef.current = nextSig;
        setTimeout(() => {
          isApplyingUrlRef.current = false;
        }, 0);
      });
  };

  return { pushUrlFromStore, hydrated };
}
