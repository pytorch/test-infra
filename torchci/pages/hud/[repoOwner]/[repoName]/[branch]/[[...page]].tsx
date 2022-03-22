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
import { getGroupingData } from "lib/JobClassifierUtil";
import {
  formatHudUrlForRoute,
  HudData,
  HudParams,
  JobData,
  packHudParams,
  RowData,
} from "lib/types";
import useHudData from "lib/useHudData";
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
  useGrouping,
}: {
  rowData: RowData;
  expandedGroups: Set<string>;
  useGrouping: boolean;
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
      <HudJobCells
        rowData={rowData}
        expandedGroups={expandedGroups}
        useGrouping={useGrouping}
      />
    </tr>
  );
}

function HudJobCells({
  rowData,
  expandedGroups,
  useGrouping,
}: {
  rowData: RowData;
  expandedGroups: Set<string>;
  useGrouping: boolean;
}) {
  if (!useGrouping) {
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

function HudTableBody({
  shaGrid,
  expandedGroups = new Set(),
  useGrouping,
}: {
  shaGrid: RowData[];
  expandedGroups?: Set<string>;
  useGrouping: boolean;
}) {
  expandedGroups;
  return (
    <tbody>
      {shaGrid.map((row: RowData) => (
        <HudRow
          key={row.sha}
          rowData={row}
          expandedGroups={expandedGroups}
          useGrouping={useGrouping}
        />
      ))}
    </tbody>
  );
}

function GroupFilterableHudTable({
  params,
  groupNameMapping,
  children,
  names,
  groupNames,
  expandedGroups,
  setExpandedGroups,
  useGrouping,
  setUseGrouping,
}: {
  params: HudParams;
  groupNameMapping: Map<string, string[]>;
  children: React.ReactNode;
  names: string[];
  groupNames: string[];
  expandedGroups: Set<string>;
  setExpandedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
  useGrouping: boolean;
  setUseGrouping: any;
}) {
  const { jobFilter, handleSubmit, handleInput, normalizedJobFilter } =
    useTableFilter(params);
  const headerNames = useGrouping ? groupNames : names;
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
      <input
        type="checkbox"
        name="groupView"
        checked={useGrouping}
        onChange={() => {
          setUseGrouping(!useGrouping);
        }}
      />
      <label htmlFor="groupView"> Use grouped view</label>
      <br />
    </>
  );
}

function HudTable({ params }: { params: HudParams }) {
  return <GroupedView params={params} />;
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
            <div>This page automatically updates.</div>
            <HudTable params={params} />
            <PageSelector params={params} />
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
  const { shaGrid, groupNameMapping } = getGroupingData(
    data.shaGrid,
    data.jobNames
  );
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
  const [useGrouping, setUseGrouping] = useState(
    !(params.nameFilter != null && params.nameFilter !== "")
  );

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
      names={data.jobNames}
      groupNames={names}
      expandedGroups={expandedGroups}
      setExpandedGroups={setExpandedGroups}
      useGrouping={useGrouping}
      setUseGrouping={setUseGrouping}
    >
      <HudTableBody
        shaGrid={shaGrid}
        expandedGroups={expandedGroups}
        useGrouping={useGrouping}
      />
    </GroupFilterableHudTable>
  );
}
