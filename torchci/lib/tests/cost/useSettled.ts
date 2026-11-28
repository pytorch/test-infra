import { useEffect, useState } from "react";

// The value once its key has held still for ms: what a fetch driven by a gesture reads, so arrowing B through ten
// days asks once. The first non-empty value passes at once, so a page load never waits.
export function useSettled<T>(
  value: T,
  ms: number,
  key: (v: T) => string = (v) => JSON.stringify(v) ?? ""
): T {
  const [settled, setSettled] = useState<T>(value);
  const k = key(value);
  const empty = settled === null || settled === undefined;
  useEffect(() => {
    if (empty) {
      setSettled(() => value);
      return;
    }
    const timer = setTimeout(() => setSettled(() => value), ms);
    return () => clearTimeout(timer);
    // value is read through its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, ms, empty]);
  return empty ? value : settled;
}
