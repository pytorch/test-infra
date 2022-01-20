import styles from "./JobConclusion.module.css";

export default function JobConclusion({ conclusion }: { conclusion?: string }) {
  let conclusionChar;
  let style;
  switch (conclusion) {
    case "success":
      conclusionChar = "O";
      style = styles.success;
      break;
    case "failure":
      conclusionChar = "X";
      style = styles.failure;
      break;
    case "neutral":
      conclusionChar = "N";
      style = styles.neutral;
      break;
    case "cancelled":
      conclusionChar = "C";
      style = styles.cancelled;
      break;
    case "timed_out":
      conclusionChar = "T";
      style = styles.timedOut;
      break;
    case "skipped":
      conclusionChar = "S";
      style = styles.skipped;
      break;
    case "pending":
      conclusionChar = "?";
      style = styles.pending;
      break;
    case undefined:
      style = styles.none;
      conclusionChar = "O";
      break;
    default:
      // shouldn't happen
      conclusionChar = "U";
  }
  return (
    <span className={styles.conclusion}>
      <span className={style}>{conclusionChar}</span>
    </span>
  );
}
