import FilteredJobList from "./FilteredJobList";
import VersionControlLinks from "./VersionControlLinks";
import { CommitData, JobData } from "lib/types";
import WorkflowBox from "./WorkflowBox";
import styles from "components/commit.module.css";
import _ from "lodash";
import {
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";
import { linkIt, UrlComponent, urlRegex } from "react-linkify-it";
import { getConclusionSeverityForSorting } from "../lib/JobClassifierUtil";
import useScrollTo from "lib/useScrollTo";
import PeriodicWorkflows from "./PeriodicWorkflows";
import { useSession } from "next-auth/react";

function WorkflowsContainer({ jobs }: { jobs: JobData[] }) {
  useScrollTo();

  if (jobs.length === 0) {
    return null;
  }
  const byWorkflow = _(jobs)
    .groupBy((job) => job.workflowName)
    .sortBy(
      (jobs) =>
        _(jobs)
          .map((job) => getConclusionSeverityForSorting(job.conclusion))
          .max(), // put failing workflows first
      (jobs) => jobs.length // put worflows of similar lenghts together to keep the display more compact
    )
    .reverse()
    .value();

  return (
    <>
      <h1>Workflows</h1>
      <div className={styles.workflowContainer}>
        {_.map(byWorkflow, (jobs) => {
          let workflowName = "" + jobs[0].workflowName;
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
  repoOwner,
  repoName,
  commit,
  jobs,
}: {
  repoOwner: string;
  repoName: string;
  commit: CommitData;
  jobs: JobData[];
}) {
  const session = useSession();
  const isAuthenticated = session.status === "authenticated";

  return (
    <>
      <VersionControlLinks
        githubUrl={commit.commitUrl}
        diffNum={commit.diffNum}
      />

      <article className={styles.commitMessage}>
        {linkIt(
          commit.commitMessageBody,
          (match, key) => (
            <UrlComponent match={match} key={key} />
          ),
          urlRegex
        )}
      </article>
      <FilteredJobList
        filterName="Failed jobs"
        jobs={jobs}
        pred={(job) =>
          isFailedJob(job) &&
          !isRerunDisabledTestsJob(job) &&
          !isUnstableJob(job)
        }
        showClassification
      />
      <FilteredJobList
        filterName="Failed unstable jobs"
        jobs={jobs}
        pred={(job) => isFailedJob(job) && isUnstableJob(job)}
      />
      <FilteredJobList
        filterName="Daily rerunning disabled jobs"
        jobs={jobs}
        pred={(job) => isFailedJob(job) && isRerunDisabledTestsJob(job)}
      />
      <FilteredJobList
        filterName="Pending jobs"
        jobs={jobs}
        pred={(job) => job.conclusion === "pending"}
      />
      <WorkflowsContainer jobs={jobs} />
      {isAuthenticated && (
        <PeriodicWorkflows
          repoOwner={repoOwner}
          repoName={repoName}
          commit={commit}
          jobs={jobs}
          session={session.data}
        />
      )}
    </>
  );
}
