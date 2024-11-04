import TooltipTarget from "components/TooltipTarget";
import { RiProgress5Fill } from "react-icons/ri";
import { MdFlaky } from "react-icons/md";

import {
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";
import { GroupData, IssueData, JobData } from "lib/types";
import { PinnedTooltipContext } from "pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import { useContext } from "react";
import hudStyles from "./hud.module.css";
import styles from "./JobConclusion.module.css";
import { SingleWorkflowDispatcher } from "./WorkflowDispatcher";
import { MdCheckCircle } from "react-icons/md";
import { ImCross } from "react-icons/im";
import { FaClock } from "react-icons/fa";
import { RiErrorWarningFill } from "react-icons/ri";


export enum JobStatus {
  Success = "success",
  Failure = "failure",
  Neutral = "neutral",
  Cancelled = "cancelled",
  Timed_out = "timed_out",
  Skipped = "skipped",
  Pending = "pending",
  In_progress = "in_progress"
}

export enum GroupedJobStatus {
  Failure = "failure",
  Pending = "pending",
  In_Progress = "in_progress",
  AllNull = "all_null",
  Success = "success",
  Classified = "classified",
  Flaky = "flaky",
  WarningOnly = "warning",
}

export default function HudGroupedCell({
  sha,
  groupData,
  isExpanded,
  toggleExpanded,
  isClassified,
  unstableIssues,
}: {
  sha: string;
  groupData: GroupData;
  isExpanded: boolean;
  toggleExpanded: () => void;
  isClassified: boolean;
  unstableIssues: IssueData[];
}) {
  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  const style = pinnedId.name == groupData.groupName ? hudStyles.highlight : "";

  const erroredJobs = [];
  const warningOnlyJobs = [];
  const pendingJobs = [];
  const inProgressJobs = [];
  const noStatusJobs = [];
  const failedPreviousRunJobs = [];
  for (const job of groupData.jobs) {
    if (isFailedJob(job)) {
      if (isRerunDisabledTestsJob(job) || isUnstableJob(job, unstableIssues)) {
        warningOnlyJobs.push(job);
      } else {
        erroredJobs.push(job);
      }
    } else if (job.conclusion == JobStatus.In_progress){
      inProgressJobs.push(job)
    }
     else if (job.conclusion === JobStatus.Pending) {
      pendingJobs.push(job);
    } else if (job.conclusion === undefined) {
      noStatusJobs.push(job);
    } else if (job.conclusion === JobStatus.Success && job.failedPreviousRun) {
      failedPreviousRunJobs.push(job);
    }
  }

  let conclusion = GroupedJobStatus.Success;
  if (!(erroredJobs.length === 0)) {
    conclusion = GroupedJobStatus.Failure;
  }else if (!(inProgressJobs.length === 0)) {
    conclusion = GroupedJobStatus.In_Progress;
  }
  else if (!(pendingJobs.length === 0)) {
    conclusion = GroupedJobStatus.Pending;
  } else if (failedPreviousRunJobs.length !== 0) {
    conclusion = GroupedJobStatus.Flaky;
  } else if (!(warningOnlyJobs.length == 0)) {
    conclusion = GroupedJobStatus.WarningOnly;
  } else if (noStatusJobs.length === groupData.jobs.length) {
    conclusion = GroupedJobStatus.AllNull;
  }

  return (
    <>
      <td className={style}>
        <TooltipTarget
          sha={sha}
          name={groupData.groupName}
          pinnedId={pinnedId}
          setPinnedId={setPinnedId}
          tooltipContent={
            <GroupTooltip
              conclusion={conclusion}
              groupName={groupData.groupName}
              erroredJobs={erroredJobs}
              pendingJobs={pendingJobs}
              failedPreviousRunJobs={failedPreviousRunJobs}
              sha={sha}
            />
          }
        >
          <span className={styles.conclusion}>
            <span
              className={
                isClassified
                  ? styles["classified"]
                  : styles[conclusion ?? "none"]
              }
              onDoubleClick={toggleExpanded}
              style={{ border: "1px solid gainsboro", padding: "0 1px" }}
            >
              {getGroupConclusionIcon(conclusion,isClassified? styles["classified"]: styles[conclusion ?? "none"])}
            </span>
          </span>
        </TooltipTarget>
      </td>
    </>
  );
}

export function getGroupConclusionIcon(conclusion?: GroupedJobStatus, style?: string) {
  switch (conclusion) {
    case GroupedJobStatus.Success:
      return <MdCheckCircle className={style}> </MdCheckCircle>;
    case GroupedJobStatus.Failure:
      return <ImCross className={style}></ImCross>;
    case GroupedJobStatus.In_Progress:
      return (<RiProgress5Fill className={style}></RiProgress5Fill>);
    case GroupedJobStatus.Pending:
      return (<FaClock className={style}></FaClock>);
    case GroupedJobStatus.AllNull:
      return "~";
    case GroupedJobStatus.Classified:
      return "X";
    case GroupedJobStatus.Flaky:
      return <MdFlaky className={style}></MdFlaky>;
    case GroupedJobStatus.WarningOnly:
      return <RiErrorWarningFill className={style}> </RiErrorWarningFill>
    default:
      return "U";
  }
}

function GroupTooltip({
  conclusion,
  groupName,
  erroredJobs,
  pendingJobs,
  failedPreviousRunJobs,
  sha,
}: {
  conclusion: GroupedJobStatus;
  groupName: string;
  erroredJobs: JobData[];
  pendingJobs: JobData[];
  failedPreviousRunJobs: JobData[];
  sha?: string;
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
  } else if (conclusion === GroupedJobStatus.Flaky) {
    return (
      <ToolTip
        conclusion={conclusion}
        groupName={groupName}
        jobs={failedPreviousRunJobs}
        message={"The following jobs were flaky:"}
      />
    );
  } else if (conclusion === GroupedJobStatus.AllNull) {
    return (
      <div>
        {`[${conclusion}] ${groupName}`}
        <div>
          All jobs were skipped
          {sha && <SingleWorkflowDispatcher sha={sha} jobName={groupName} />}
        </div>
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
