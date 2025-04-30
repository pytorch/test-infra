import TooltipTarget from "components/TooltipTarget";
import { getGroupConclusionChar } from "lib/JobClassifierUtil";
import {
  isCancellationSuccessJob,
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";
import { IssueData, JobData } from "lib/types";
import {
  MonsterFailuresContext,
  PinnedTooltipContext,
} from "pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import { useContext } from "react";
import hudStyles from "./hud.module.css";
import { getFailureEl } from "./JobConclusion";
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

// React component to render either a group conclusion character or monsterized icons for failures
function GroupConclusionContent({
  conclusion,
  isClassified,
  erroredJobs,
  toggleExpanded,
  monsterFailures,
}: {
  conclusion: GroupedJobStatus;
  isClassified: boolean;
  erroredJobs: JobData[];
  toggleExpanded: () => void;
  monsterFailures: boolean;
}) {
  // Only show monsters for failures and when monsterized failures is enabled
  if (conclusion !== GroupedJobStatus.Failure || !monsterFailures) {
    return (
      <span
        className={`${styles.conclusion} ${
          isClassified ? styles["classified"] : styles[conclusion ?? "none"]
        }`}
        onDoubleClick={toggleExpanded}
        style={{
          border: "1px solid gainsboro",
          padding: "0 1px",
        }}
      >
        {getGroupConclusionChar(conclusion)}
      </span>
    );
  }

  // Get only unique monster icons based on their sprite index
  const seenMonsterSprites = new Set();
  const allMonsters = [];

  for (const job of erroredJobs) {
    if (job.failureLines && job.failureLines[0]) {
      const monsterEl = getFailureEl(JobStatus.Failure, job);
      if (monsterEl) {
        // Get the sprite index from the data attribute
        const spriteIdx = monsterEl.props["data-monster-hash"];

        if (!seenMonsterSprites.has(spriteIdx)) {
          seenMonsterSprites.add(spriteIdx);
          allMonsters.push(monsterEl);
        }
      }
    }
  }

  if (allMonsters.length === 0) {
    // Fallback to X if no monsters could be generated
    return (
      <span
        className={
          isClassified ? styles["classified"] : styles[conclusion ?? "none"]
        }
        onDoubleClick={toggleExpanded}
        style={{
          border: "1px solid gainsboro",
          padding: "0 1px",
        }}
      >
        {getGroupConclusionChar(conclusion)}
      </span>
    );
  }

  // Show the first monster icon with a count in bottom right
  const firstMonster = allMonsters[0];

  return (
    <span
      className={`${styles.monster_with_count} ${styles.conclusion}`}
      onDoubleClick={toggleExpanded}
      title={`${allMonsters.length} unique failure ${
        allMonsters.length === 1 ? "type" : "types"
      }`}
    >
      {firstMonster}
      {allMonsters.length > 1 && (
        <span className={styles.monster_count}>{allMonsters.length}</span>
      )}
    </span>
  );
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
  const [monsterFailures] = useContext(MonsterFailuresContext);
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
      if (
        isRerunDisabledTestsJob(job) ||
        isUnstableJob(job, unstableIssues) ||
        isCancellationSuccessJob(job)
      ) {
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
          {monsterFailures && conclusion === GroupedJobStatus.Failure ? (
            <span className={styles.conclusion}>
              <span
                className={
                  viableStrictBlocking ? styles.viablestrict_blocking : ""
                }
                style={{ padding: "0 1px" }}
              >
                <GroupConclusionContent
                  conclusion={conclusion}
                  isClassified={isClassified}
                  erroredJobs={erroredJobs}
                  toggleExpanded={toggleExpanded}
                  monsterFailures={monsterFailures}
                />
              </span>
            </span>
          ) : (
            <span
              className={`${styles.conclusion} ${
                viableStrictBlocking ? styles.viablestrict_blocking : ""
              }`}
            >
              <GroupConclusionContent
                conclusion={conclusion}
                isClassified={isClassified}
                erroredJobs={erroredJobs}
                toggleExpanded={toggleExpanded}
                monsterFailures={monsterFailures}
              />
            </span>
          )}
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
  const [monsterFailures] = useContext(MonsterFailuresContext);

  if (conclusion === GroupedJobStatus.Failure) {
    // Show monster icons in the tooltip if monsterFailures is enabled
    if (monsterFailures) {
      // Group jobs by monster sprite index
      const monsterGroups = new Map(); // Map of spriteIdx -> {monsterEl, jobs[]}

      for (const job of erroredJobs) {
        if (job.failureLines && job.failureLines[0]) {
          const monsterEl = getFailureEl(JobStatus.Failure, job);
          if (monsterEl) {
            // Get the sprite index from the data attribute
            const spriteIdx = monsterEl.props["data-monster-hash"];

            if (!monsterGroups.has(spriteIdx)) {
              monsterGroups.set(spriteIdx, { monsterEl, jobs: [] });
            }

            // Add this job to the group with this monster
            monsterGroups.get(spriteIdx).jobs.push(job);
          }
        }
      }

      // Convert the map to an array for rendering
      const monsterGroupsArray = Array.from(monsterGroups.values());

      return (
        <div>
          {`[${conclusion}] ${groupName}`}
          <div>The following jobs errored out:</div>
          {monsterGroupsArray.map((group, groupIndex) => (
            <div key={groupIndex} style={{ margin: "10px 0" }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                {group.monsterEl}
                <span style={{ marginLeft: "8px", fontWeight: "bold" }}>
                  {group.jobs.length > 1
                    ? `${group.jobs.length} jobs with this error type:`
                    : "1 job with this error type:"}
                </span>
              </div>
              {group.jobs.map((job: JobData, jobIndex: number) => (
                <div
                  key={jobIndex}
                  style={{ marginLeft: "24px", marginTop: "4px" }}
                >
                  <a href={job.htmlUrl} target="_blank" rel="noreferrer">
                    {job.name}
                  </a>
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    }

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
