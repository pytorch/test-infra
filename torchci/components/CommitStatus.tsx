import FilteredJobList from "./FilteredJobList";
import VersionControlLinks from "./VersionControlLinks";
import { CommitData, JobData } from "lib/types";
import WorkflowBox from "./WorkflowBox";
import styles from "components/commit.module.css";
import _ from "lodash";
import { isFailedJob } from "lib/jobUtils";

function WorkflowsContainer({ jobs }: { jobs: JobData[] }) {
  const byWorkflow = _.groupBy(jobs, (job) => job.workflowName);
  if (jobs.length === 0) {
    return null;
  }
  return (
    <>
      <h1>Workflows</h1>
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
    </>
  );
}

export default function CommitStatus({
  commit,
  jobs,
}: {
  commit: CommitData;
  jobs: JobData[];
}) {
  return (
    <>
      <VersionControlLinks
        githubUrl={commit.commitUrl}
        diffNum={commit.diffNum}
      />

      <article className={styles.commitMessage}>
        {commit.commitMessageBody}
      </article>
      <FilteredJobList
        filterName="Failed jobs"
        jobs={jobs}
        pred={isFailedJob}
        showJobLinks={true}
      />
      <FilteredJobList
        filterName="Pending jobs"
        jobs={jobs}
        pred={(job) => job.conclusion === "pending"}
      />
      <WorkflowsContainer jobs={jobs} />
    </>
  );
}
