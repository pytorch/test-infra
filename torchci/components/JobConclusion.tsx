import { getConclusionChar } from "lib/JobClassifierUtil";
import { JobStatus } from "./GroupJobConclusion";
import styles from "./JobConclusion.module.css";

export default function JobConclusion({
  conclusion,
  classified = false,
  failedPreviousRun = false,
  warningOnly = false,
}: {
  conclusion?: string;
  classified?: boolean;
  failedPreviousRun?: boolean;
  warningOnly?: boolean;
}) {
  const style = warningOnly
    ? styles["warning"]
    : classified
    ? styles["classified"]
    : conclusion == JobStatus.Success && failedPreviousRun
    ? styles["flaky"]
    : styles[conclusion ?? "none"];
  return (
    <span className={styles.conclusion}>
      <span className={style}>
        {getConclusionChar(conclusion, failedPreviousRun)}
      </span>
    </span>
  );
}
