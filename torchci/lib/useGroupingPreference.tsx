import { useCallback, useEffect, useState } from "react";

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

/**
 * Generic hook for numeric preferences with validation and error handling
 */
export function useNumberPreference<T extends number>(
  name: string,
  override: number | undefined = undefined,
  defaultValue: T
): [T, (value: T) => void] {
  // Try to get from localStorage with error handling
  const getLocalStorageValue = (): T => {
    try {
      if (typeof window === "undefined") {
        return defaultValue;
      }

      const storedValue = window.localStorage.getItem(name);
      if (storedValue === null) {
        return defaultValue;
      }

      const parsedValue = parseInt(storedValue);
      return isNaN(parsedValue) ? defaultValue : parsedValue as T;
    } catch (error) {
      console.error(`Error retrieving preference "${name}" from localStorage:`, error);
      return defaultValue;
    }
  };

  // Initial value hierarchy: override > localStorage > default
  const initialVal = override !== undefined ? override as T : getLocalStorageValue();
  const [state, setState] = useState<T>(initialVal);

  // Persist the value and handle errors
  const setStatePersist = useCallback((value: T) => {
    try {
      setState(value);
      if (typeof window !== "undefined") {
        localStorage.setItem(name, String(value));
      }
    } catch (error) {
      console.error(`Error saving preference "${name}" to localStorage:`, error);
      setState(value); // Still update the state even if persistence fails
    }
  }, [name]);

  // Handle hydration properly
  useEffect(() => {
    setState(initialVal);
  }, [initialVal]);

  return [state, setStatePersist];
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

/**
 * Custom hook to handle per_page preference with persistence
 * @param initialValue Optional override from URL or other source
 * @returns [current value, setter function]
 */
export function usePerPagePreference(
  initialValue?: number
): [number, (perPageValue: number) => void] {
  const [state, setState] = useNumberPreference<number>(
    "perPage",
    initialValue,
    /*default*/ 50
  );

  return [state, setState];
}