import FilteredJobList from "./FilteredJobList";
import VersionControlLinks from "./VersionControlLinks";
import { CommitData, JobData } from "lib/types";
import WorkflowBox from "./WorkflowBox";
import styles from "components/commit.module.css";
import _ from "lodash";
import { isFailedJob } from "lib/jobUtils";

function WorkflowsContainer({ jobs }: { jobs: JobData[] }) {
  const byWorkflow = _.groupBy(jobs, (job) => job.workflowName);
  return (
    <div className={styles.workflowContainer}>
      {_.map(byWorkflow, (jobs, workflowName) => {
        return (
          <WorkflowBox
            key={workflowName}
            workflowName={workflowName}
            jobs={jobs}
          />
        );
      })}
    </div>
  );
}

export default function CommitStatus({ commit }: { commit: CommitData }) {
  return (
    <>
      <VersionControlLinks sha={commit.sha} diffNum={commit.diffNum} />

      <article className={styles.commitMessage}>
        {commit.commitMessageBody}
      </article>

      <FilteredJobList
        filterName="Failed jobs"
        jobs={commit.jobs}
        pred={isFailedJob}
      />

      <FilteredJobList
        filterName="Pending jobs"
        jobs={commit.jobs}
        pred={(job) => job.conclusion === "pending"}
      />

      <WorkflowsContainer jobs={commit.jobs} />
    </>
  );
}
