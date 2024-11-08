import { JobStatus } from "lib/JobClassifierUtil";
import { cloneDeep } from "lodash";
import { useContext } from "react";
import { FaClock } from "react-icons/fa";
import { ImCross } from "react-icons/im";
import { IoIosCheckmarkCircleOutline } from "react-icons/io";
import { IoBanOutline } from "react-icons/io5";
import { MdOutlineTimerOff } from "react-icons/md";
import { RiProgress5Fill } from "react-icons/ri";
import { JobData } from "../lib/types";
import { MonsterFailuresContext } from "../pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import styles from "./JobConclusion.module.css";

// Conclustion Element used to render the conclusion of a job
const jobConclusionElementMap: Map<
  string | undefined,
  { name: string; type: string; render: (className?: string) => JSX.Element }
> = new Map([
  [
    JobStatus.Cancelled,
    {
      name: "cancelled",
      type: JobStatus.Cancelled,
      render: (className?: string) => (
        <IoBanOutline className={className ?? ""}></IoBanOutline>
      ),
    },
  ],
  [
    JobStatus.Neutral,
    {
      name: "neutral",
      type: JobStatus.Neutral,
      render: (className?: string) => (
        <span className={className ?? ""}>N</span>
      ),
    },
  ],
  [
    JobStatus.Failure,
    {
      name: "failure",
      type: JobStatus.Failure,
      render: (className?: string) => (
        <ImCross className={className ?? ""}></ImCross>
      ),
    },
  ],
  [
    JobStatus.Pending,
    {
      name: "pending",
      type: JobStatus.Pending,
      render: (className?: string) => (
        <FaClock className={className ?? ""}></FaClock>
      ),
    },
  ],
  [
    JobStatus.Queued,
    {
      name: "in queue",
      type: JobStatus.Queued,
      render: (className?: string) => (
        <RiProgress5Fill className={className}></RiProgress5Fill>
      ),
    },
  ],
  [
    JobStatus.Timed_out,
    {
      name: "time_out",
      type: JobStatus.Timed_out,
      render: (className?: string) => (
        <MdOutlineTimerOff className={className ?? ""}></MdOutlineTimerOff>
      ),
    },
  ],
  [
    JobStatus.Skipped,
    {
      name: "skipped",
      type: JobStatus.Skipped,
      render: (className?: string) => (
        <span className={className ?? ""}>S</span>
      ),
    },
  ],
  [
    JobStatus.Success,
    {
      name: "success",
      type: JobStatus.Success,
      render: (className?: string) => (
        <IoIosCheckmarkCircleOutline
          className={className}
        ></IoIosCheckmarkCircleOutline>
      ),
    },
  ],
  [
    undefined,
    {
      name: "success",
      type: JobStatus.Success,
      render: (className?: string) => (
        <span className={className ?? ""}>~</span>
      ),
    },
  ],
]);

export function getJobConclusionElementList() {
  return cloneDeep(Array.from(jobConclusionElementMap.values()));
}

export function getConclusionIcon(
  conclusion?: string,
  className?: string,
  failedPreviousRun?: boolean
) {
  className = className ?? styles[conclusion ?? "undefined"];
  if (conclusion === JobStatus.Success) {
    if (failedPreviousRun) {
      return jobConclusionElementMap.get(JobStatus.Failure)?.render(className);
    }
    return jobConclusionElementMap.get(conclusion)?.render(className);
  }
  return jobConclusionElementMap.has(conclusion) ? (
    jobConclusionElementMap.get(conclusion)?.render(className)
  ) : (
    <span className={className}>U</span>
  );
}

/**
 * `getFailureEl` generates a div with a monster sprite element based on the first line of `failureLines` in `jobData`.
 *
 * @param {string} conclusion - The conclusion of the job. It should be `JobStatus.Failure` for the function to proceed.
 * @param {JobData} jobData - The data of the job. It should contain `failureLines` for the function to proceed.
 *
 * @returns {JSX.Element} - A div element with a monster sprite as a background image.
 * If the conclusion is not `JobStatus.Failure` or `jobData.failureLines` is not defined or empty, an empty object is returned.
 */
const getFailureEl = (conclusion?: string, jobData?: JobData) => {
  if (
    conclusion !== JobStatus.Failure ||
    !jobData?.failureLines ||
    !jobData.failureLines[0]
  ) {
    return undefined;
  }
  const error = jobData?.failureLines && jobData.failureLines[0];

  // Generate hash value from the error string
  let hashValue = hashJobFailureString(error);

  // Calculate the background position
  // 278 sprites in total
  const spriteIdx = hashValue % 278;
  const x = (spriteIdx % 10) * 15.26;
  const y = Math.floor(spriteIdx / 10) * (640 / 28 / 1.5);

  // Create and return the style object
  return (
    <div
      className={styles.failure_monster}
      style={/*background position*/ { backgroundPosition: `-${x}px -${y}px` }}
    />
  );
};

/**
 * Generate a hash value from a job failure string.
 */
const hashJobFailureString = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    // skip whitespace, newlines and digits
    if (char === 32 || char === 10 || (char >= 48 && char <= 57)) {
      continue;
    }
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
};

export default function JobConclusion({
  conclusion,
  classified = false,
  failedPreviousRun = false,
  warningOnly = false,
  jobData,
}: {
  conclusion?: string;
  classified?: boolean;
  failedPreviousRun?: boolean;
  warningOnly?: boolean;
  jobData?: JobData;
}) {
  const style = warningOnly
    ? styles["warning"]
    : classified
    ? styles["classified"]
    : conclusion == JobStatus.Success && failedPreviousRun
    ? styles["flaky"]
    : styles[conclusion ?? "none"];

  const [monsterFailures] = useContext(MonsterFailuresContext);
  const failureEl = monsterFailures && getFailureEl(conclusion, jobData);

  return (
    <span className={styles.conclusion}>
      {(failureEl && failureEl) || (
        <div>{getConclusionIcon(conclusion, style, failedPreviousRun)}</div>
      )}
    </span>
  );
}
