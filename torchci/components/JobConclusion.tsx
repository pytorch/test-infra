import { getConclusionChar } from "lib/JobClassifierUtil";
import { JobStatus } from "./GroupJobConclusion";
import styles from "./JobConclusion.module.css";

export default function JobConclusion({
  conclusion,
  classified = false,
  failedPreviousRun = false,
}: {
  conclusion?: string;
  classified?: boolean;
  failedPreviousRun?: boolean;
}) {
  const style = classified
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
