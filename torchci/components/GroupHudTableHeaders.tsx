import styles from "components/hud.module.css";
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
  groupNameMapping,
}: {
  names: string[];
  filter: string | null;
  groupNameMapping: Map<string, string[]>;
}) {
  return (
    <colgroup>
      <col className={styles.colTime} />
      <col className={styles.colSha} />
      <col className={styles.colCommit} />
      <col className={styles.colPr} />
      <col className={styles.colAuthor} />
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
  useStickyColumns,
}: {
  names: string[];
  filter: string | null;
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  groupNameMapping: Map<string, string[]>;
  useStickyColumns: boolean;
}) {
  const groupNames = new Set(groupNameMapping.keys());

  function getStyle(style: string) {
    let s = `${style} ${styles.regularHeader}`
    if (useStickyColumns) {
      return `${s} ${styles.sticky}`;
    }
    return s;
  }

  return (
    <thead>
      <tr>
        <th className={getStyle(styles.colTime)}>Time</th>
        <th className={getStyle(styles.colSha)}>SHA</th>
        <th className={getStyle(styles.colCommit)}>Commit</th>
        <th className={getStyle(styles.colPr)}>PR</th>
        <th className={getStyle(styles.colAuthor)}>Author</th>
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
