import { useCallback, useEffect, useRef } from "react";

// Returns a function that keeps an element where it is in the window while
// the page above it changes height, until the reader scrolls, clicks or
// presses a key: a job chosen in the commit table's Job header opens rows in
// the timeline above the table.
export function useHeldPlace(): (_element: HTMLElement | null) => void {
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);
  return useCallback((element: HTMLElement | null) => {
    release.current?.();
    if (element === null) {
      return;
    }
    const top = element.getBoundingClientRect().top;
    // Where the hold last left the window: a scroll to anywhere else, a
    // pixel or more off, is the reader's.
    let scrolledTo = window.scrollY;
    const observer = new ResizeObserver(() => {
      window.scrollBy(0, element.getBoundingClientRect().top - top);
      scrolledTo = window.scrollY;
    });
    function onScroll() {
      if (Math.abs(window.scrollY - scrolledTo) >= 1) {
        stop();
      }
    }
    function stop() {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("keydown", stop, true);
      release.current = null;
    }
    observer.observe(document.body);
    window.addEventListener("scroll", onScroll);
    // Heard on their way down, so the key that made the choice, still on
    // its way up, does not end the hold it began.
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("keydown", stop, true);
    release.current = stop;
  }, []);
}
