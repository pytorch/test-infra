import { useState } from "react";

/**
 * A hook to manage a boolean preference in local storage.
 * @param name The name of the preference in local storage.
 * @param override If defined, this value will be used instead of the value in local storage.
 * @param defaultValue The default value to use if the preference is not set in local storage.
 */
export function usePreference(
  name: string,
  override: boolean | undefined = undefined,
  defaultValue: boolean = true
): [boolean, (_grouping: boolean) => void] {
  const settingFromStorage =
    typeof window === "undefined"
      ? String(defaultValue)
      : window.localStorage.getItem(name) ?? String(defaultValue);
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
): [boolean, (_grouping: boolean) => void] {
  const override = hasParams ? false : undefined;

  return usePreference("useGrouping", override);
}

export function useMonsterFailuresPreference(): [
  boolean,
  (_useMonsterFailuresValue: boolean) => void
] {
  return usePreference(
    "useMonsterFailures",
    /*override*/ undefined,
    /*default*/ false
  );
}
