import { NextRouter, useRouter } from "next/router";
import ReactGA from "react-ga4";

const USER_ID_KEY = "anonymous_ga_user_id";

// get Anonymous for local storage for user to track behaviours
function getAnonymousId(): string {
  let id = localStorage.getItem(USER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID(); // or use a fallback random string
    localStorage.setItem(USER_ID_KEY, id);
  }
  return id;
}

const GA_MEASUREMENT_ID = "G-HZEXJ323ZF"

function isDebugMode(){
  return typeof window !== "undefined" && window.location.search.includes("debug_mode=true");
}

function isProdEnv(){
  return typeof window!=="undefined" &&  window.location.href.startsWith("https://hud.pytorch.org")
}

function isGAEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (
    isDebugMode() || isProdEnv()
  );
}

/**
 * initialize the google analytics
 * if withUserId is set, we generate random userId to track action sequence for a single page.
 * Notice, we use session storage, if user create a new page tab due to navigation, it's considered new session
 * @param withUserId
 * @returns
 */
export const initGaAnalytics = (withSessionId = false) => {
  // Block in non-production deployments unless the debug_mode is set to true in url.
  if(!isGAEnabled()){
    console.info("[GA] Skipping GA init (non-prod)");
    return;
  }

  ReactGA.initialize(GA_MEASUREMENT_ID,{
    gaOptions: {
      debug_mode: isDebugMode(),
    },
    gtagOptions: {
      debug_mode: isDebugMode(),
    },
  });

  // generate random userId in session storage.
  if (withSessionId) {
      let id = sessionStorage.getItem("ga_session_id");
      if (!id) {
        id = crypto.randomUUID();
        sessionStorage.setItem("ga_session_id", id);
      }
      ReactGA.set({ user_id: id });
  }
};

export function trackRouteEvent(
  router: NextRouter,
  eventName: string,
  info: Record<string, any> = {}
) {
  if (!isProdEnv()) {
    console.info("[GA] Skipping route event (non-prod)");
    return;
  }

  const payload = {
      ...info,
      url: window.location.href,
      windowPathname: window.location.pathname,
      routerPathname: router.pathname,
      routerPath: router.asPath,
  };

  ReactGA.event(eventName.toLowerCase(), payload);
}



export function trackEventWithContext({
  action,
  category,
  label,
  extra = {},
}: {
  action: string;
  category?: string;
  label?: string;
  extra?: Record<string, any>;
}) {
  if (!isGAEnabled()) {
    console.info("[GA] Skipping event (non-prod)");
    return;
  }

  const payload = {
    category,
    label,
    event_time: new Date().toISOString(),
    page_title: document.title,
    session_id: sessionStorage.getItem("ga_session_id") ?? undefined,
    ...extra,
  };

  ReactGA.event(action, payload);
}
