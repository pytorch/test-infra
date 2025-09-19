import _ from "lodash";
import { getDefaultGroupSettings } from "./defaults";

export type Group = {
  name: string;
  regex: RegExp;
  filterPriority: number;
  displayPriority: number;
  persistent: boolean;
  hide: boolean;
};

export function serializeTreeData(treeData: Group[]): string {
  // Convert RegExp objects to a format that can be seralized
  const serializable = treeData.map((group) => ({
    ...group,
    regex: group.regex.source, // Store only the regex pattern as a string
  }));

  return JSON.stringify(serializable);
}

export function parseTreeData(input: string): Group[] | undefined {
  try {
    const parsed = JSON.parse(input);

    // Convert the stored string patterns back to RegExp objects
    return parsed.map((item: any) => ({
      ...item,
      regex: new RegExp(item.regex || ""),
    }));
  } catch (error) {
    return undefined;
  }
}

const LOCAL_STORAGE_KEY = "hud_group_settings";
export function saveTreeData(
  repositoryFullName: string,
  branchName: string,
  treeData: Group[]
) {
  const localStorageContents = JSON.parse(
    localStorage.getItem(LOCAL_STORAGE_KEY) || "{}"
  );
  const repoBranchKey = `${repositoryFullName}::${branchName}`;

  if (
    _.isEqual(
      treeData.sort((a, b) => a.name.localeCompare(b.name)),
      getDefaultGroupSettings().sort((a, b) => a.name.localeCompare(b.name))
    )
  ) {
    // If the current settings are the same as the default, remove from
    // localStorage
    localStorageContents[repoBranchKey] = undefined;
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify(localStorageContents)
    );
    return;
  }

  const setting = serializeTreeData(treeData);
  localStorageContents[repoBranchKey] = setting;
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(localStorageContents));
}

export function getStoredTreeData(
  repositoryFullName: string,
  branchName: string
): Group[] {
  try {
    // Try to load saved tree data from localStorage
    const stored = JSON.parse(
      localStorage.getItem("hud_group_settings") || "{}"
    );

    if (!stored) return getDefaultGroupSettings();
    const repoBranchKey = `${repositoryFullName}::${branchName}`;
    const storedSetting = stored[repoBranchKey];
    if (storedSetting) {
      const parsed = parseTreeData(storedSetting);
      if (parsed === undefined) {
        return getDefaultGroupSettings();
      }
      return parsed;
    }
    const backUpKey = `${repositoryFullName}::main`;
    const backUpSetting = stored[backUpKey];
    if (backUpSetting) {
      const parsed = parseTreeData(backUpSetting);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    return getDefaultGroupSettings();
  } catch (error) {
    console.error("Error loading stored group settings:", error);
    return getDefaultGroupSettings();
  }
}

export function getNonDupNewName(treeData: Group[]) {
  let i = 0;
  while (isDupName(treeData, `NEW GROUP ${i}`)) {
    i++;
  }
  return `NEW GROUP ${i}`;
}

export function isDupName(treeData: Group[], name: string): boolean {
  return treeData.some((node) => node.name === name);
}
