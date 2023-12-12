export function track(router: any, type: string, info: any) {
  fetch(`/api/track`, {
    method: "POST",
    body: JSON.stringify({
      info: info,
      type: type,
      url: window.location.href,
      windowPathname: window.location.pathname,
      routerPathname: router.pathname,
      routerPath: router.asPath,
    }),
  });
}
