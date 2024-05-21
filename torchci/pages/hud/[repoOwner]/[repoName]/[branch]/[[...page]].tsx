import {
  GroupHudTableColumns,
  GroupHudTableHeader,
} from "components/GroupHudTableHeaders";
import HudGroupedCell from "components/GroupJobConclusion";
import styles from "components/hud.module.css";
import JobConclusion from "components/JobConclusion";
import JobFilterInput from "components/JobFilterInput";
import JobTooltip from "components/JobTooltip";
import { LocalTimeHuman } from "components/TimeUtils";
import TooltipTarget from "components/TooltipTarget";
import {
  getGroupingData,
  groups,
  sortGroupNamesForHUD,
  isUnstableGroup,
} from "lib/JobClassifierUtil";
import {
  formatHudUrlForRoute,
  Highlight,
  HudData,
  HudParams,
  JobData,
  packHudParams,
  RowData,
  IssueData,
} from "lib/types";
import useHudData from "lib/useHudData";
import useTableFilter from "lib/useTableFilter";
import Head from "next/head";
import { useRouter } from "next/router";
import React, { createContext, useContext, useEffect, useState } from "react";
import PageSelector from "components/PageSelector";
import {
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";
import {
  useGroupingPreference,
  usePreference,
} from "lib/useGroupingPreference";
import { track } from "lib/track";
import useSWR from "swr";
import { fetcher } from "lib/GeneralUtils";
import { ParamSelector } from "lib/ParamSelector";

export function JobCell({
  sha,
  job,
  unstableIssues,
}: {
  sha: string;
  job: JobData;
  unstableIssues: IssueData[];
}) {
  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  const style = pinnedId.name == job.name ? styles.highlight : "";
  return (
    <td onDoubleClick={() => window.open(job.htmlUrl)}>
      <TooltipTarget
        pinnedId={pinnedId}
        setPinnedId={setPinnedId}
        tooltipContent={<JobTooltip job={job} sha={pinnedId.sha || sha} />}
        sha={sha as string}
        name={job.name as string}
      >
        <div className={`${styles.center} ${style}`}>
          <JobConclusion
            conclusion={job.conclusion}
            failedPreviousRun={job.failedPreviousRun}
            classified={job.failureAnnotation != null}
            warningOnly={
              isFailedJob(job) &&
              (isRerunDisabledTestsJob(job) ||
                isUnstableJob(job, unstableIssues))
            }
          />
        </div>
      </TooltipTarget>
    </td>
  );
}

function HudRow({
  rowData,
  expandedGroups,
  names,
  unstableIssues,
}: {
  rowData: RowData;
  expandedGroups: Set<string>;
  names: string[];
  unstableIssues: IssueData[];
}) {
  const router = useRouter();
  const params = packHudParams(router.query);
  const sha = rowData.sha;

  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  const style = pinnedId.sha == sha ? styles.highlight : "";

  function clickCommit(e: React.MouseEvent) {
    if (pinnedId.name !== undefined || pinnedId.sha !== undefined) {
      return;
    }
    e.stopPropagation();
    setPinnedId({ sha: rowData.sha, name: undefined });
  }

  return (
    <tr className={style} onClick={(e) => clickCommit(e)}>
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
            title={
              rowData.isForcedMerge
                ? rowData.isForcedMergeWithFailures
                  ? "Forced merge with failures that were merge-blocking"
                  : "Forced merge. Had no merge-blocking failures"
                : undefined
            }
          >
            {rowData.isForcedMerge ? (
              <mark
                className={
                  rowData.isForcedMergeWithFailures
                    ? styles.forcedMergeWithFailure
                    : styles.forcedMerge
                }
              >
                #{rowData.prNum}
              </mark>
            ) : (
              <div>#{rowData.prNum}</div>
            )}
          </a>
        )}
      </td>
      <td className={styles.jobMetadata}>
        <div className={styles.jobMetadataTruncatedAuthor}>
          {rowData.authorUrl !== null ? (
            <a href={rowData.authorUrl}>{rowData.author}</a>
          ) : (
            rowData.author
          )}
        </div>
      </td>
      <HudJobCells
        rowData={rowData}
        expandedGroups={expandedGroups}
        names={names}
        unstableIssues={unstableIssues}
      />
    </tr>
  );
}

function HudJobCells({
  rowData,
  expandedGroups,
  names,
  unstableIssues,
}: {
  rowData: RowData;
  expandedGroups: Set<string>;
  names: string[];
  unstableIssues: IssueData[];
}) {
  let groupNames = groups.map((group) => group.name).concat("other");

  return (
    <>
      {names.map((name) => {
        if (groupNames.includes(name)) {
          let numClassified = 0;
          for (const job of rowData.groupedJobs?.get(name)?.jobs ?? []) {
            if (job.failureAnnotation != null) {
              numClassified++;
            }
          }
          const failedJobs = rowData.groupedJobs
            ?.get(name)
            ?.jobs.filter(isFailedJob);
          return (
            <HudGroupedCell
              sha={rowData.sha}
              key={name}
              groupData={rowData.groupedJobs?.get(name)!}
              isExpanded={expandedGroups.has(name)}
              isClassified={
                numClassified != 0 && numClassified == failedJobs?.length
              }
              unstableIssues={unstableIssues}
            />
          );
        } else {
          const job = rowData.nameToJobs?.get(name);
          return (
            <JobCell
              sha={rowData.sha}
              key={name}
              job={job!}
              unstableIssues={unstableIssues}
            />
          );
        }
      })}
    </>
  );
}

function HudTableBody({
  shaGrid,
  expandedGroups = new Set(),
  names,
  unstableIssues,
}: {
  shaGrid: RowData[];
  expandedGroups?: Set<string>;
  names: string[];
  unstableIssues: IssueData[];
}) {
  return (
    <tbody>
      {shaGrid.map((row: RowData) => (
        <HudRow
          key={row.sha}
          rowData={row}
          expandedGroups={expandedGroups}
          names={names}
          unstableIssues={unstableIssues}
        />
      ))}
    </tbody>
  );
}

function GroupFilterableHudTable({
  params,
  groupNameMapping,
  children,
  groupNames,
  expandedGroups,
  setExpandedGroups,
  useGrouping,
  setUseGrouping,
  hideUnstable,
  setHideUnstable,
}: {
  params: HudParams;
  groupNameMapping: Map<string, string[]>;
  children: React.ReactNode;
  groupNames: string[];
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  useGrouping: boolean;
  setUseGrouping: any;
  hideUnstable: boolean;
  setHideUnstable: any;
}) {
  const { jobFilter, handleSubmit, handleInput, normalizedJobFilter } =
    useTableFilter(params);
  const headerNames = groupNames;
  return (
    <>
      <JobFilterInput
        currentFilter={jobFilter}
        handleSubmit={handleSubmit}
        handleInput={handleInput}
        handleFocus={() => {
          setUseGrouping(false);
        }}
      />
      <GroupViewCheckBox
        useGrouping={useGrouping}
        setUseGrouping={setUseGrouping}
      />
      <UnstableCheckBox
        hideUnstable={hideUnstable}
        setHideUnstable={setHideUnstable}
      />
      <table className={styles.hudTable}>
        <GroupHudTableColumns
          filter={normalizedJobFilter}
          names={headerNames}
          groupNameMapping={groupNameMapping}
        />
        <GroupHudTableHeader
          filter={normalizedJobFilter}
          names={headerNames}
          expandedGroups={expandedGroups}
          setExpandedGroups={setExpandedGroups}
          groupNameMapping={groupNameMapping}
        />
        {children}
      </table>
    </>
  );
}

function GroupViewCheckBox({
  useGrouping,
  setUseGrouping,
}: {
  useGrouping: boolean;
  setUseGrouping: any;
}) {
  return (
    <>
      <div
        onClick={() => {
          setUseGrouping(!useGrouping);
        }}
      >
        <input
          type="checkbox"
          name="groupView"
          checked={useGrouping}
          onChange={() => {}}
        />
        <label htmlFor="groupView"> Use grouped view</label>
      </div>
    </>
  );
}

function UnstableCheckBox({
  hideUnstable,
  setHideUnstable,
}: {
  hideUnstable: boolean;
  setHideUnstable: any;
}) {
  return (
    <>
      <div
        onClick={() => {
          setHideUnstable(!hideUnstable);
        }}
      >
        <input
          type="checkbox"
          name="hideUnstable"
          checked={hideUnstable}
          onChange={() => {}}
        />
        <label htmlFor="hideUnstable"> Hide unstable jobs</label>
      </div>
    </>
  );
}

function HudTable({ params }: { params: HudParams }) {
  return <GroupedView params={params} />;
}

function HudHeader({ params }: { params: HudParams }) {
  function handleBranchSubmit(branch: string) {
    window.location.href = formatHudUrlForRoute("hud", { ...params, branch });
  }
  function handleRepoSubmit(repoOwnerAndName: string) {
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

export const PinnedTooltipContext = createContext<[Highlight, any]>([
  { sha: undefined, name: undefined },
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

  const [pinnedTooltip, setPinnedTooltip] = useState<Highlight>({
    sha: undefined,
    name: undefined,
  });
  function handleClick() {
    setPinnedTooltip({ sha: undefined, name: undefined });
  }
  useEffect(() => {
    document.addEventListener("keydown", (e) => {
      if (e.code === "Escape") {
        setPinnedTooltip({ sha: undefined, name: undefined });
      }
    });
  }, []);
  const title =
    params.repoOwner != null && params.repoName != null && params.branch != null
      ? ` (${params.repoOwner}/${params.repoName}: ${params.branch})`
      : "";
  return (
    <>
      <Head>
        <title>PyTorch CI HUD {title}</title>
      </Head>
      <PinnedTooltipContext.Provider value={[pinnedTooltip, setPinnedTooltip]}>
        {params.branch !== undefined && (
          <div onClick={handleClick}>
            <HudHeader params={params} />
            <HudTable params={params} />
            <PageSelector params={params} baseUrl="hud" />
            <br />
            <div>
              <em>This page automatically updates.</em>
            </div>
          </div>
        )}
      </PinnedTooltipContext.Provider>
    </>
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
  const { data: unstableIssuesData } = useSWR(`/api/issue/unstable`, fetcher, {
    dedupingInterval: 300 * 1000,
    refreshInterval: 300 * 1000, // refresh every 5 minutes
  });

  const { shaGrid, groupNameMapping } = getGroupingData(
    data.shaGrid,
    data.jobNames,


    unstableIssuesData ? unstableIssuesData.issues : []
  );
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());

  const [useGrouping, setUseGrouping] = useGroupingPreference(
    params.nameFilter != null && params.nameFilter !== ""
  );

  const router = useRouter();
  useEffect(() => {
    // Only run on component mount, this assumes that the user's preference is
    // the value in local storage
    track(router, "groupingPreference", { useGrouping: useGrouping });
  }, []);

  const [hideUnstable, setHideUnstable] = usePreference("hideUnstable");

  const groupNames = Array.from(groupNameMapping.keys());
  let names = sortGroupNamesForHUD(groupNames);

  if (useGrouping) {
    expandedGroups.forEach((group) => {
      const nameInd = names.indexOf(group);
      names = [
        ...names.slice(0, nameInd + 1),
        ...(groupNameMapping.get(group) ?? []),
        ...names.slice(nameInd + 1),
      ];
    });
    if (hideUnstable) {
      names = names.filter(
        (name) =>
          !isUnstableGroup(
            name,
            unstableIssuesData ? unstableIssuesData.issues : []
          )
      );
    }
  } else {
    names = [...data.jobNames];
    groups.forEach((group) => {
      if (
        groupNames.includes(group.name) &&
        (group.persistent ||
          (isUnstableGroup(
            group.name,
            unstableIssuesData ? unstableIssuesData.issues : []
          ) &&
            hideUnstable))
      ) {
        // Add group name, take out all the jobs that belong to that group
        // unless the group is expanded
        names.push(group.name);
        names = names.filter(
          (name) => !groupNameMapping.get(group.name)?.includes(name)
        );
        if (expandedGroups.has(group.name)) {
          names = names.concat(groupNameMapping.get(group.name) ?? []);
        }
      }
    });
  }

  return (
    <GroupFilterableHudTable
      params={params}
      groupNameMapping={groupNameMapping}
      groupNames={names}
      expandedGroups={expandedGroups}
      setExpandedGroups={setExpandedGroups}
      useGrouping={useGrouping}
      setUseGrouping={setUseGrouping}
      hideUnstable={hideUnstable}
      setHideUnstable={setHideUnstable}
    >
      <HudTableBody
        shaGrid={shaGrid}
        expandedGroups={expandedGroups}
        names={names}
        unstableIssues={unstableIssuesData ? unstableIssuesData.issues : []}
      />
    </GroupFilterableHudTable>
  );
}
