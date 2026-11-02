import { useEffect, useLayoutEffect } from "react";

// A layout effect where there is a layout to measure, the browser, and a
// plain effect on the server, where a layout effect only warns (MUI's
// useEnhancedEffect): for what is placed or sized by measures read from the
// drawing before it is painted, the grid's card and pill (RunGrid) and the
// commit summary's counts (CommitSummaryRow).
export const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;
