// The cost page's internal rates travel in a URL's fragment, under this key,
// to public/rates-handoff.html (handoff.ts). That static page is outside the
// app, so no analytics run where the fragment is. A page of the app should
// never be opened with such a fragment, but it can happen: the rates link
// pointed at another HUD address, or a deployment without the static page,
// where its address is the app's not-found page. The app's analytics report
// the whole address, fragment included (lib/tracking/track.ts, and Vercel's
// <Analytics />), and signing in sends the address to the server. So the app
// takes such a fragment off its address before any of its code runs
// (pages/_document.tsx), and off what it reports. This file imports nothing:
// the app's shell uses it without loading the cost page's code.
export const RATES_FRAGMENT_KEY = "rates";

// The address without its fragment, when the fragment carries rates; any
// other address as it is.
export function withoutRatesFragment(address: string): string {
  const start = address.indexOf("#");
  if (start === -1) return address;
  const carried = new URLSearchParams(address.slice(start + 1)).get(
    RATES_FRAGMENT_KEY
  );
  return carried ? address.slice(0, start) : address;
}

// The same, as a script for the document's head: there it runs before the
// app's code reads the address. Any later is too late, since Next keeps the
// address it started with and puts it back as it hydrates. The script runs
// again when the address changes in place, ahead of the listeners that the
// app and its analytics add after it. An address that cannot be rewritten
// stays as it is. The script is kept to one line: a server that marks up a
// page's HTML line by line (as `next start` does here, where the log viewer's
// ansicolor gives strings a `default` that Next takes for the page) would
// otherwise break it.
export const RATES_FRAGMENT_SCRUB = [
  "(function () {",
  "function scrub() {",
  "try {",
  "var fragment = window.location.hash.slice(1);",
  `var key = ${JSON.stringify(RATES_FRAGMENT_KEY)};`,
  "if (!fragment || !new URLSearchParams(fragment).get(key)) return;",
  "window.history.replaceState(",
  'window.history.state, "", window.location.pathname + window.location.search',
  ");",
  "} catch (error) {}",
  "}",
  "scrub();",
  'window.addEventListener("popstate", scrub);',
  'window.addEventListener("hashchange", scrub);',
  "})();",
].join(" ");
