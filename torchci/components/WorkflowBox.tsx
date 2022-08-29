import styles from "components/commit.module.css";
import { fetcher } from "lib/GeneralUtils";
import { isFailedJob } from "lib/jobUtils";
import { Artifact, JobData } from "lib/types";
import useSWR from "swr";
import JobArtifact from "./JobArtifact";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";
import { getConclusionSeverityForSorting } from "../lib/JobClassifierUtil";

function sortJobsByConclusion( jobA: JobData, jobB: JobData): number {
  // Show failed jobs first, then pending jobs, then successful jobs
  if (jobA.conclusion !== jobB.conclusion) {
    return getConclusionSeverityForSorting(jobB.conclusion) - getConclusionSeverityForSorting(jobA.conclusion);
  }

  // Jobs with the same conclusion are sorted alphabetically
  return ('' + jobA.jobName).localeCompare('' + jobB.jobName);  // the '' forces the type to be a string
}

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

  const workflowId = jobs[0].workflowId;
  return (
    <div className={workflowClass}>
      <h3>{workflowName}</h3>
      <h4>Job Status</h4>
      <>
        {jobs.sort(sortJobsByConclusion).map((job) => (
          <div key={job.id}>
            <JobSummary job={job} />
            {isFailedJob(job) && (<LogViewer job={job} />)}
          </div>
        ))}
      </>
      <>{workflowId && <Artifacts workflowId={workflowId} />}</>
    </div>
  );
}

function Artifacts({ workflowId }: { workflowId: string }) {
  const { data, error } = useSWR(`/api/artifacts/s3/${workflowId}`, fetcher, {
    refreshInterval: 60 * 1000,
    refreshWhenHidden: true,
  });
  if (data == null) {
    return <div>Loading...</div>;
  }

  if (error != null) {
    return (
      <div style={{ color: "red" }}>Error occured while fetching artifacts</div>
    );
  }
  const artifacts = data as Artifact[];
  if (artifacts.length === 0) {
    return null;
  }

  return (
    <>
      <h4>Artifacts</h4>
      {artifacts.map((artifact, ind) => {
        return <JobArtifact key={ind} {...artifact} />;
      })}
    </>
  );
}
