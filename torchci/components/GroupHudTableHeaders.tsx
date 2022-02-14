import styles from "components/hud.module.css";
import { includesCaseInsensitive } from "lib/GeneralUtils";
import React from "react";
import { BsFillCaretDownFill, BsFillCaretRightFill } from "react-icons/bs";

export function GroupHudTableColumns({
  names,
  filter,
  expandedGroups,
}: {
  names: string[];
  filter: string | null;
  expandedGroups: Set<string>;
}) {
  return (
    <colgroup>
      <col className={styles.colTime} />
      <col className={styles.colSha} />
      <col className={styles.colCommit} />
      <col className={styles.colPr} />
      {names.map((name: string) => {
        const passesFilter =
          filter === null || includesCaseInsensitive(name, filter);
        const style = passesFilter ? {} : { visibility: "collapse" as any };

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
  groupNames,
}: {
  names: string[];
  filter: string | null;
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  groupNames: Set<string>;
}) {
  return (
    <thead>
      <tr>
        <th className={styles.regularHeader}>Time</th>
        <th className={styles.regularHeader}>SHA</th>
        <th className={styles.regularHeader}>Commit</th>
        <th className={styles.regularHeader}>PR</th>
        {names.map((name) => {
          const isGroup = groupNames.has(name);
          const passesFilter =
            filter === null || includesCaseInsensitive(name, filter);
          const style = passesFilter ? {} : { visibility: "collapse" as any };
          const cursorStyle = isGroup ? {} : { cursor: "pointer" };

          return (
            <th
              className={styles.jobHeader}
              key={name}
              style={{ ...style, ...cursorStyle }}
              onClick={() => {
                if (expandedGroups.has(name)) {
                  expandedGroups.delete(name);
                  setExpandedGroups(new Set());
                } else {
                  expandedGroups.add(name);
                  setExpandedGroups(new Set(expandedGroups));
                }
              }}
            >
              <div className={styles.jobHeaderName}>
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
