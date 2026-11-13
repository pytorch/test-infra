import {
  decodeRatesPayload,
  HANDOFF_WAIT_MS,
  type HandoffGoMessage,
  isRatesMessage,
  openRatesWindow,
  RATES_CHANNEL,
  type RatesReceivedMessage,
  type RatesWindow,
} from "lib/tests/cost/handoff";
import { useCallback, useEffect, useRef, useState } from "react";

export interface RatesHandoff {
  // The window was opened and the page is listening for its rates.
  waiting: boolean;
  // Opens the window and listens; again while waiting, it opens the window
  // anew.
  load: () => void;
  cancel: () => void;
}

// The cost page's side of the rates handoff (handoff.ts) for the window its
// origin opens, or null where there is none. The page listens only between a
// click on its button and the rates' arrival, a cancel, or HANDOFF_WAIT_MS:
// rates that arrive unasked, as from a link someone was sent, are never
// taken, and the static page then says no page is waiting. The channel is
// opened in the click itself, before the window, so the rates cannot arrive
// first. Off the home, the window opens on the home's static page, which
// says when it is ready; the page answers with the link, to that window and
// that origin only.
export function useRatesHandoff(
  target: RatesWindow | null,
  onRates: (_text: string) => void,
  onError: (_message: string) => void
): RatesHandoff | null {
  const [waiting, setWaiting] = useState(false);
  // What a click set up, taken down when the listening stops.
  const listening = useRef<(() => void) | null>(null);
  // The page's handlers as they are when the rates arrive, not as they were
  // at the click: the runner-hours may have changed meanwhile.
  const handlers = useRef({ onRates, onError });
  handlers.current = { onRates, onError };

  const stop = useCallback(() => {
    listening.current?.();
    listening.current = null;
    setWaiting(false);
  }, []);

  const load = useCallback(() => {
    if (target === null) return;
    stop();
    const channel = new BroadcastChannel(RATES_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      if (!isRatesMessage(event.data)) return;
      const received: RatesReceivedMessage = { type: "received" };
      channel.postMessage(received);
      stop();
      decodeRatesPayload(event.data.payload).then(
        (text) => handlers.current.onRates(text),
        (error: unknown) =>
          handlers.current.onError(
            error instanceof Error ? error.message : String(error)
          )
      );
    };
    const timer = setTimeout(() => {
      stop();
      handlers.current.onError(
        "No rates arrived from the Meta window. Try again, or download the rates file."
      );
    }, HANDOFF_WAIT_MS);
    listening.current = () => {
      channel.close();
      clearTimeout(timer);
    };

    const opened = openRatesWindow(target.url);
    if (opened === null) {
      stop();
      handlers.current.onError(
        "The browser blocked the Meta window. Allow pop-ups for this site and try again, or download the rates file."
      );
      return;
    }
    const relay = target.relay;
    if (relay !== null) {
      const onReady = (event: MessageEvent) => {
        if (event.origin !== relay.home || event.source !== opened) return;
        if ((event.data as { type?: unknown } | null)?.type !== "ready") {
          return;
        }
        const go: HandoffGoMessage = { type: "go", link: relay.link };
        opened.postMessage(go, relay.home);
      };
      window.addEventListener("message", onReady);
      listening.current = () => {
        channel.close();
        clearTimeout(timer);
        window.removeEventListener("message", onReady);
      };
    }
    setWaiting(true);
  }, [target, stop]);

  // Leaving the page stops the listening.
  useEffect(() => stop, [stop]);

  return target === null ? null : { waiting, load, cancel: stop };
}
