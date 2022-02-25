import styles from "components/hud.module.css";
import { group } from "console";
import { includesCaseInsensitive } from "lib/GeneralUtils";
import React from "react";
import { BsFillCaretDownFill, BsFillCaretRightFill } from "react-icons/bs";

function groupingIncludesJobFilter(jobNames: string[], filter: string) {
  for (const jobName of jobNames) {
    if (includesCaseInsensitive(jobName, filter)) {
      return true;
    }
  }
  return false;
}

function passesGroupFilter(
  filter: string | null,
  name: string,
  groupNameMapping: Map<string, string[]>
) {
  return (
    filter === null ||
    includesCaseInsensitive(name, filter) ||
    groupingIncludesJobFilter(groupNameMapping.get(name) ?? [], filter)
  );
}

export function GroupHudTableColumns({
  names,
  filter,
  expandedGroups,
  groupNameMapping,
}: {
  names: string[];
  filter: string | null;
  expandedGroups: Set<string>;
  groupNameMapping: Map<string, string[]>;
}) {
  return (
    <colgroup>
      <col className={styles.colTime} />
      <col className={styles.colSha} />
      <col className={styles.colCommit} />
      <col className={styles.colPr} />
      {names.map((name: string) => {
        const style = passesGroupFilter(filter, name, groupNameMapping)
          ? {}
          : { visibility: "collapse" as any };

        return <col className={styles.colJob} key={name} style={style} />;
      })}
    </colgroup>
  );
}

export function GroupHudTableHeader({
  names,
  filter,
  expandedGroups,
  setExpandedGroups,
  groupNameMapping,
}: {
  names: string[];
  filter: string | null;
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  groupNameMapping: Map<string, string[]>;
}) {
  const groupNames = new Set(groupNameMapping.keys());
  return (
    <thead>
      <tr>
        <th className={styles.regularHeader}>Time</th>
        <th className={styles.regularHeader}>SHA</th>
        <th className={styles.regularHeader}>Commit</th>
        <th className={styles.regularHeader}>PR</th>
        {names.map((name) => {
          const isGroup = groupNames.has(name);
          const style = passesGroupFilter(filter, name, groupNameMapping)
            ? {}
            : { visibility: "collapse" as any };
          const jobStyle = isGroup ? { cursor: "pointer" } : {};
          const headerStyle = isGroup ? { fontWeight: "bold" } : {};
          return (
            <th
              className={styles.jobHeader}
              key={name}
              style={{ ...style, ...jobStyle }}
              onClick={() => {
                if (expandedGroups.has(name)) {
                  expandedGroups.delete(name);
                  setExpandedGroups(new Set(expandedGroups));
                } else {
                  expandedGroups.add(name);
                  setExpandedGroups(new Set(expandedGroups));
                }
              }}
            >
              <div className={styles.jobHeaderName} style={headerStyle}>
                {name}{" "}
                {isGroup ? (
                  expandedGroups.has(name) ? (
                    <BsFillCaretDownFill />
                  ) : (
                    <BsFillCaretRightFill />
                  )
                ) : null}
              </div>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
