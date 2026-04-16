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

  useEffect(() => {
    if (!router.isReady || !hydrated) return;

    // avoid echo when we were the ones pushing
    if (isApplyingUrlRef.current) return;

    const parsed = queryToState(router.query);
    update(parsed);
  }, [router.asPath]);

  // Store -> URL (call this when you want to sync, e.g., on Confirm)
  const pushUrlFromStore = () => {
    if (!router.isReady || isApplyingUrlRef.current) return;

    const nextQueryObj = stateToQuery(state);
    const currQueryObj = router.query as Record<string, any>;

    const nextSig = stableQuerySig(nextQueryObj);
    const currSig = stableQuerySig(currQueryObj);
    if (nextSig === currSig || nextSig === lastPushedSigRef.current) {
      //console.log("skipping url push lastpushed:",lastPushedSigRef.current);
      //console.log("skipping url push nextSig:",nextSig);
      return;
    }

    const [pathname] = router.asPath.split("?");

    // push url to router history if current url is from main page
    // this works with router.back() to go back to main page from sub render pages
    // when navigate to sub render page first time, we still push it to history
    // so that when call router.back() it will go back to the previous main page
    const isNextMain = (nextQueryObj.renderGroupId ?? "main") === "main";
    const isCurrMain = (currQueryObj.renderGroupId ?? "main") === "main";

    const navigate = isCurrMain ? router.push : router.replace;

    isApplyingUrlRef.current = true;
    navigate({ pathname, query: nextQueryObj }, undefined, {
      shallow: true,
    }).finally(() => {
      lastPushedSigRef.current = nextSig;
      setTimeout(() => {
        isApplyingUrlRef.current = false;
      }, 0);
    });
  };

  return { pushUrlFromStore, hydrated };
}
