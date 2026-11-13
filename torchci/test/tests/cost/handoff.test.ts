// The rates handoff's pure parts and its static page: a payload written as
// the internal side writes it (zlib, then base64url) reads back as the rates'
// JSON, bad payloads say what is wrong, one link serves the home and the
// origins the home sends rates on to, and public/rates-handoff.html, run here
// as a browser would run it, takes the fragment off the address bar before
// it does anything else, passes the rates only to a page that answers, and
// sends them on only to a listed origin that proved it asked and that the
// reader agreed to.

import { resolveObjectURL } from "buffer";
import { readFileSync } from "fs";
import {
  decodeRatesPayload,
  HANDOFF_HOME,
  HANDOFF_LINK,
  isRatesMessage,
  RATES_CHANNEL,
  RATES_FRAGMENT_KEY,
  ratesWindow,
  RETURN_ORIGIN_PATTERNS,
} from "lib/tests/cost/handoff";
import {
  MAX_RATES_BYTES,
  parseRates,
  RATES_FILE_URL,
} from "lib/tests/cost/rates";
import path from "path";
import vm from "vm";
import { deflateSync } from "zlib";
import RATES_JSON from "./rates.json";

// A payload as the internal side makes one: Python's
// base64.urlsafe_b64encode(zlib.compress(json)).rstrip(b"=").
function payloadOf(content: string | Uint8Array): string {
  return deflateSync(content, { level: 9 }).toString("base64url");
}

const RATES_TEXT = JSON.stringify(RATES_JSON);

describe("the payload", () => {
  test("reads back as the rates' JSON, which the page reads as a file's", async () => {
    const text = await decodeRatesPayload(payloadOf(RATES_TEXT));
    expect(text).toBe(RATES_TEXT);
    const rates = parseRates(text, "Meta rates");
    expect(rates.file).toBe("Meta rates");
    expect(rates.validFrom).toBe(RATES_JSON.valid_from);
    expect(rates.rates).toEqual(RATES_JSON.rates);
  });

  test("keeps text outside ASCII", async () => {
    const text = JSON.stringify({ basis: "прайс — 料金", rates: { a: 1 } });
    expect(await decodeRatesPayload(payloadOf(text))).toBe(text);
  });

  test("says what is wrong with a payload that is not one", async () => {
    await expect(decodeRatesPayload("not base64url!")).rejects.toThrow(
      "The rates link's payload is not base64url."
    );
    await expect(decodeRatesPayload("")).rejects.toThrow(
      "The rates link's payload is not base64url."
    );
    // Base64url of bytes that were never deflated.
    await expect(
      decodeRatesPayload(Buffer.from(RATES_TEXT).toString("base64url"))
    ).rejects.toThrow("The rates link's payload is not deflated JSON.");
    // Deflated bytes that are not text.
    await expect(
      decodeRatesPayload(payloadOf(new Uint8Array([0xff, 0xfe, 0xfd])))
    ).rejects.toThrow("The rates link's payload is not UTF-8 text.");
  });

  test("stops inflating past a rates file's largest size", async () => {
    // A megabyte and a bit of one letter deflates to about a kilobyte.
    const bomb = payloadOf("a".repeat(MAX_RATES_BYTES + 1));
    expect(bomb.length).toBeLessThan(4000);
    await expect(decodeRatesPayload(bomb)).rejects.toThrow(
      "The rates link's payload inflates past 1000 KB."
    );
    const largest = "a".repeat(MAX_RATES_BYTES);
    expect(await decodeRatesPayload(payloadOf(largest))).toBe(largest);
  });

  test("a message is the static page's only with a payload", () => {
    expect(isRatesMessage({ type: "rates", payload: "eNo" })).toBe(true);
    for (const other of [
      null,
      "rates",
      { type: "rates" },
      { type: "rates", payload: 1 },
      { type: "received" },
    ]) {
      expect(isRatesMessage(other)).toBe(false);
    }
  });
});

// A link an asker names in its answer to the static page: not the one
// handoff.ts lists, so a test shows which one was followed.
const LINK = "https://fburl.com/an-askers-link";
const LOCAL = "http://localhost:3000";

// Origins the home sends rates on to, and origins it must not.
const LISTED = [
  LOCAL,
  "http://localhost",
  "http://127.0.0.1:44100",
  "http://[::1]:8080",
  "https://devvm1.abc.fbinfra.net",
  "https://devvm1.abc.fbinfra.net:44100",
];
const UNLISTED = [
  // A development host over plain http: on the reader's network anyone can
  // answer for its name.
  "http://devgpu115.cco2.fbinfra.net:44100",
  "http://devvm1.abc.fbinfra.net",
  "https://localhost:3000",
  "http://localhost.evil.example",
  "http://localhost:3000.evil.example",
  "http://evil.example/?http://localhost:3000",
  "https://fbinfra.net.evil.example",
  "http://xfbinfra.net",
  "https://torchci-a1b2c3d4e-fbopensource.vercel.app",
  "https://torchci-git-some-branch-fbopensource.vercel.app",
  "https://hud.pytorch.org.evil.example",
  "javascript:alert(1)",
  "constructor",
];

describe("the window a cost page opens", () => {
  test("comes from the code alone: the handoff's own link and HUD, whatever a deployment's settings say", () => {
    expect(HANDOFF_LINK).toBe("https://fburl.com/pytorch-ci-rates-callback");
    // Not the rates file's link, which downloads the file.
    expect(RATES_FILE_URL).toBe("https://fburl.com/pytorch-ci-rates");
    expect(HANDOFF_LINK).not.toBe(RATES_FILE_URL);
    expect(HANDOFF_HOME).toBe("https://hud.pytorch.org");
    // Settings that once named another link and home change nothing.
    const names = [
      "NEXT_PUBLIC_RATES_HANDOFF_URL",
      "NEXT_PUBLIC_RATES_HANDOFF_HOME",
    ];
    const saved = names.map((name) => process.env[name]);
    process.env.NEXT_PUBLIC_RATES_HANDOFF_URL = LINK;
    process.env.NEXT_PUBLIC_RATES_HANDOFF_HOME = LOCAL;
    try {
      expect(ratesWindow(HANDOFF_HOME)).toEqual({
        url: HANDOFF_LINK,
        relay: null,
      });
      expect(ratesWindow(LOCAL)?.relay).toEqual({
        home: HANDOFF_HOME,
        link: HANDOFF_LINK,
      });
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  });

  test("on the home is the link itself", () => {
    expect(ratesWindow(HANDOFF_HOME)).toEqual({
      url: HANDOFF_LINK,
      relay: null,
    });
  });

  test("on a listed origin is the home's static page, asked to send the rates on", () => {
    expect(ratesWindow(LOCAL)).toEqual({
      url: "https://hud.pytorch.org/rates-handoff.html#return=http%3A%2F%2Flocalhost%3A3000",
      relay: { home: HANDOFF_HOME, link: HANDOFF_LINK },
    });
    for (const origin of LISTED) {
      const opened = ratesWindow(origin);
      expect(opened?.relay).toEqual({ home: HANDOFF_HOME, link: HANDOFF_LINK });
      expect(
        new URLSearchParams(new URL(opened?.url ?? "").hash.slice(1)).get(
          "return"
        )
      ).toBe(origin);
    }
  });

  test("on any other origin, a preview deployment among them, is none: the file download stays", () => {
    for (const origin of UNLISTED) {
      expect(ratesWindow(origin)).toBeNull();
    }
  });
});

// public/rates-handoff.html and its scripts, which the tests below run with
// a window of their own.
const PAGE_HTML = readFileSync(
  path.join(__dirname, "../../../public/rates-handoff.html"),
  "utf8"
);
const PAGE_SCRIPTS = Array.from(
  PAGE_HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
  ([, body]) => body
);

interface PageMessage {
  origin: string;
  source: unknown;
  data: unknown;
}

interface OpenedPage {
  title: string;
  detail: string;
  closed: boolean;
  colorScheme: string | undefined;
  // The addresses the page replaced its own with, and those it went to.
  replaced: string[];
  wentTo: string[];
  // The fragment still on the address bar when the page opened its channel.
  fragmentAtChannel: string | null;
  // The Continue and Cancel buttons are shown.
  asking: boolean;
  // The Download button is shown, in their place.
  offering: boolean;
  // The files the page saved: each one's name and its address in memory.
  saved: { name: string | null; address: string | null }[];
  // The window's session storage.
  session: Map<string, string>;
  // What the page told its opener, with the origin allowed to read it, and
  // the opener itself, to be the source of a message.
  toldOpener: [unknown, string][];
  opener: () => unknown;
  // Fires the page's wait for an answer.
  elapse: () => void;
  // A message arriving at the page's window.
  receive: (_message: PageMessage) => void;
  press: (_button: "continue" | "cancel" | "download") => void;
}

const channels: BroadcastChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
});
function channelOf(): BroadcastChannel {
  const channel = new BroadcastChannel(RATES_CHANNEL);
  channels.push(channel);
  return channel;
}
function nextMessage(channel: BroadcastChannel): Promise<unknown> {
  return new Promise((resolve) => {
    channel.onmessage = (event: MessageEvent) => resolve(event.data);
  });
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function openPage(
  fragment: string,
  options: {
    themeMode?: string | null;
    channels?: boolean;
    // The page's own origin: the home's unless given.
    origin?: string;
    opener?: boolean;
    session?: Record<string, string>;
    // A browser that cannot inflate, given false.
    inflater?: boolean;
  } = {}
): OpenedPage {
  const origin = options.origin ?? HANDOFF_HOME;
  const waits: (() => void)[] = [];
  const listeners: ((_event: PageMessage) => void)[] = [];
  const style: { colorScheme?: string } = {};
  const actions = { hidden: true };
  // As the page's markup has them: the download hidden until it is offered.
  const buttons: Record<string, { onclick?: () => void; hidden: boolean }> = {
    continue: { hidden: false },
    cancel: { hidden: false },
    download: { hidden: true },
  };
  const opener =
    options.opener === false
      ? null
      : {
          postMessage: (message: unknown, target: string) =>
            page.toldOpener.push([message, target]),
        };
  const page: OpenedPage = {
    title: "",
    detail: "",
    closed: false,
    colorScheme: undefined,
    replaced: [],
    wentTo: [],
    fragmentAtChannel: null,
    asking: false,
    offering: false,
    saved: [],
    session: new Map(Object.entries(options.session ?? {})),
    toldOpener: [],
    opener: () => opener,
    elapse: () => waits.splice(0).forEach((wait) => wait()),
    receive: (message) =>
      [...listeners].forEach((listener) => listener(message)),
    press: (button) => buttons[button].onclick?.(),
  };
  const location = {
    hash: fragment,
    pathname: "/rates-handoff.html",
    origin,
    protocol: new URL(origin).protocol,
    replace: (url: string) => {
      page.wentTo.push(url);
    },
  };
  class PageChannel extends BroadcastChannel {
    constructor(name: string) {
      super(name);
      page.fragmentAtChannel = location.hash;
      channels.push(this);
    }
  }
  const text = (key: "title" | "detail") => ({
    set textContent(value: string) {
      page[key] = value;
    },
  });
  const elements: Record<string, unknown> = {
    title: text("title"),
    detail: text("detail"),
    actions,
    ...buttons,
  };
  vm.runInNewContext(PAGE_SCRIPTS[0], {
    window: {
      location,
      opener,
      history: {
        replaceState: (_state: unknown, _unused: string, url: string) => {
          page.replaced.push(url);
          location.hash = "";
        },
      },
      localStorage: { getItem: () => options.themeMode ?? null },
      sessionStorage: {
        getItem: (key: string) => page.session.get(key) ?? null,
        setItem: (key: string, value: string) => page.session.set(key, value),
        removeItem: (key: string) => page.session.delete(key),
      },
      addEventListener: (
        _type: string,
        listener: (_event: PageMessage) => void
      ) => listeners.push(listener),
      removeEventListener: (
        _type: string,
        listener: (_event: PageMessage) => void
      ) => listeners.splice(listeners.indexOf(listener), 1),
      setTimeout: (wait: () => void) => waits.push(wait),
      close: () => {
        page.closed = true;
      },
    },
    document: {
      documentElement: { style },
      getElementById: (id: string) => elements[id],
      // A link the page makes to save a file: its click is the saving.
      createElement: () => {
        const attributes: Record<string, string> = {};
        return {
          setAttribute: (name: string, value: string) => {
            attributes[name] = value;
          },
          click: () =>
            page.saved.push({
              name: attributes.download ?? null,
              address: attributes.href ?? null,
            }),
        };
      },
      body: { appendChild: () => undefined, removeChild: () => undefined },
    },
    URL,
    URLSearchParams,
    atob,
    Blob,
    // This realm's, so the inflater takes the bytes the page hands it.
    Uint8Array,
    ...(options.inflater === false ? {} : { DecompressionStream }),
    ...(options.channels === false ? {} : { BroadcastChannel: PageChannel }),
  });
  page.colorScheme = style.colorScheme;
  // Read as the tests go on, not as it was when the script ended.
  Object.defineProperty(page, "asking", {
    get: () => !actions.hidden && !buttons.continue.hidden,
  });
  Object.defineProperty(page, "offering", {
    get: () =>
      !actions.hidden && !buttons.download.hidden && buttons.continue.hidden,
  });
  return page;
}

describe("the static page", () => {
  const payload = payloadOf(RATES_TEXT);
  const fragment = `#${RATES_FRAGMENT_KEY}=${payload}`;

  test("is one script that asks no server for anything", () => {
    expect(PAGE_SCRIPTS).toHaveLength(1);
    expect(PAGE_HTML).not.toMatch(/\b(src|href)\s*=|\bimport\b|\bfetch\(/);
  });

  test("lists the origins it sends rates on to as the library does", () => {
    const listed = PAGE_SCRIPTS[0]
      .slice(
        PAGE_SCRIPTS[0].indexOf("var RETURN_ORIGINS = ["),
        PAGE_SCRIPTS[0].indexOf("];", PAGE_SCRIPTS[0].indexOf("RETURN_ORIGINS"))
      )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"))
      .map((line) => line.replace(/^\//, "").replace(/\/,?$/, ""));
    expect(listed).toEqual(RETURN_ORIGIN_PATTERNS.map((p) => p.source));
    expect(listed).toHaveLength(2);
  });

  test("takes the fragment off the address bar first, passes the rates to the page that answers, and closes", async () => {
    const costPage = channelOf();
    const arrived = nextMessage(costPage);
    const page = openPage(fragment);
    expect(page.replaced).toEqual(["/rates-handoff.html"]);
    expect(page.fragmentAtChannel).toBe("");
    expect(await arrived).toEqual({ type: "rates", payload });
    expect(page.closed).toBe(false);
    expect(page.wentTo).toEqual([]);

    costPage.postMessage({ type: "received" });
    await pause(50);
    expect(page.title).toBe("Rates sent to the cost page");
    expect(page.closed).toBe(true);
    // The wait that follows finds the rates taken and says nothing more.
    page.elapse();
    expect(page.title).toBe("Rates sent to the cost page");
    expect(page.offering).toBe(false);
  });

  test("says so when no cost page answers, and stays open", async () => {
    const bystander = channelOf();
    const arrived = nextMessage(bystander);
    const page = openPage(fragment);
    await arrived;
    expect(page.offering).toBe(false);
    page.elapse();
    expect(page.title).toBe("No cost page is waiting for rates");
    expect(page.detail).toBe(
      "Choose Load Meta rates on the cost page, or download the file and drop it there."
    );
    expect(page.closed).toBe(false);
    // An answer after the wait is not heard: the page's channel is closed.
    bystander.postMessage({ type: "received" });
    await pause(50);
    expect(page.title).toBe("No cost page is waiting for rates");
  });

  test("with no rates in its fragment, or something that is not rates, opens no channel and goes nowhere", () => {
    for (const none of [
      "",
      "#",
      "#other=1",
      `#${RATES_FRAGMENT_KEY}=`,
      `#${RATES_FRAGMENT_KEY}=a%26return%3Dhttp%3A%2F%2Flocalhost%3A3000`,
      `#${RATES_FRAGMENT_KEY}=a/b`,
    ]) {
      const page = openPage(none, {
        session: {
          "hud-rates-return": JSON.stringify({ origin: LOCAL, at: Date.now() }),
        },
      });
      expect(page.title).toBe("No rates to pass on");
      expect(page.fragmentAtChannel).toBeNull();
      expect(page.wentTo).toEqual([]);
      expect(page.replaced).toEqual(["/rates-handoff.html"]);
    }
  });

  test("says so in a browser without a channel, and offers the file", () => {
    const page = openPage(fragment, { channels: false });
    expect(page.title).toBe("This browser can't pass the rates on");
    expect(page.replaced).toEqual(["/rates-handoff.html"]);
    expect(page.offering).toBe(true);
  });

  test("opened with no cost page waiting, offers the rates as a file: the JSON the link was made from, which the cost page reads", async () => {
    const page = openPage(fragment);
    page.elapse();
    expect(page.offering).toBe(true);
    expect(page.asking).toBe(false);
    expect(page.saved).toEqual([]);

    page.press("download");
    await pause(100);
    expect(page.saved).toHaveLength(1);
    expect(page.saved[0].name).toBe("pytorch_ci_runner_rates.json");
    const file = resolveObjectURL(page.saved[0].address ?? "");
    const content = (await file?.text()) ?? "";
    expect(content).toBe(RATES_TEXT);
    expect(parseRates(content, "pytorch_ci_runner_rates.json").rates).toEqual(
      parseRates(RATES_TEXT, "rates.json").rates
    );
    expect(page.title).toBe("Rates file downloaded");
    expect(page.closed).toBe(false);
    expect(page.wentTo).toEqual([]);
  });

  test("saves nothing, and says so, for what is not deflated JSON or inflates past a rates file's size", async () => {
    for (const bad of ["AAAA", payloadOf("x".repeat(MAX_RATES_BYTES + 1))]) {
      const page = openPage(`#${RATES_FRAGMENT_KEY}=${bad}`);
      page.elapse();
      expect(page.offering).toBe(true);
      page.press("download");
      await pause(100);
      expect(page.saved).toEqual([]);
      expect(page.title).toBe("These rates can't be kept as a file");
      expect(page.offering).toBe(false);
    }
  });

  test("offers no file in a browser that cannot inflate", () => {
    const page = openPage(fragment, { inflater: false });
    page.elapse();
    expect(page.title).toBe("No cost page is waiting for rates");
    expect(page.offering).toBe(false);
  });

  test("follows HUD's mode where the reader chose one, else the system's", () => {
    expect(openPage("", { themeMode: "dark" }).colorScheme).toBe("dark");
    expect(openPage("", { themeMode: "light" }).colorScheme).toBe("light");
    expect(openPage("", { themeMode: "system" }).colorScheme).toBeUndefined();
    expect(openPage("", { themeMode: null }).colorScheme).toBeUndefined();
  });
});

describe("the static page, asked to send the rates on", () => {
  const payload = payloadOf(RATES_TEXT);
  const asked = (origin: string) => `#return=${encodeURIComponent(origin)}`;
  const KEY = "hud-rates-return";
  // The page's opener, as the source of a message.
  const fromOpener = (page: OpenedPage, origin: string, data: unknown) =>
    page.receive({ origin, source: page.opener(), data });

  test("tells only a listed asker it is ready, in a message only that origin can read", () => {
    for (const origin of LISTED) {
      const page = openPage(asked(origin));
      expect(page.replaced).toEqual(["/rates-handoff.html"]);
      expect(page.toldOpener).toEqual([[{ type: "ready" }, origin]]);
      expect(page.title).toBe("Waiting for the cost page…");
      expect(page.asking).toBe(false);
      expect(page.session.size).toBe(0);
    }
    for (const origin of [...UNLISTED, HANDOFF_HOME]) {
      const page = openPage(asked(origin));
      expect(page.title).toBe("This page can't send the rates there");
      expect(page.toldOpener).toEqual([]);
      expect(page.session.size).toBe(0);
      expect(page.wentTo).toEqual([]);
    }
  });

  test("opened by nothing, says no cost page asked", () => {
    const page = openPage(asked(LOCAL), { opener: false });
    expect(page.title).toBe("No cost page asked for the rates");
    expect(page.session.size).toBe(0);
  });

  test("goes on only when the answer comes from the asker's origin and the window that opened it, with a web address", () => {
    const page = openPage(asked(LOCAL));
    const ignored: [string, unknown, unknown][] = [
      // Another origin, though the opener.
      ["https://evil.example", page.opener(), { type: "go", link: LINK }],
      // The asker's origin, but not the opener.
      [LOCAL, {}, { type: "go", link: LINK }],
      // Not the answer.
      [LOCAL, page.opener(), { type: "ready" }],
      [LOCAL, page.opener(), null],
      [LOCAL, page.opener(), { type: "go" }],
      // Not a web address: script would run as this page.
      [LOCAL, page.opener(), { type: "go", link: "javascript:alert(1)" }],
      [LOCAL, page.opener(), { type: "go", link: "not a link" }],
      // Plain http from an https page.
      [LOCAL, page.opener(), { type: "go", link: "http://fburl.com/x" }],
    ];
    for (const [origin, source, data] of ignored) {
      page.receive({ origin, source, data });
      expect(page.asking).toBe(false);
      expect(page.title).toBe("Waiting for the cost page…");
    }
    fromOpener(page, LOCAL, { type: "go", link: LINK });
    expect(page.asking).toBe(true);
    expect(page.title).toBe("Send the Meta rates to another site?");
    expect(page.detail).toBe(
      `${LOCAL} asked for them. Continue only if you chose Load Meta rates there.`
    );
    // Asked, not yet agreed: nothing is remembered and the window stays.
    expect(page.session.size).toBe(0);
    expect(page.wentTo).toEqual([]);
  });

  test("Continue remembers the asker and goes to the link; a second answer changes nothing", () => {
    const page = openPage(asked(LOCAL));
    fromOpener(page, LOCAL, { type: "go", link: LINK });
    fromOpener(page, LOCAL, { type: "go", link: "https://fburl.com/other" });
    const before = Date.now();
    page.press("continue");
    expect(page.wentTo).toEqual([LINK]);
    expect(page.asking).toBe(false);
    const kept = JSON.parse(page.session.get(KEY) ?? "null");
    expect(kept.origin).toBe(LOCAL);
    expect(kept.at).toBeGreaterThanOrEqual(before);
    expect(kept.at).toBeLessThanOrEqual(Date.now());
  });

  test("Cancel remembers nothing and closes", () => {
    const page = openPage(asked(LOCAL));
    fromOpener(page, LOCAL, { type: "go", link: LINK });
    page.press("cancel");
    expect(page.session.size).toBe(0);
    expect(page.wentTo).toEqual([]);
    expect(page.closed).toBe(true);
    expect(page.title).toBe("Nothing was sent");
  });

  test("a plain http link is followed only from a plain http page, a local server's", () => {
    const local = "http://devgpu115.cco2.fbinfra.net:44100";
    const page = openPage(asked(LOCAL), { origin: local });
    fromOpener(page, LOCAL, {
      type: "go",
      link: "http://127.0.0.1:47312/short",
    });
    expect(page.asking).toBe(true);
    page.press("continue");
    expect(page.wentTo).toEqual(["http://127.0.0.1:47312/short"]);
  });

  test("back from the link with the rates, sends them on to the remembered asker's copy of the page, once", () => {
    const session = {
      [KEY]: JSON.stringify({ origin: LOCAL, at: Date.now() - 60_000 }),
    };
    const page = openPage(`#${RATES_FRAGMENT_KEY}=${payload}`, { session });
    expect(page.replaced).toEqual(["/rates-handoff.html"]);
    expect(page.wentTo).toEqual([
      `${LOCAL}/rates-handoff.html#${RATES_FRAGMENT_KEY}=${payload}`,
    ]);
    // Sent on, not delivered here; and the asker is forgotten.
    expect(page.fragmentAtChannel).toBeNull();
    expect(page.session.size).toBe(0);
  });

  test("delivers here instead when what it remembers is old, unlisted, its own origin or not an asker at all", async () => {
    const remembered = [
      JSON.stringify({ origin: LOCAL, at: Date.now() - 16 * 60_000 }),
      JSON.stringify({ origin: "https://evil.example", at: Date.now() }),
      JSON.stringify({
        origin: "http://devvm1.abc.fbinfra.net",
        at: Date.now(),
      }),
      JSON.stringify({ origin: HANDOFF_HOME, at: Date.now() }),
      JSON.stringify({ origin: LOCAL }),
      JSON.stringify("http://localhost:3000"),
      "not json",
    ];
    for (const kept of remembered) {
      const costPage = channelOf();
      const arrived = nextMessage(costPage);
      const page = openPage(`#${RATES_FRAGMENT_KEY}=${payload}`, {
        session: { [KEY]: kept },
      });
      expect(page.wentTo).toEqual([]);
      expect(await arrived).toEqual({ type: "rates", payload });
      costPage.close();
    }
  });
});
