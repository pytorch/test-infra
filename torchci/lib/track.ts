import { randomBytes } from "crypto";
export function track(router: any, type: string, info: any) {
  // Gets cleared when local storage is cleared but I think that's ok.
  if (window.localStorage.getItem("session_tracking_id") === null) {
    localStorage.setItem(
      "session_tracking_id",
      `${randomBytes(20).toString("hex")}-${Date.now()}`
    );
  }
  const sessionIDFromStorage = localStorage.getItem("session_tracking_id");

  fetch(`/api/track`, {
    method: "POST",
    body: JSON.stringify({
      info: info,
      type: type,
      url: window.location.href,
      windowPathname: window.location.pathname,
      routerPathname: router.pathname,
      routerPath: router.asPath,
      sessionID: sessionIDFromStorage,
    }),
  });
}
