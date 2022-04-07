import { useState } from "react";

export default function useGroupingPreference(
  hasParams: boolean
): [boolean, (grouping: boolean) => void] {
  const useGroupingFromStorage =
    typeof window === "undefined"
      ? "true"
      : window.localStorage.getItem("useGrouping") ?? "true";
  const [useGrouping, setUseGrouping] = useState<boolean>(
    !hasParams && useGroupingFromStorage === "true"
  );

  const setGrouping = (grouping: boolean) => {
    setUseGrouping(grouping);
    localStorage.setItem("useGrouping", String(grouping));
  };

  return [useGrouping, setGrouping];
}
