import TooltipTarget from "components/TooltipTarget";
import { getGroupConclusionChar } from "lib/JobClassifierUtil";
import {
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";
import { IssueData, JobData } from "lib/types";
import { PinnedTooltipContext } from "pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import { useContext } from "react";
import hudStyles from "./hud.module.css";
import styles from "./JobConclusion.module.css";
import { SingleWorkflowDispatcher } from "./WorkflowDispatcher";

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

type RepoViableStrictBlockingJobsMap = {
  [key: string]: RegExp[];
};

// TODO: Move this to a config file
const VIABLE_STRICT_BLOCKING_JOBS: RepoViableStrictBlockingJobsMap = {
  // Source of truth for these jobs is in https://github.com/pytorch/pytorch/blob/main/.github/workflows/update-viablestrict.yml#L26
  "pytorch/pytorch": [/trunk/i, /pull/i, /linux-binary/i, /lint/i],
};

function isJobViableStrictBlocking(
  jobName: string | undefined,
  repoOwner: string,
  repoName: string
): boolean {
  if (!jobName) {
    return false;
  }

  const repo = `${repoOwner}/${repoName}`;
  let viablestrict_blocking_jobs_patterns =
    VIABLE_STRICT_BLOCKING_JOBS[repo] ?? [];

  for (const regex of viablestrict_blocking_jobs_patterns) {
    if (jobName.match(regex)) {
      return true;
    }
  }
  return false;
}

export default function HudGroupedCell({
  sha,
  groupName,
  jobs,
  isExpanded,
  toggleExpanded,
  isClassified,
  unstableIssues,
  repoOwner,
  repoName,
}: {
  sha: string;
  groupName: string;
  jobs: JobData[];
  isExpanded: boolean;
  toggleExpanded: () => void;
  isClassified: boolean;
  unstableIssues: IssueData[];
  repoOwner: string;
  repoName: string;
}) {
  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  const style = pinnedId.name == groupName ? hudStyles.highlight : "";

  const erroredJobs = [];
  const warningOnlyJobs = [];
  const queuedJobs = [];
  const pendingJobs = [];
  const noStatusJobs = [];
  const failedPreviousRunJobs = [];

  let viableStrictBlocking = false;
  for (const job of jobs) {
    if (isFailedJob(job)) {
      if (isRerunDisabledTestsJob(job) || isUnstableJob(job, unstableIssues)) {
        warningOnlyJobs.push(job);
      } else {
        erroredJobs.push(job);
        if (isJobViableStrictBlocking(job.name, repoOwner, repoName)) {
          viableStrictBlocking = true;
        }
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
  } else if (noStatusJobs.length === jobs.length) {
    conclusion = GroupedJobStatus.AllNull;
  }

  return (
    <>
      <td className={style}>
        <TooltipTarget
          sha={sha}
          name={groupName}
          pinnedId={pinnedId}
          setPinnedId={setPinnedId}
          tooltipContent={
            <GroupTooltip
              conclusion={conclusion}
              groupName={groupName}
              erroredJobs={erroredJobs}
              pendingJobs={pendingJobs}
              queuedJobs={queuedJobs}
              failedPreviousRunJobs={failedPreviousRunJobs}
              sha={sha}
            />
          }
        >
          <span
            className={`${styles.conclusion} ${
              viableStrictBlocking ? styles.viablestrict_blocking : ""
            }`}
          >
            <span
              className={
                isClassified
                  ? styles["classified"]
                  : styles[conclusion ?? "none"]
              }
              onDoubleClick={toggleExpanded}
              style={{
                border: "1px solid gainsboro",
                padding: "0 1px",
              }}
            >
              {getGroupConclusionChar(conclusion)}
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
