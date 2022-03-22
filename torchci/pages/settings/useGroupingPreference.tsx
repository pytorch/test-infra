import { useState } from "react";

export default function useGroupingPreference(hasParams: boolean) {
  const useGroupingFromStorage = localStorage.getItem("useGrouping");
  const [useGrouping, setUseGrouping] = useState<boolean>(
    useGroupingFromStorage === "true"
  );

  const setGrouping = (grouping: boolean) => {
    setUseGrouping(grouping);
    localStorage.setItem("useGrouping", String(grouping));
  };

  return [useGrouping, setGrouping];
}
