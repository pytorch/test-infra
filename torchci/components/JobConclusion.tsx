import { getConclusionChar } from "lib/JobClassifierUtil";
import styles from "./JobConclusion.module.css";

export default function JobConclusion({ conclusion }: { conclusion?: string }) {
  return (
    <span className={styles.conclusion}>
      <span className={styles[conclusion ?? "none"]}>
        {getConclusionChar(conclusion)}
      </span>
    </span>
  );
}
