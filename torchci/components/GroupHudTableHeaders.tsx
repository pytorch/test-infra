import styles from "components/hud.module.css";
import { includesCaseInsensitive } from "lib/GeneralUtils";
import {
  GroupingContext,
  PinnedTooltipContext,
} from "pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import React, { useContext } from "react";
import { BsFillCaretDownFill, BsFillCaretRightFill } from "react-icons/bs";

function groupingIncludesJobFilter(jobNames: string[], filter: string) {
  for (const jobName of jobNames) {
    if (includesCaseInsensitive(jobName, filter)) {
      return true;
    }
  }
  return false;
}

export function passesGroupFilter(
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

export function GroupHudTableColumns({ names }: { names: string[] }) {
  return (
    <colgroup>
      <col className={styles.colTime} />
      <col className={styles.colSha} />
      <col className={styles.colCommit} />
      <col className={styles.colPr} />
      <col className={styles.colAuthor} />
      {names.map((name: string) => {
        return <col className={styles.colJob} key={name} />;
      })}
    </colgroup>
  );
}

export function GroupHudTableHeader({ names }: { names: string[] }) {
  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  const { groupNameMapping, expandedGroups, setExpandedGroups } =
    useContext(GroupingContext);

  const groupNames = new Set(groupNameMapping.keys());
  return (
    <thead>
      <tr>
        <th className={styles.regularHeader}>Time</th>
        <th className={styles.regularHeader}>SHA</th>
        <th className={styles.regularHeader}>Commit</th>
        <th className={styles.regularHeader}>PR</th>
        <th className={styles.regularHeader}>Author</th>
        {names.map((name) => {
          const isGroup = groupNames.has(name);
          const pinnedStyle = pinnedId.name == name ? styles.highlight : "";
          const jobStyle = isGroup ? { cursor: "pointer" } : {};
          const headerStyle = isGroup ? { fontWeight: "bold" } : {};
          return (
            <th
              className={styles.jobHeader}
              key={name}
              style={{ ...jobStyle }}
              onClick={(e: React.MouseEvent) => {
                if (expandedGroups.has(name)) {
                  expandedGroups.delete(name);
                  setExpandedGroups(new Set(expandedGroups));
                } else {
                  expandedGroups.add(name);
                  setExpandedGroups(new Set(expandedGroups));
                }
                e.stopPropagation();
                setPinnedId({ sha: undefined, name: name });
              }}
            >
              <div className={styles.jobHeaderName} style={headerStyle}>
                <span className={pinnedStyle}>
                  {name}{" "}
                  {isGroup ? (
                    expandedGroups.has(name) ? (
                      <BsFillCaretDownFill />
                    ) : (
                      <BsFillCaretRightFill />
                    )
                  ) : null}
                </span>
              </div>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
