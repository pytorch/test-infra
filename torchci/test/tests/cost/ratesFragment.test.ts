import { readFileSync } from "fs";
import {
  RATES_FRAGMENT_KEY,
  RATES_FRAGMENT_SCRUB,
  withoutRatesFragment,
} from "lib/tests/cost/ratesFragment";
import { trackRouteEvent } from "lib/tracking/track";
import type { NextRouter } from "next/router";
import path from "path";
import ReactGA from "react-ga4";

jest.mock("react-ga4", () => ({
  __esModule: true,
  default: { initialize: jest.fn(), event: jest.fn(), set: jest.fn() },
}));

const HUD = "https://hud.pytorch.org";
// A fragment as the rates link's destination carries it.
const PAYLOAD = "eNqrVkrOz0nVUbJSMjIwMtQ1NNQ1MlSqBQBDNwWd";
const RATES = `${RATES_FRAGMENT_KEY}=${PAYLOAD}`;

// Addresses that carry rates in the fragment, with what is left of each.
const CARRYING: Array<[string, string]> = [
  [`${HUD}/no-such-page.html#${RATES}`, `${HUD}/no-such-page.html`],
  [`${HUD}/tests/a/b/cost?days=7#${RATES}`, `${HUD}/tests/a/b/cost?days=7`],
  [`${HUD}/#return=x&${RATES}`, `${HUD}/`],
];
// Addresses that carry none: they stay as they are.
const OTHERS = [
  `${HUD}/hud/pytorch/pytorch/main`,
  `${HUD}/pytorch/pytorch/commit/abc#12345-box`,
  // An anchor of that name carries nothing.
  `${HUD}/metrics#${RATES_FRAGMENT_KEY}`,
  `${HUD}/metrics#${RATES_FRAGMENT_KEY}=`,
  `${HUD}/rates-handoff.html#return=http%3A%2F%2Flocalhost%3A3000`,
  // The query is not where the link carries them.
  `${HUD}/metrics?${RATES}`,
];

describe("withoutRatesFragment", () => {
  test("drops a fragment that carries rates, from an address and from a path", () => {
    for (const [address, left] of CARRYING) {
      expect(withoutRatesFragment(address)).toBe(left);
    }
    expect(withoutRatesFragment(`/tests/a/b/cost?days=7#${RATES}`)).toBe(
      "/tests/a/b/cost?days=7"
    );
  });

  test("leaves every other address as it is", () => {
    for (const address of [...OTHERS, "/tests/a/b/cost?days=7"]) {
      expect(withoutRatesFragment(address)).toBe(address);
    }
  });
});

// The head's script, run as a browser runs it, with a window that holds only
// what the script reads. Rewriting the entry moves the address, as it does
// in a browser.
function loadScript(address: string, state: unknown = null) {
  const opened = new URL(address);
  const listeners: Record<string, Array<() => void>> = {};
  const location = {
    hash: opened.hash,
    pathname: opened.pathname,
    search: opened.search,
  };
  const replaceState = jest.fn(
    (_state: unknown, _unused: string, to: string) => {
      const next = new URL(to, opened.origin);
      location.hash = next.hash;
      location.pathname = next.pathname;
      location.search = next.search;
    }
  );
  const window = {
    location,
    history: { state, replaceState },
    addEventListener: (type: string, listener: () => void) => {
      (listeners[type] ??= []).push(listener);
    },
  };
  new Function("window", RATES_FRAGMENT_SCRUB)(window);
  return {
    location,
    replaceState,
    address: () =>
      `${opened.origin}${location.pathname}${location.search}${location.hash}`,
    fire: (type: string) => (listeners[type] ?? []).forEach((run) => run()),
  };
}

describe("the script in the document's head", () => {
  test("takes a rates fragment off the address as the page loads, keeping the path, the query and the entry's state", () => {
    const state = { key: "kept" };
    const page = loadScript(`${HUD}/no-such-page.html?a=1#${RATES}`, state);
    expect(page.replaceState).toHaveBeenCalledTimes(1);
    expect(page.replaceState).toHaveBeenCalledWith(
      state,
      "",
      "/no-such-page.html?a=1"
    );
    expect(page.address()).toBe(`${HUD}/no-such-page.html?a=1`);
  });

  test("leaves the same addresses as withoutRatesFragment does", () => {
    for (const [address, left] of CARRYING) {
      expect(loadScript(address).address()).toBe(left);
    }
    for (const address of OTHERS) {
      const page = loadScript(address);
      expect(page.replaceState).not.toHaveBeenCalled();
      expect(page.address()).toBe(address);
    }
  });

  test.each(["popstate", "hashchange"])(
    "takes one off again when the address changes in place (%s)",
    (event) => {
      const page = loadScript(`${HUD}/metrics?a=1`);
      page.location.hash = `#${RATES}`;
      page.fire(event);
      expect(page.replaceState).toHaveBeenCalledTimes(1);
      expect(page.address()).toBe(`${HUD}/metrics?a=1`);
      // Any other change is left alone.
      page.location.hash = "#12345-box";
      page.fire(event);
      expect(page.replaceState).toHaveBeenCalledTimes(1);
      expect(page.address()).toBe(`${HUD}/metrics?a=1#12345-box`);
    }
  );

  test("does not stop the page when the address cannot be rewritten", () => {
    const window = {
      location: { hash: `#${RATES}`, pathname: "/x", search: "" },
      history: {
        state: null,
        replaceState: () => {
          throw new Error("SecurityError");
        },
      },
      addEventListener: jest.fn(),
    };
    expect(() =>
      new Function("window", RATES_FRAGMENT_SCRUB)(window)
    ).not.toThrow();
    expect(window.addEventListener).toHaveBeenCalledTimes(2);
  });

  test("is one line, so a server that marks up each line of a page cannot break it", () => {
    expect(RATES_FRAGMENT_SCRUB).not.toMatch(/[\r\n]/);
  });

  test("is in the head of the app's document, where it runs before the app's code", () => {
    const document = readFileSync(
      path.join(__dirname, "../../../pages/_document.tsx"),
      "utf8"
    );
    const head = document.slice(
      document.indexOf("<Head>"),
      document.indexOf("</Head>")
    );
    expect(head).toContain(
      "<script dangerouslySetInnerHTML={{ __html: RATES_FRAGMENT_SCRUB }} />"
    );
  });
});

describe("trackRouteEvent", () => {
  // Without a DOM: the window is only what the tracker reads.
  function openOn(address: string) {
    const url = new URL(address);
    (globalThis as { window?: unknown }).window = {
      location: { href: url.href, pathname: url.pathname, search: url.search },
    };
  }

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    jest.clearAllMocks();
  });

  test("reports a page opened with a rates fragment without it", () => {
    openOn(`${HUD}/no-such-page.html?a=1#${RATES}`);
    // What the router would hold had the address reached it.
    const router = {
      pathname: "/404",
      asPath: `/no-such-page.html?a=1#${RATES}`,
    } as NextRouter;
    trackRouteEvent(router, "pageview", {});
    expect(ReactGA.event).toHaveBeenCalledTimes(1);
    const [name, reported] = (ReactGA.event as jest.Mock).mock.calls[0];
    expect(name).toBe("pageview");
    expect(reported).toEqual({
      url: `${HUD}/no-such-page.html?a=1`,
      windowPathname: "/no-such-page.html",
      routerPathname: "/404",
      routerPath: "/no-such-page.html?a=1",
    });
    expect(JSON.stringify(reported)).not.toContain(PAYLOAD);
  });

  test("reports any other fragment as before", () => {
    openOn(`${HUD}/pytorch/pytorch/commit/abc#12345-box`);
    const router = {
      pathname: "/[repoOwner]/[repoName]/commit/[sha]",
      asPath: "/pytorch/pytorch/commit/abc#12345-box",
    } as NextRouter;
    trackRouteEvent(router, "pageview", {});
    const [, reported] = (ReactGA.event as jest.Mock).mock.calls[0];
    expect(reported.url).toBe(`${HUD}/pytorch/pytorch/commit/abc#12345-box`);
    expect(reported.routerPath).toBe("/pytorch/pytorch/commit/abc#12345-box");
  });
});
