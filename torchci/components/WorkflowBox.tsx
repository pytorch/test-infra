import { isFailedJob } from "lib/jobUtils";
import { JobData } from "lib/types";
import styles from "components/commit.module.css";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";

export default function WorkflowBox({
    workflowName,
    jobs,
  }: {
    workflowName: string;
    jobs: JobData[];
  }) {
    const isFailed = jobs.some(isFailedJob) !== false;
    const workflowClass = isFailed
      ? styles.workflowBoxFail
      : styles.workflowBoxSuccess;
    return (
      <div className={workflowClass}>
        <h3>{workflowName}</h3>
        {jobs.map((job) => (
          <div key={job.id}>
            <JobSummary job={job} />
            <LogViewer job={job} />
          </div>
        ))}
      </div>
    );
  }
