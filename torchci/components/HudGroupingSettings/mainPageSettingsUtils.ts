export type Group = {
  name: string;
  regex: RegExp;
  filterPriority: number;
  displayPriority: number;
  persistent: boolean;
};

export function saveTreeData(treeData: Group[]) {
  // Convert RegExp objects to a format that can be serialized
  const serializable = treeData.map((group) => ({
    ...group,
    regex: group.regex.source, // Store only the regex pattern as a string
  }));

  const setting = JSON.stringify(serializable);
  localStorage.setItem("hud_group_settings", setting);
}

export function getStoredTreeData(): Group[] {
  try {
    // Try to load saved tree data from localStorage
    const stored = localStorage.getItem("hud_group_settings");

    if (!stored) return [];

    const parsed = JSON.parse(stored);

    // Convert the stored string patterns back to RegExp objects
    return parsed.map((item: any) => ({
      ...item,
      regex: new RegExp(item.regex || ""),
    }));
  } catch (error) {
    console.error("Error loading stored group settings:", error);
    return [];
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
