import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import {
  HUD_OPTION_URL_KEYS,
  HudOptionKey,
  parseTriState,
  resolveTriState,
  TriState,
} from "./types";

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
 * Configuration for each tri-state HUD option. `localStorageKey` is where the
 * persisted default lives (used when the URL doesn't pin the option on/off), and
 * `serverDefault` is the hardcoded fallback used on a brand-new browser with no
 * saved preference. `pytorchOnly` options are no-ops outside pytorch/pytorch.
 */
export interface HudOptionConfig {
  key: HudOptionKey;
  localStorageKey: string;
  serverDefault: boolean;
  label: string;
  pytorchOnly?: boolean;
}

// Display order of the rows in the "Options" settings panel.
export const HUD_OPTIONS: HudOptionConfig[] = [
  {
    key: "hideUnstable",
    localStorageKey: "hideUnstable",
    serverDefault: true,
    label: "Hide unstable jobs",
  },
  {
    key: "hideGreenColumns",
    localStorageKey: "hideGreenColumns",
    serverDefault: false,
    label: "Hide green columns",
  },
  {
    key: "hideNonViableStrict",
    localStorageKey: "hideNonViableStrict",
    serverDefault: true,
    label: "Hide non-viable-strict jobs",
    pytorchOnly: true,
  },
  {
    key: "hideAlwaysSkipped",
    localStorageKey: "hideAlwaysSkipped",
    serverDefault: true,
    label: "Hide always-skipped jobs",
  },
  {
    key: "useGrouping",
    localStorageKey: "useGrouping",
    serverDefault: true,
    label: "Use grouped view",
  },
  {
    key: "monsterFailures",
    localStorageKey: "useMonsterFailures",
    serverDefault: false,
    label: "Monsterize failures",
  },
  {
    key: "mergeEphemeralLF",
    localStorageKey: "mergeLF",
    serverDefault: false,
    label: "Condense LF, ephemeral jobs",
  },
  {
    key: "mergeOSDC",
    localStorageKey: "mergeOSDC",
    serverDefault: false,
    label: "Condense OSDC, non-OSDC jobs",
  },
];

export const HUD_OPTIONS_BY_KEY: Record<HudOptionKey, HudOptionConfig> =
  Object.fromEntries(HUD_OPTIONS.map((o) => [o.key, o])) as Record<
    HudOptionKey,
    HudOptionConfig
  >;

/**
 * Resolves a single tri-state option: the URL (on/off) overrides the persisted
 * localStorage default, which overrides the hardcoded server default. Also
 * exposes the raw URL state (for rendering the tri-state toggle) and the
 * persisted default (for rendering the "persist" switch).
 */
export function useHudOption(key: HudOptionKey): {
  effective: boolean;
  urlState: TriState;
  persist: boolean;
  setPersist: (_value: boolean) => void;
} {
  const router = useRouter();
  const config = HUD_OPTIONS_BY_KEY[key];
  const urlState = parseTriState(router.query[HUD_OPTION_URL_KEYS[key]]);
  const [persist, setPersist] = usePreference(
    config.localStorageKey,
    /*override*/ undefined,
    config.serverDefault
  );
  const effective = resolveTriState(urlState, persist, config.serverDefault);
  return { effective, urlState, persist, setPersist };
}
