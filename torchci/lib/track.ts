import ReactGA from "react-ga4";

export function track(router: any, type: string, info: any) {
    // TODO: I think there better ways to make sure it doesn't send dev data but
    // for now this is easy to read.
    ReactGA.event(type, {
      ...info,
      url: window.location.href,
      windowPathname: window.location.pathname,
      routerPathname: router.pathname,
      routerPath: router.asPath,
    });
}
