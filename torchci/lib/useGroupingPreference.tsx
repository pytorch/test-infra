import { useState } from "react";

export function usePreference(
  name: string,
  override: boolean | undefined = undefined
): [boolean, (grouping: boolean) => void] {
  const settingFromStorage =
    typeof window === "undefined"
      ? "true"
      : window.localStorage.getItem(name) ?? "true";
  const initialVal =
    override === undefined ? settingFromStorage === "true" : override;
  const [state, setState] = useState<boolean>(initialVal);

  const setStatePersist = (grouping: boolean) => {
    setState(grouping);
    localStorage.setItem(name, String(grouping));
  };

  return [state, setStatePersist];
}

export function useGroupingPreference(
  hasParams: boolean
): [boolean, (grouping: boolean) => void] {
  const override = hasParams ? false : undefined;

  return usePreference("useGrouping", override);
}
