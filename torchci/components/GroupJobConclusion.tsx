import { getGroupConclusionChar } from "lib/JobClassifierUtil";
import { GroupData, JobData } from "lib/types";
import styles from "./JobConclusion.module.css";
import TooltipTarget from "components/TooltipTarget";
import { useContext } from "react";
import {
  JobCell,
  PinnedTooltipContext,
} from "pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";

export enum JobStatus {
  Success = "success",
  Failure = "failure",
  Neutral = "neutral",
  Cancelled = "cancelled",
  Timed_out = "timed_out",
  Skipped = "skipped",
  Pending = "pending",
}

export enum GroupedJobStatus {
  Failure = "failure",
  Pending = "pending",
  AllNull = "all_null",
  Success = "success",
}

export default function HudGroupedCell({
  sha,
  groupData,
  isExpanded,
}: {
  sha: string;
  groupData: GroupData;
  isExpanded: boolean;
}) {
  const erroredJobs = [];
  const pendingJobs = [];
  const noStatusJobs = [];
  for (const job of groupData.jobs) {
    if (
      job.conclusion === JobStatus.Failure ||
      job.conclusion === JobStatus.Timed_out ||
      job.conclusion === JobStatus.Cancelled
    ) {
      erroredJobs.push(job);
    } else if (job.conclusion === JobStatus.Pending) {
      pendingJobs.push(job);
    } else if (job.conclusion === undefined) {
      noStatusJobs.push(job);
    }
  }

  let conclusion = GroupedJobStatus.Success;
  if (!(erroredJobs.length === 0)) {
    conclusion = GroupedJobStatus.Failure;
  } else if (!(pendingJobs.length === 0)) {
    conclusion = GroupedJobStatus.Pending;
  } else if (noStatusJobs.length === groupData.jobs.length) {
    conclusion = GroupedJobStatus.AllNull;
  }

  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  return (
    <>
      <td>
        <TooltipTarget
          id={`${sha}-${groupData.groupName}`}
          pinnedId={pinnedId}
          setPinnedId={setPinnedId}
          tooltipContent={
            <GroupTooltip
              conclusion={conclusion}
              groupName={groupData.groupName}
              erroredJobs={erroredJobs}
              pendingJobs={pendingJobs}
            />
          }
        >
          <span className={styles.conclusion}>
            <span
              className={styles[conclusion ?? "none"]}
              style={{ border: "1px solid gainsboro" }}
            >
              {getGroupConclusionChar(conclusion)}
            </span>
          </span>
        </TooltipTarget>
      </td>
      {isExpanded ? (
        <>
          {groupData.jobs.map((job, ind) => {
            return <JobCell key={ind} sha={sha} job={job} />;
          })}
        </>
      ) : null}
    </>
  );
}

function GroupTooltip({
  conclusion,
  groupName,
  erroredJobs,
  pendingJobs,
}: {
  conclusion: GroupedJobStatus;
  groupName: string;
  erroredJobs: JobData[];
  pendingJobs: JobData[];
}) {
  if (conclusion === GroupedJobStatus.Failure) {
    return (
      <ToolTip
        conclusion={conclusion}
        groupName={groupName}
        jobs={erroredJobs}
        message={"The following jobs errored out:"}
      />
    );
  } else if (conclusion === GroupedJobStatus.Pending) {
    return (
      <ToolTip
        conclusion={conclusion}
        groupName={groupName}
        jobs={pendingJobs}
        message={"The following jobs are still pending:"}
      />
    );
  } else if (conclusion === GroupedJobStatus.AllNull) {
    return (
      <div>
        {`[${conclusion}] ${groupName}`}
        <div>All jobs were skipped</div>
      </div>
    );
  }
  return (
    <div>
      {`[${conclusion}] ${groupName}`}
      <div>All jobs passed</div>
    </div>
  );
}

function ToolTip({
  conclusion,
  groupName,
  message,
  jobs,
}: {
  conclusion: string;
  groupName: string;
  message: string;
  jobs: JobData[];
}) {
  return (
    <div>
      {`[${conclusion}] ${groupName}`}
      <div>{message}</div>
      {jobs.map((job, ind) => {
        return (
          <a
            key={ind}
            href={job.htmlUrl}
            target="_blank"
            rel="noreferrer"
            style={{ display: "block" }}
          >
            {job.name}
          </a>
        );
      })}
    </div>
  );
}
