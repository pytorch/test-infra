import { getConclusionChar } from "lib/JobClassifierUtil";
import { useContext } from "react";
import { JobData } from "../lib/types";
import { MonsterFailuresContext } from "../pages/hud/[repoOwner]/[repoName]/[branch]/[[...page]]";
import { JobStatus } from "./GroupJobConclusion";
import styles from "./JobConclusion.module.css";
import { RiProgress5Fill } from "react-icons/ri";
import { MdCheckCircle } from "react-icons/md";
import { FaClock } from "react-icons/fa";
import { ImCross } from "react-icons/im";
import { IoBanOutline } from "react-icons/io5";
import { MdOutlineTimerOff } from "react-icons/md";
import { CiCircleCheck } from "react-icons/ci";

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
        <span className={style}>
          {getConclusionCharIcon(conclusion,style, failedPreviousRun)}
        </span>
      )}
    </span>
  );
}

export function getConclusionCharIcon(
  conclusion?: string,
  style?:string,
  failedPreviousRun?: boolean
) {
  switch (conclusion) {
    case JobStatus.Success:
      if (failedPreviousRun) {
        return <ImCross className={style}></ImCross>;
      }
      return <CiCircleCheck      className={style}> </CiCircleCheck>
    case JobStatus.Failure:
      return <ImCross className={style}></ImCross>;
    case JobStatus.Neutral:
      return "N";
    case JobStatus.Cancelled:
      return <IoBanOutline className={style}></IoBanOutline>;
    case JobStatus.Timed_out:
      return <MdOutlineTimerOff className={style}></MdOutlineTimerOff>;
    case JobStatus.Skipped:
      return "S";
    case JobStatus.Pending:
      return (<FaClock className={style}></FaClock>);
    case JobStatus.In_progress:
       return (<RiProgress5Fill className={style}></RiProgress5Fill>);
    case undefined:
      return "~";
    default:
      return "U";
  }
}
