// The cost page's side of the rates handoff: it listens only between the
// click that opens the Meta window and the rates' arrival, a cancel or the
// wait's end, answers the static page when it takes the rates, and says what
// went wrong otherwise. Off the home, it gives the link to the home's static
// page, and to nothing else, when that page says it is ready. The static
// page is a channel of the test's, and window.open is a stub.

import {
  HANDOFF_WAIT_MS,
  RATES_CHANNEL,
  type RatesWindow,
} from "lib/tests/cost/handoff";
import {
  type RatesHandoff,
  useRatesHandoff,
} from "lib/tests/cost/useRatesHandoff";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { deflateSync } from "zlib";

const LINK = "https://fburl.com/pytorch-ci-rates-callback";
const HOME = "https://hud.pytorch.org";
// The window on the home, and the one a local server's page opens.
const DIRECT: RatesWindow = { url: LINK, relay: null };
const RELAYED: RatesWindow = {
  url: `${HOME}/rates-handoff.html#return=http%3A%2F%2Flocalhost%3A3000`,
  relay: { home: HOME, link: LINK },
};
const RATES_TEXT = JSON.stringify({ rates: { "linux.2xlarge": 0.5 } });
const PAYLOAD = deflateSync(RATES_TEXT).toString("base64url");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Mounted {
  handoff: () => RatesHandoff | null;
  rates: string[];
  errors: string[];
}

let renderer: ReactTestRenderer | null = null;
const channels: BroadcastChannel[] = [];
let open: jest.Mock;
// The window the click opened, and what the page told it.
let opened: { postMessage: jest.Mock };
// The page's listeners for messages from other windows.
let listeners: ((_event: unknown) => void)[];

beforeEach(() => {
  opened = { postMessage: jest.fn() };
  open = jest.fn(() => opened);
  listeners = [];
  (globalThis as { window?: unknown }).window = {
    open,
    screenX: 100,
    screenY: 50,
    outerWidth: 1400,
    outerHeight: 900,
    addEventListener: (_type: string, listener: (_event: unknown) => void) =>
      listeners.push(listener),
    removeEventListener: (
      _type: string,
      listener: (_event: unknown) => void
    ) => {
      listeners = listeners.filter((kept) => kept !== listener);
    },
  };
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  for (const channel of channels.splice(0)) channel.close();
  delete (globalThis as { window?: unknown }).window;
  jest.useRealTimers();
});

function mount(target: RatesWindow | null): Mounted {
  let current: RatesHandoff | null = null;
  const rates: string[] = [];
  const errors: string[] = [];
  function Page() {
    current = useRatesHandoff(
      target,
      (text) => rates.push(text),
      (message) => errors.push(message)
    );
    return null;
  }
  act(() => {
    renderer = create(<Page />);
  });
  return { handoff: () => current, rates, errors };
}

// The static page's end of the channel, and what the cost page answers.
function staticPage() {
  const channel = new BroadcastChannel(RATES_CHANNEL);
  channels.push(channel);
  const answers: unknown[] = [];
  channel.onmessage = (event: MessageEvent) => answers.push(event.data);
  return {
    answers,
    send: (payload: string) => channel.postMessage({ type: "rates", payload }),
    post: (message: unknown) => channel.postMessage(message),
  };
}

// Until a check holds, with React told of what happens meanwhile.
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await act(async () => {
      await pause(10);
    });
  }
  expect(check()).toBe(true);
}

describe("useRatesHandoff", () => {
  test("without a link for the origin there is no handoff", () => {
    expect(mount(null).handoff()).toBeNull();
  });

  test("a click opens the link in a small window over the page and waits; the rates arrive as their JSON, answered, and the waiting ends", async () => {
    const page = mount(DIRECT);
    expect(page.handoff()?.waiting).toBe(false);
    act(() => page.handoff()?.load());
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      LINK,
      "hud-rates-handoff",
      "popup,width=520,height=640,left=540,top=180"
    );
    expect(page.handoff()?.waiting).toBe(true);

    const meta = staticPage();
    meta.send(PAYLOAD);
    await until(() => page.rates.length === 1);
    expect(page.rates).toEqual([RATES_TEXT]);
    expect(page.errors).toEqual([]);
    expect(meta.answers).toEqual([{ type: "received" }]);
    expect(page.handoff()?.waiting).toBe(false);

    // The same rates sent again find nobody listening.
    meta.send(PAYLOAD);
    await act(async () => {
      await pause(50);
    });
    expect(page.rates).toHaveLength(1);
    expect(meta.answers).toHaveLength(1);
  });

  test("rates that arrive unasked are not taken or answered", async () => {
    const page = mount(DIRECT);
    const meta = staticPage();
    meta.send(PAYLOAD);
    await act(async () => {
      await pause(50);
    });
    expect(page.rates).toEqual([]);
    expect(meta.answers).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  test("other messages on the channel are passed over while waiting", async () => {
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    const meta = staticPage();
    meta.post({ type: "received" });
    meta.post({ type: "rates" });
    meta.post("rates");
    await act(async () => {
      await pause(50);
    });
    expect(meta.answers).toEqual([]);
    expect(page.handoff()?.waiting).toBe(true);
    meta.send(PAYLOAD);
    await until(() => page.rates.length === 1);
  });

  test("a cancel stops the listening", async () => {
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    act(() => page.handoff()?.cancel());
    expect(page.handoff()?.waiting).toBe(false);
    const meta = staticPage();
    meta.send(PAYLOAD);
    await act(async () => {
      await pause(50);
    });
    expect(page.rates).toEqual([]);
    expect(page.errors).toEqual([]);
    expect(meta.answers).toEqual([]);
  });

  test("a second click while waiting opens the window anew and still takes the rates once", async () => {
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    act(() => page.handoff()?.load());
    expect(open).toHaveBeenCalledTimes(2);
    expect(page.handoff()?.waiting).toBe(true);
    const meta = staticPage();
    meta.send(PAYLOAD);
    await until(() => page.rates.length === 1);
    expect(meta.answers).toEqual([{ type: "received" }]);
  });

  test("a blocked window says so and does not wait", async () => {
    open.mockReturnValue(null);
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    expect(page.handoff()?.waiting).toBe(false);
    expect(page.errors).toEqual([
      "The browser blocked the Meta window. Allow pop-ups for this site and try again, or download the rates file.",
    ]);
    const meta = staticPage();
    meta.send(PAYLOAD);
    await act(async () => {
      await pause(50);
    });
    expect(meta.answers).toEqual([]);
  });

  test("a payload that is not one is answered, and says what is wrong with it", async () => {
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    const meta = staticPage();
    meta.send("not base64url!");
    await until(() => page.errors.length === 1);
    expect(page.errors).toEqual(["The rates link's payload is not base64url."]);
    expect(page.rates).toEqual([]);
    expect(meta.answers).toEqual([{ type: "received" }]);
    expect(page.handoff()?.waiting).toBe(false);
  });

  test("the wait ends by itself, saying no rates arrived", () => {
    jest.useFakeTimers({
      doNotFake: ["nextTick", "queueMicrotask", "setImmediate"],
    });
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    act(() => {
      jest.advanceTimersByTime(HANDOFF_WAIT_MS - 1);
    });
    expect(page.handoff()?.waiting).toBe(true);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(page.handoff()?.waiting).toBe(false);
    expect(page.errors).toEqual([
      "No rates arrived from the Meta window. Try again, or download the rates file.",
    ]);
  });

  test("off the home, opens the home's static page and gives it the link when it says it is ready, and only it", () => {
    const page = mount(RELAYED);
    act(() => page.handoff()?.load());
    expect(open).toHaveBeenCalledWith(
      RELAYED.url,
      "hud-rates-handoff",
      expect.any(String)
    );
    expect(page.handoff()?.waiting).toBe(true);
    expect(listeners).toHaveLength(1);
    const ready = { type: "ready" };
    // Not the home, not the window it opened, not the message.
    listeners[0]({
      origin: "https://evil.example",
      source: opened,
      data: ready,
    });
    listeners[0]({ origin: HOME, source: {}, data: ready });
    listeners[0]({ origin: HOME, source: opened, data: { type: "go" } });
    listeners[0]({ origin: HOME, source: opened, data: null });
    expect(opened.postMessage).not.toHaveBeenCalled();
    listeners[0]({ origin: HOME, source: opened, data: ready });
    expect(opened.postMessage).toHaveBeenCalledTimes(1);
    expect(opened.postMessage).toHaveBeenCalledWith(
      { type: "go", link: LINK },
      HOME
    );
  });

  test("off the home, the rates arrive as on it, and the page stops hearing the window", async () => {
    const page = mount(RELAYED);
    act(() => page.handoff()?.load());
    const meta = staticPage();
    meta.send(PAYLOAD);
    await until(() => page.rates.length === 1);
    expect(page.rates).toEqual([RATES_TEXT]);
    expect(meta.answers).toEqual([{ type: "received" }]);
    expect(listeners).toEqual([]);
    // And after a cancel.
    act(() => page.handoff()?.load());
    expect(listeners).toHaveLength(1);
    act(() => page.handoff()?.cancel());
    expect(listeners).toEqual([]);
  });

  test("on the home, the page hears no window: the link is opened as it is", () => {
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    expect(open).toHaveBeenCalledWith(
      LINK,
      "hud-rates-handoff",
      expect.any(String)
    );
    expect(listeners).toEqual([]);
    expect(opened.postMessage).not.toHaveBeenCalled();
  });

  test("leaving the page stops the listening", async () => {
    const page = mount(DIRECT);
    act(() => page.handoff()?.load());
    act(() => renderer?.unmount());
    renderer = null;
    const meta = staticPage();
    meta.send(PAYLOAD);
    await pause(50);
    expect(page.rates).toEqual([]);
    expect(meta.answers).toEqual([]);
  });
});
