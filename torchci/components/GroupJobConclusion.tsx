import { getGroupConclusionChar } from "lib/JobClassifierUtil";
import { GroupData, JobData } from "lib/types";
import styles from "./JobConclusion.module.css";
import hudStyles from "./hud.module.css";
import TooltipTarget from "components/TooltipTarget";
import { useContext } from "react";
import {
  JobCell,
  PinnedTooltipContext,
} from "pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import {
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";

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
  Classified = "classified",
  Flaky = "flaky",
  WarningOnly = "warning",
}

export default function HudGroupedCell({
  sha,
  groupData,
  isExpanded,
  isClassified,
}: {
  sha: string;
  groupData: GroupData;
  isExpanded: boolean;
  isClassified: boolean;
}) {
  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);
  const style = pinnedId.name == groupData.groupName ? hudStyles.highlight : "";

  const erroredJobs = [];
  const warningOnlyJobs = [];
  const pendingJobs = [];
  const noStatusJobs = [];
  const failedPreviousRunJobs = [];
  for (const job of groupData.jobs) {
    if (isFailedJob(job)) {
      if (isRerunDisabledTestsJob(job) || isUnstableJob(job)) {
        warningOnlyJobs.push(job);
      } else {
        erroredJobs.push(job);
      }
    } else if (job.conclusion === JobStatus.Pending) {
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
  } else if (!(pendingJobs.length === 0)) {
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
              style={{ border: "1px solid gainsboro", padding: "0 1px" }}
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
  failedPreviousRunJobs,
}: {
  conclusion: GroupedJobStatus;
  groupName: string;
  erroredJobs: JobData[];
  pendingJobs: JobData[];
  failedPreviousRunJobs: JobData[];
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
