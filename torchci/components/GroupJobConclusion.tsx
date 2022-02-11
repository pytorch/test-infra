import { getConclusionChar } from "lib/JobClassifierUtil";
import { GroupData, JobData } from "lib/types";
import styles from "./JobConclusion.module.css";
import TooltipTarget from "components/TooltipTarget";
import { useContext } from "react";
import { PinnedTooltipContext } from "pages/hud/[repoOwner]/[repoName]/[branch]/[page]";

enum JobStatus {
  Success = "success",
  Failure = "failure",
  Neutral = "neutral",
  Cancelled = "cancelled",
  Timed_out = "timed_out",
  Skipped = "skipped",
  Pending = "pending",
}

export default function HudGroupedCell({
  sha,
  groupData,
}: {
  sha: string;
  groupData: GroupData;
}) {
  let conclusionChar = "0";
  let style = styles.success;
  const erroredJobs = [];
  const pendingJobs = [];

  for (const job of groupData.jobs) {
    if (
      job.conclusion === JobStatus.Failure ||
      job.conclusion === JobStatus.Timed_out ||
      job.conclusion === JobStatus.Cancelled
    ) {
      erroredJobs.push(job);
    } else if (job.conclusion === JobStatus.Pending) {
      pendingJobs.push(job);
    }
  }

  let conclusion = "success";
  if (!(erroredJobs.length === 0)) {
    conclusion = "failure";
  } else if (!(pendingJobs.length === 0)) {
    conclusion = "pending";
  }
  const [pinnedId, setPinnedId] = useContext(PinnedTooltipContext);

  return (
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
          <span className={styles[conclusion ?? "none"]}>
            {getConclusionChar(conclusion)}
          </span>
        </span>
      </TooltipTarget>
    </td>
  );
}

function GroupTooltip({
  conclusion,
  groupName,
  erroredJobs,
  pendingJobs,
}: {
  conclusion: string;
  groupName: string;
  erroredJobs: JobData[];
  pendingJobs: JobData[];
}) {
  if (conclusion === "failure") {
    return (
      <div>
        {`[${conclusion}] ${groupName}`}
        <div>The following jobs errored out:</div>
        {erroredJobs.map((erroredJob, ind) => (
          <a
            key={ind}
            href={erroredJob.htmlUrl}
            target="_blank"
            rel="noreferrer"
          >
            {erroredJob.name}
          </a>
        ))}
      </div>
    );
  } else if (conclusion === "pending") {
    console.log("ERRORED JOBS ARE", pendingJobs);

    return (
      <div>
        {`[${conclusion}] ${groupName}`}
        <div>The following jobs are still pending:</div>
        {pendingJobs.map((pendingJob, ind) => {
          return (
            <a
              key={ind}
              href={pendingJob.htmlUrl}
              target="_blank"
              rel="noreferrer"
            >
              {pendingJob.jobName}
            </a>
          );
        })}
      </div>
    );
  }
  return (
    <div>
      {`[${conclusion}] ${groupName}`}
      <div>All relevant jobs passed</div>
    </div>
  );
}
