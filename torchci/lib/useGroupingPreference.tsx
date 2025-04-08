import { useEffect, useState } from "react";

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
): [boolean, (_grouping: boolean) => void, (_grouping: boolean) => void] {
  const settingFromStorage =
    typeof window === "undefined"
      ? String(defaultValue)
      : window.localStorage.getItem(name) ?? String(defaultValue);
  const initialVal =
    override === undefined ? settingFromStorage === "true" : override;
  const [state, setState] = useState<boolean>(defaultValue);

  const setStatePersist = (grouping: boolean) => {
    setState(grouping);
    localStorage.setItem(name, String(grouping));
  };

  // Gets around hydration errors?
  useEffect(() => {
    setState(initialVal);
  }, [initialVal]);

  return [state, setStatePersist, setState];
}

export function useGroupingPreference(
  nameFilter: string | undefined | null
): [boolean, (_grouping: boolean) => void] {
  const hasNameFilter =
    nameFilter !== "" && nameFilter !== null && nameFilter !== undefined;
  const override = hasNameFilter ? false : undefined;
  const [state, setState, setStateTemp] = usePreference(
    "useGrouping",
    override
  );
  useEffect(() => {
    if (hasNameFilter) {
      // Manually set grouping to be false if there is a name filter on first
      // load.  Without this setState, if you enter a filter, check use
      // grouping, then enter another filter, it will still be grouped
      setStateTemp(false);
    }
  }, [nameFilter]);

  return [state, setState];
}

export function useMonsterFailuresPreference(): [
  boolean,
  (_useMonsterFailuresValue: boolean) => void
] {
  const [state, setState] = usePreference(
    "useMonsterFailures",
    /*override*/ undefined,
    /*default*/ false
  );
  return [state, setState];
}

export function useHideGreenColumnsPreference(): [
  boolean,
  (_hideGreenColumnsValue: boolean) => void
] {
  const [state, setState] = usePreference(
    "hideGreenColumns",
    /*override*/ undefined,
    /*default*/ false
  );
  return [state, setState];
}
