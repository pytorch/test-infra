import { IssueData } from "lib/types";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import useSWR from "swr";
import styles from "./SevReport.module.css";

function SevBox({ issue }: { issue: IssueData }) {
  return (
    <div className={styles.sevBox}>
      <a href="https://github.com/pytorch/pytorch/wiki/%5BWIP%5D-What-is-a-SEV">
        SEV:
      </a>{" "}
      {issue.title} (<a href={issue.html_url}>#{issue.number}</a>)
    </div>
  );
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());
export default function SevReport() {
  let { data: issues } = useSWR<IssueLabelApiResponse>(
    `/api/issue/${encodeURIComponent("ci: sev")}`,
    fetcher,
    {
      refreshInterval: 60 * 1000, // refresh every minute
      // Refresh even when the user isn't looking, so that switching to the tab
      // will always have fresh info.
      refreshWhenHidden: true,
    }
  );
  if (issues === undefined) {
    return null;
  }
  issues = issues.filter((issue: IssueData) => issue.state === "open");
  if (issues.length === 0) {
    return null;
  }

  return (
    <div>
      {issues.map((issue) => (
        <SevBox key={issue.number} issue={issue} />
      ))}
    </div>
  );
}
