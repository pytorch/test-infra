import { NextRouter } from "next/router";
import ReactGA from "react-ga4";

const GA_SESSION_ID = "ga_session_id";
const GA_MEASUREMENT_ID = "G-HZEXJ323ZF";

// Add a global flag to window object
declare global {
  interface Window {
    __GA_INITIALIZED__?: boolean;
    gtag?: (...args: any[]) => void; // Declare gtag for direct access check
  }
}

export const isGaInitialized = (): boolean => {
  return typeof window !== "undefined" && !!window.__GA_INITIALIZED__;
};

function isDebugMode() {
  return (
    typeof window !== "undefined" &&
    window.location.search.includes("debug_mode=true")
  );
}

function isProdEnv() {
  return (
    typeof window !== "undefined" &&
    window.location.href.startsWith("https://hud.pytorch.org")
  );
}

function isGAEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return isDebugMode() || isProdEnv();
}

/**
 * initialize google analytics
 * if withUserId is set, we generate random userId to track action sequence for a single page.
 * Notice, we use session storage, if user create a new page tab due to navigation, it's considered new session
 * @param withUserId
 * @returns
 */
export const initGaAnalytics = (withSessionId = false) => {
  // Block in non-production deployments unless the debug_mode is set to true in url.
  if (!isGAEnabled()) {
    console.info("[GA] Skipping GA init");
    return;
  }

  if (isGaInitialized()) {
    console.log("ReactGA already initialized.");
    return;
  }

  ReactGA.initialize(GA_MEASUREMENT_ID, {
    // For enabling debug mode for GA4, the primary option is `debug: true`
    // passed directly to ReactGA.initialize.
    // The `gaOptions` and `gtagOptions` are for more advanced configurations
    // directly passed to the underlying GA/Gtag library.
    // @ts-ignore
    debug: isDebugMode(),
    gaOptions: {
      debug_mode: isDebugMode(),
    },
    gtagOptions: {
      debug_mode: isDebugMode(),
      cookie_domain: isDebugMode() ? "none" : "auto",
    },
  });

  window.__GA_INITIALIZED__ = true; // Set a global flag

  // generate random userId in session storage.
  if (withSessionId) {
    let id = sessionStorage.getItem(GA_SESSION_ID);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(GA_SESSION_ID, id);
    }
    ReactGA.set({ user_id: id });
  }
};

export function trackRouteEvent(
  router: NextRouter,
  eventName: string,
  info: Record<string, any> = {}
) {
  if (!isGAEnabled()) {
    return;
  }

  const payload = {
    ...info,
    url: window.location.href,
    windowPathname: window.location.pathname,
    routerPathname: router.pathname,
    routerPath: router.asPath,
    ...(isDebugMode() ? { debug_mode: true } : {}),
  };

  ReactGA.event(eventName.toLowerCase(), payload);
}

/**
 * track event with context using QA
 * @param action
 * @param category
 * @param label
 * @param extra
 * @returns
 */
export function trackEventWithContext(
  action: string,
  category?: string,
  label?: string,
  extra?: Record<string, any>
) {
  if (!isGAEnabled()) {
    return;
  }
  const payload = {
    category,
    label,
    event_time: new Date().toISOString(),
    page_title: document.title,
    session_id: sessionStorage.getItem(GA_SESSION_ID) ?? undefined,

    ...(isDebugMode() ? { debug_mode: true } : {}),
  };
  ReactGA.event(action, payload);
}
