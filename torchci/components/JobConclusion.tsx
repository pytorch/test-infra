import { getConclusionChar } from "lib/JobClassifierUtil";
import styles from "./JobConclusion.module.css";

export default function JobConclusion({
  conclusion,
  classified = false,
}: {
  conclusion?: string;
  classified?: boolean;
}) {
  return (
    <span className={styles.conclusion}>
      <span
        className={
          classified ? styles["classified"] : styles[conclusion ?? "none"]
        }
      >
        {getConclusionChar(conclusion)}
      </span>
    </span>
  );
}
