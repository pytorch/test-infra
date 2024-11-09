import hudStyles from "components/hud.module.css";
import styles from "components/JobConclusion.module.css";
import TooltipTarget from "components/TooltipTarget";
import {
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";
import { GroupData, IssueData, JobData } from "lib/types";
import { cloneDeep } from "lodash";
import { PinnedTooltipContext } from "pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import { useContext } from "react";
import { ImCross } from "react-icons/im";
import { IoMdCheckmark } from "react-icons/io";
import { MdFlaky } from "react-icons/md";
import { RiErrorWarningFill } from "react-icons/ri";
import { SlClock } from "react-icons/sl";
import { SingleWorkflowDispatcher } from "./WorkflowDispatcher";

export enum GroupedJobStatus {
  Failure = "failure",
  AllNull = "all_null",
  Queued = "queued",
  Success = "success",
  Classified = "classified",
  Flaky = "flaky",
  WarningOnly = "warning",
  Pending = "pending",
}

export enum JobStatus {
  Success = "success",
  Failure = "failure",
  Neutral = "neutral",
  Cancelled = "cancelled",
  Timed_out = "timed_out",
  Skipped = "skipped",
  Queued = "queued",
  Pending = "pending",
}
// Conclusion Group Element used to render the conclusion group.
const conclusionGroupElements: Map<
  string | undefined,
  { name: string; type: string; render: (className?: string) => JSX.Element }
> = new Map([
  [
    GroupedJobStatus.AllNull,

    {
      name: "all null",
      type: GroupedJobStatus.AllNull,
      render: (className) => <span className={className ?? ""}>~</span>,
    },
  ],
  [
    GroupedJobStatus.Success,
    {
      name: "success",
      type: GroupedJobStatus.Success,
      render: (className) => <IoMdCheckmark className={className} />,
    },
  ],
  [
    GroupedJobStatus.Failure,
    {
      name: "failure",
      type: GroupedJobStatus.Failure,
      render: (className) => <ImCross className={className ?? ""} />,
    },
  ],
  [
    GroupedJobStatus.Queued,
    {
      name: "in queue",
      type: GroupedJobStatus.Queued,
      render: (className) => <SlClock className={className ?? ""} />,
    },
  ],
  [
    GroupedJobStatus.Pending,
    {
      name: "pending",
      type: GroupedJobStatus.Pending,
      render: (className) => <SlClock className={`${className ?? ""} ${styles["blink"]}`} />,
    },
  ],
  [
    GroupedJobStatus.Classified,
    {
      name: "classified",
      type: GroupedJobStatus.Classified,
      render: (className) => <span className={className ?? ""}>X</span>,
    },
  ],
  [
    GroupedJobStatus.Flaky,
    {
      name: "flaky",
      type: GroupedJobStatus.Flaky,
      render: (className) => <MdFlaky className={className ?? ""} />,
    },
  ],
  [
    GroupedJobStatus.WarningOnly,
    {
      name: "warning only",
      type: GroupedJobStatus.WarningOnly,
      render: (className) => <RiErrorWarningFill className={className ?? ""} />,
    },
  ],
]);

export function getGroupConclusionElementList() {
  return cloneDeep(Array.from(conclusionGroupElements.values()));
}

export function getGroupConclusionIcon(
  conclusion?: GroupedJobStatus,
  style?: string
) {
  return conclusionGroupElements.has(conclusion) ? (
    conclusionGroupElements.get(conclusion)?.render(style)
  ) : (
    <span className={style ?? ""}>U</span>
  );
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
  let style = pinnedId.name == groupData.groupName ? hudStyles.highlight : "";

  const erroredJobs = [];
  const warningOnlyJobs = [];
  const queuedJobs = [];
  const pendingJobs = [];
  const noStatusJobs = [];
  const failedPreviousRunJobs = [];
  for (const job of groupData.jobs) {
    if (isFailedJob(job)) {
      if (isRerunDisabledTestsJob(job) || isUnstableJob(job, unstableIssues)) {
        warningOnlyJobs.push(job);
      } else {
        erroredJobs.push(job);
      }
    } else if (job.conclusion === JobStatus.Pending) {
      pendingJobs.push(job);
    } else if (job.conclusion === JobStatus.Queued) {
      queuedJobs.push(job);
    } else if (job.conclusion === undefined) {
      noStatusJobs.push(job);
    } else if (job.conclusion === JobStatus.Success && job.failedPreviousRun) {
      failedPreviousRunJobs.push(job);
    }
  }

  let conclusion = GroupedJobStatus.Success;
  if (!(erroredJobs.length === 0)) {
    conclusion = GroupedJobStatus.Failure;
  } else if (!(pendingJobs.length === 0)) {
    conclusion = GroupedJobStatus.Pending;
  } else if (failedPreviousRunJobs.length !== 0) {
    conclusion = GroupedJobStatus.Flaky;
  } else if (!(warningOnlyJobs.length == 0)) {
    conclusion = GroupedJobStatus.WarningOnly;
  } else if (!(queuedJobs.length === 0)) {
    conclusion = GroupedJobStatus.Queued;
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
              queuedJobs={queuedJobs}
              failedPreviousRunJobs={failedPreviousRunJobs}
              sha={sha}
            />
          }
        >
          <span className={styles.conclusion}>
            <span onDoubleClick={toggleExpanded}>
              {getGroupConclusionIcon(
                conclusion,
                isClassified
                  ? styles["classified"]
                  : styles[conclusion ?? "none"]
              )}
            </span>
          </span>
        </TooltipTarget>
      </td>
    </>
  );
}

function GroupTooltip({
  conclusion,
  groupName,
  erroredJobs,
  pendingJobs,
  queuedJobs,
  failedPreviousRunJobs,
  sha,
}: {
  conclusion: GroupedJobStatus;
  groupName: string;
  erroredJobs: JobData[];
  pendingJobs: JobData[];
  queuedJobs: JobData[];
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
  } else if (conclusion === GroupedJobStatus.Queued) {
    return (
      <ToolTip
        conclusion={conclusion}
        groupName={groupName}
        jobs={queuedJobs}
        message={"The following jobs are still in queue:"}
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
