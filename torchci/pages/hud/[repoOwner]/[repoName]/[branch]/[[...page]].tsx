import {
  GroupHudTableColumns,
  GroupHudTableHeader
} from "components/GroupHudTableHeaders";
import HudGroupedCell from "components/GroupJobConclusion";
import styles from "components/hud.module.css";
import JobConclusion from "components/JobConclusion";
import JobFilterInput from "components/JobFilterInput";
import JobTooltip from "components/JobTooltip";
import { LocalTimeHuman } from "components/TimeUtils";
import TooltipTarget from "components/TooltipTarget";
import { includesCaseInsensitive } from "lib/GeneralUtils";
import { getGroupingData } from "lib/JobClassifierUtil";
import {
  formatHudUrlForRoute,
  HudData,
  HudParams,
  JobData,
  packHudParams,
  RowData
} from "lib/types";
import useHudData from "lib/useHudData";
import UserSettingContext from "lib/UserSettingsContext";
import useTableFilter from "lib/useTableFilter";
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import React, { createContext, useContext, useEffect, useState } from "react";

export function JobCell({ sha, job }: { sha: string; job: JobData }) {
  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  return (
    <td onDoubleClick={() => window.open(job.htmlUrl)}>
      <TooltipTarget
        id={`${sha}-${job.name}`}
        pinnedId={pinnedId}
        setPinnedId={setPinnedId}
        tooltipContent={<JobTooltip job={job} />}
      >
        <JobConclusion conclusion={job.conclusion} />
      </TooltipTarget>
    </td>
  );
}

function HudRow({
  rowData,
  expandedGroups,
}: {
  rowData: RowData;
  expandedGroups: Set<string>;
}) {
  const router = useRouter();
  const params = packHudParams(router.query);
  const sha = rowData.sha;
  return (
    <tr>
      <td className={styles.jobMetadata}>
        <LocalTimeHuman timestamp={rowData.time} />
      </td>
      <td className={styles.jobMetadata}>
        <a href={rowData.commitUrl}>{sha.substring(0, 7)}</a>
      </td>
      <td className={styles.jobMetadata}>
        <div className={styles.jobMetadataTruncated}>
          {/* here, we purposefully do not use Link/. The prefetch behavior
          (even with prefetch disabled) spams our backend).*/}
          <a href={`/${params.repoOwner}/${params.repoName}/commit/${sha}`}>
            {rowData.commitTitle}
          </a>
        </div>
      </td>
      <td className={styles.jobMetadata}>
        {rowData.prNum !== null && (
          <a
            href={`https://github.com/${params.repoOwner}/${params.repoName}/pull/${rowData.prNum}`}
          >
            #{rowData.prNum}
          </a>
        )}
      </td>
      <HudJobCells rowData={rowData} expandedGroups={expandedGroups} />
    </tr>
  );
}

function HudJobCells({
  rowData,
  expandedGroups,
}: {
  rowData: RowData;
  expandedGroups: Set<string>;
}) {
  const { userSettings } = useContext(UserSettingContext);
  if (!userSettings.useGrouping) {
    return (
      <>
        {rowData.jobs.map((job: JobData) => (
          <JobCell sha={rowData.sha} key={job.name} job={job} />
        ))}
      </>
    );
  } else {
    return (
      <>
        {(rowData?.groupedJobs ?? []).map((group, ind) => {
          return (
            <HudGroupedCell
              sha={rowData.sha}
              key={ind}
              groupData={group}
              isExpanded={expandedGroups.has(group.groupName)}
            />
          );
        })}
      </>
    );
  }
}

function HudTableColumns({
  names,
  filter,
}: {
  names: string[];
  filter: string | null;
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

function HudTableHeader({
  names,
  filter,
}: {
  names: string[];
  filter: string | null;
}) {
  return (
    <thead>
      <tr>
        <th className={styles.regularHeader}>Time</th>
        <th className={styles.regularHeader}>SHA</th>
        <th className={styles.regularHeader}>Commit</th>
        <th className={styles.regularHeader}>PR</th>
        {names.map((name) => {
          const passesFilter =
            filter === null || includesCaseInsensitive(name, filter);
          const style = passesFilter ? {} : { visibility: "collapse" as any };
          return (
            <th className={styles.jobHeader} key={name} style={style}>
              <div className={styles.jobHeaderName}>{name}</div>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

function HudTableBody({
  shaGrid,
  expandedGroups = new Set(),
}: {
  shaGrid: RowData[];
  expandedGroups?: Set<string>;
}) {
  expandedGroups;
  return (
    <tbody>
      {shaGrid.map((row: RowData) => (
        <HudRow key={row.sha} rowData={row} expandedGroups={expandedGroups} />
      ))}
    </tbody>
  );
}

function FilterableHudTable({
  params,
  jobNames,
  children,
}: {
  params: HudParams;
  jobNames: string[];
  children: React.ReactNode;
}) {
  const { jobFilter, handleSubmit, handleInput, normalizedJobFilter } =
    useTableFilter(params);

  return (
    <>
      <JobFilterInput
        currentFilter={jobFilter}
        handleSubmit={handleSubmit}
        handleInput={handleInput}
      />
      <GroupViewCheckBox />
      <table className={styles.hudTable}>
        <HudTableColumns filter={normalizedJobFilter} names={jobNames} />
        <HudTableHeader filter={normalizedJobFilter} names={jobNames} />
        {children}
      </table>
    </>
  );
}

function GroupFilterableHudTable({
  params,
  groupNameMapping,
  children,
  names,
  expandedGroups,
  setExpandedGroups,
}: {
  params: HudParams;
  groupNameMapping: Map<string, string[]>;
  children: React.ReactNode;
  names: string[];
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const { jobFilter, handleSubmit, handleInput, normalizedJobFilter } =
    useTableFilter(params);

  return (
    <>
      <JobFilterInput
        currentFilter={jobFilter}
        handleSubmit={handleSubmit}
        handleInput={handleInput}
      />
      <GroupViewCheckBox />
      <table className={styles.hudTable}>
        <GroupHudTableColumns
          filter={normalizedJobFilter}
          names={names}
          groupNameMapping={groupNameMapping}
        />
        <GroupHudTableHeader
          filter={normalizedJobFilter}
          names={names}
          expandedGroups={expandedGroups}
          setExpandedGroups={setExpandedGroups}
          groupNameMapping={groupNameMapping}
        />
        {children}
      </table>
    </>
  );
}

function GroupViewCheckBox() {
  const { userSettings, setUserSettings } = useContext(UserSettingContext);
  return (
    <>
      <input
        type="checkbox"
        name="groupView"
        checked={userSettings.useGrouping}
        onChange={() => {
          setUserSettings({
            ...userSettings,
            useGrouping: !userSettings.useGrouping,
          });
        }}
      />
      <label htmlFor="groupView"> Use grouped view</label>
      <br />
    </>
  );
}

function HudTable({ params }: { params: HudParams }) {
  const { userSettings } = useContext(UserSettingContext);

  return userSettings.useGrouping ? (
    <GroupedView params={params} />
  ) : (
    <UngroupedView params={params} />
  );
}

function PageSelector({ params }: { params: HudParams }) {
  return (
    <div>
      Page {params.page}:{" "}
      {params.page !== 0 ? (
        <span>
          <Link
            href={formatHudUrlForRoute("hud", {
              ...params,
              page: params.page - 1,
            })}
          >
            Prev
          </Link>{" "}
          |{" "}
        </span>
      ) : null}
      <Link
        href={formatHudUrlForRoute("hud", { ...params, page: params.page + 1 })}
      >
        Next
      </Link>
    </div>
  );
}

function ParamSelector({
  value,
  handleSubmit,
}: {
  value: string;
  handleSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  const [isInput, setIsInput] = useState(false);
  if (isInput) {
    return (
      <form
        className={styles.branchForm}
        onSubmit={handleSubmit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setIsInput(false);
          }
        }}
      >
        <input autoFocus className={styles.branchFormInput} type="text"></input>
      </form>
    );
  }

  return (
    <code style={{ cursor: "pointer" }} onClick={() => setIsInput(true)}>
      {value}
    </code>
  );
}

function HudHeader({ params }: { params: HudParams }) {
  function handleBranchSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // @ts-ignore
    const branch = e.target[0].value;
    window.location.href = formatHudUrlForRoute("hud", { ...params, branch });
  }
  function handleRepoSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // @ts-ignore
    const repoOwnerAndName = e.target[0].value;
    const split = repoOwnerAndName.split("/");
    window.location.href = formatHudUrlForRoute("hud", {
      ...params,
      repoOwner: split[0],
      repoName: split[1],
    });
  }

  return (
    <h1>
      <ParamSelector
        value={`${params.repoOwner}/${params.repoName}`}
        handleSubmit={handleRepoSubmit}
      />
      :{" "}
      <ParamSelector value={params.branch} handleSubmit={handleBranchSubmit} />
    </h1>
  );
}

export const PinnedTooltipContext = createContext<[null | string, any]>([
  null,
  null,
]);

export default function Hud() {
  const router = useRouter();
  const params = packHudParams(router.query);

  // Logic to handle tooltip pinning. The behavior we want is:
  // - If the user clicks on a tooltip, it should be pinned.
  // - While a tooltip is pinned, we don't show any other tooltips.
  // - Clicking outside the tooltip or pressing esc should unpin it.
  // This state needs to be set up at this level because we want to capture all
  // clicks.
  const [userSettings, setUserSettings] = useState({
    useGrouping: true,
  });

  useEffect(() => {
    if (params.nameFilter != null) {
      setUserSettings({ useGrouping: false });
    }
  }, [params.nameFilter]);
  const [pinnedTooltip, setPinnedTooltip] = useState<string | null>(null);
  function handleClick() {
    setPinnedTooltip(null);
  }
  useEffect(() => {
    document.addEventListener("keydown", (e) => {
      if (e.code === "Escape") {
        setPinnedTooltip(null);
      }
    });
  }, []);

  return (
    <>
      <Head>
        <title>
          PyTorch CI HUD (
          {`${params.repoOwner}/${params.repoName}: ${params.branch}`})
        </title>
      </Head>
      <UserSettingContext.Provider value={{ userSettings, setUserSettings }}>
        <PinnedTooltipContext.Provider
          value={[pinnedTooltip, setPinnedTooltip]}
        >
          {params.branch !== undefined && (
            <div onClick={handleClick}>
              <HudHeader params={params} />
              <div>This page automatically updates.</div>
              <HudTable params={params} />
              <PageSelector params={params} />
            </div>
          )}
        </PinnedTooltipContext.Provider>
      </UserSettingContext.Provider>
    </>
  );
}

function UngroupedView({ params }: { params: HudParams }) {
  const data = useHudData(params);
  if (data === undefined) {
    return <div>Loading...</div>;
  }
  const { shaGrid, jobNames } = data;

  // Here, we are intentionally injecting HudTableBody into the
  // FilterableHudTable component. This is for rendering performance; we don't
  // want React to re-render the whole table every time the filter changes.
  return (
    <FilterableHudTable params={params} jobNames={jobNames}>
      <HudTableBody shaGrid={shaGrid} />
    </FilterableHudTable>
  );
}

function GroupedView({ params }: { params: HudParams }) {
  const data = useHudData(params);
  if (data === undefined) {
    return <div>Loading...</div>;
  }

  return <GroupedHudTable params={params} data={data} />;
}

function GroupedHudTable({
  params,
  data,
}: {
  params: HudParams;
  data: HudData;
}) {
  const { shaGrid, groupNameMapping } = getGroupingData(
    data.shaGrid,
    data.jobNames
  );
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
  const groupNames = Array.from(groupNameMapping.keys());
  let names = groupNames;

  expandedGroups.forEach((group) => {
    const nameInd = names.indexOf(group);
    names = [
      ...names.slice(0, nameInd + 1),
      ...(groupNameMapping.get(group) ?? []),
      ...names.slice(nameInd + 1),
    ];
  });

  return (
    <GroupFilterableHudTable
      params={params}
      groupNameMapping={groupNameMapping}
      names={names}
      expandedGroups={expandedGroups}
      setExpandedGroups={setExpandedGroups}
    >
      <HudTableBody shaGrid={shaGrid} expandedGroups={expandedGroups} />
    </GroupFilterableHudTable>
  );
}
