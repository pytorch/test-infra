import { MAX_RATES_BYTES } from "lib/tests/cost/rates";
import { RATES_FRAGMENT_KEY } from "lib/tests/cost/ratesFragment";

// Loading the internal rates with one click, for readers who can open them.
// The page cannot fetch them: they sit behind Meta's sign-in on another
// origin, which sends no CORS headers. So the browser carries them instead.
// The cost page opens a Meta-only link in a small window; after the sign-in
// the link redirects that window to a static page of HUD's
// (public/rates-handoff.html) with the rates in the URL's fragment, the part
// of a URL a browser never sends to a server; that page takes the fragment
// off the address bar, passes the rates to the waiting cost page over a
// BroadcastChannel, and closes. HUD's servers and analytics never see them:
// the static page is outside the app, and the cost page holds them in its
// state as it does a file's. A page of the app that is opened with them by
// mistake takes them off its address before its code and analytics run
// (ratesFragment.ts).
//
// The link is a fixed redirect, so it leads back to one origin, the home
// (HUD). A cost page on another origin, a local server or a development
// host, still uses the same link: it opens the home's static page first and
// asks for the rates to be sent on. That page checks the asker is on its
// short list and is the window that opened it, asks the reader, remembers
// the asker in the window's session storage and goes to the link; when the
// link brings the window back with the rates, it sends them on to the
// asker's own copy of the static page, which delivers them as above.

// The channel the static page and the cost page share, and the fragment's
// key for the rates. The static page spells both out again;
// test/tests/cost/handoff.test.ts holds the two together.
export const RATES_CHANNEL = "hud-cost-rates";
export { RATES_FRAGMENT_KEY };

// What handed-over rates are called on the page, where a file's name goes.
export const HANDOFF_RATES_NAME = "Meta rates";

// How long the page listens after opening the window: time to sign in.
export const HANDOFF_WAIT_MS = 3 * 60 * 1000;

// The static page's message, the fragment's rates as they arrived, and the
// cost page's answer, so the static page knows a page took them.
export interface RatesMessage {
  type: "rates";
  payload: string;
}
export interface RatesReceivedMessage {
  type: "received";
}

export function isRatesMessage(data: unknown): data is RatesMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "rates" &&
    typeof (data as { payload?: unknown }).payload === "string"
  );
}

// The link, and the origin it leads back to. The link is an fburl of its
// own, beside the rates file's (RATES_FILE_URL in rates.ts, which downloads
// the file): Meta-only, it redirects a signed-in employee's window to the
// home's static page with the rates in the fragment, and that page hands
// them to a waiting cost page or, opened on its own, offers them as a file.
// Its destination holds the rates, so whoever regenerates them re-points it;
// the internal tool that builds the file has a command for that. Both are
// fixed here, in the code: no setting of a deployment switches the handoff
// off or points it elsewhere.
export const HANDOFF_HOME = "https://hud.pytorch.org";
export const HANDOFF_LINK = "https://fburl.com/pytorch-ci-rates-callback";

// The origins the home's static page sends the rates on to: a developer's
// own machine, and Meta's development hosts over https. Plain http is taken
// from the machine itself only: anywhere else, whoever answers for the name
// on the reader's network is the origin, and would get the rates. The static
// page holds the same list and is the one that enforces it; this copy only
// decides where the button is offered. Preview deployments are not on it:
// their names are chosen by pattern, not owned, and they run code nobody has
// reviewed.
export const RETURN_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.fbinfra\.net(:\d+)?$/,
];

// The messages between a cost page that asks for the rates to be sent on and
// the home's static page: the static page says it is ready, in a message
// only the asker's origin can read, and the cost page answers with the link.
export interface HandoffReadyMessage {
  type: "ready";
}
export interface HandoffGoMessage {
  type: "go";
  link: string;
}

// What the cost page's button opens: the link itself on the home, or
// elsewhere the home's static page, asked to send the rates on, with the
// home and the link for the answer it waits for.
export interface RatesWindow {
  url: string;
  relay: { home: string; link: string } | null;
}

// The window for a cost page on the origin given, or null where the rates
// cannot be handed over: the origin is neither the home nor one the home
// sends rates on to.
export function ratesWindow(origin: string): RatesWindow | null {
  if (origin === HANDOFF_HOME) return { url: HANDOFF_LINK, relay: null };
  if (!RETURN_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) {
    return null;
  }
  return {
    url: `${HANDOFF_HOME}/rates-handoff.html#return=${encodeURIComponent(
      origin
    )}`,
    relay: { home: HANDOFF_HOME, link: HANDOFF_LINK },
  };
}

// The rates' JSON from a fragment's payload: the base64url, unpadded, of the
// zlib-deflated JSON, which is what Python's
// base64.urlsafe_b64encode(zlib.compress(json)).rstrip(b"=") writes. The
// JSON is a rates file's (parseRates); only its rates, valid_from, basis and
// window are read, so a link carries just those. Inflating stops at a rates
// file's largest size, so a small payload cannot grow without bound.
export async function decodeRatesPayload(payload: string): Promise<string> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error(
      "This browser cannot read the rates link (it has no DecompressionStream)."
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error("The rates link's payload is not base64url.");
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("The rates link's payload is not base64url.");
  }
  const inflater = new DecompressionStream("deflate");
  const writer = inflater.writable.getWriter();
  // Bytes that are not deflated fail the reading below, which says so; the
  // writing fails with it, and is not waited for.
  writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => undefined);
  const reader = inflater.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new Error("The rates link's payload is not deflated JSON.");
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RATES_BYTES) {
      await reader.cancel();
      throw new Error(
        `The rates link's payload inflates past ${Math.round(
          MAX_RATES_BYTES / 1000
        )} KB.`
      );
    }
    chunks.push(chunk.value);
  }
  const inflated = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    inflated.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(inflated);
  } catch {
    throw new Error("The rates link's payload is not UTF-8 text.");
  }
}

// Opens a window for the rates, small and over the page, as a sign-in opens;
// null when the browser blocks it. On the home the window keeps no tie to
// the page: Meta's pages cut it on the way (their
// Cross-Origin-Opener-Policy), which is why the rates come back over a
// channel and why the page cannot tell when the window closes.
export function openRatesWindow(url: string): Window | null {
  const width = 520;
  const height = 640;
  const left = Math.round(
    window.screenX + Math.max(0, (window.outerWidth - width) / 2)
  );
  const top = Math.round(
    window.screenY + Math.max(0, (window.outerHeight - height) / 2)
  );
  return window.open(
    url,
    "hud-rates-handoff",
    `popup,width=${width},height=${height},left=${left},top=${top}`
  );
}
