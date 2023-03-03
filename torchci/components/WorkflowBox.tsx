import styles from "components/commit.module.css";
import { fetcher } from "lib/GeneralUtils";
import { isFailedJob } from "lib/jobUtils";
import { Artifact, JobData } from "lib/types";
import useSWR from "swr";
import JobArtifact from "./JobArtifact";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";
import { getConclusionSeverityForSorting } from "../lib/JobClassifierUtil";
import TestInsightsLink from "./TestInsights"

function sortJobsByConclusion( jobA: JobData, jobB: JobData): number {
  // Show failed jobs first, then pending jobs, then successful jobs
  if (jobA.conclusion !== jobB.conclusion) {
    return getConclusionSeverityForSorting(jobB.conclusion) - getConclusionSeverityForSorting(jobA.conclusion);
  }

  // Jobs with the same conclusion are sorted alphabetically
  return ('' + jobA.jobName).localeCompare('' + jobB.jobName);  // the '' forces the type to be a string
}

function getWorkflowJobSummary(job: JobData) {
  var queueTimeInfo = null
  if (job.queueTimeS != null) {
    queueTimeInfo = <><i>Queued:</i> {Math.max(Math.round(job.queueTimeS / 60), 0)} mins</>;
  }

  var durationInfo = null
  if (job.durationS != null) {
    durationInfo = <><i>Duration:</i> {Math.round((job.durationS / 60))} mins</>;
  }

  var separator = (queueTimeInfo && durationInfo) ? ", ": ""

  return (
    <>
      <JobSummary job={job} />
      <br />
      <small>
        &nbsp;&nbsp;&nbsp;&nbsp;
        {queueTimeInfo}
        {separator}
        {durationInfo}
        <TestInsightsLink job={job} separator={", "} />,{" "}
        <a target="_blank" rel="noreferrer" href={job.logUrl}>
          Raw logs
        </a>
      </small>
    </>
  );
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
  const anchorName = encodeURIComponent(workflowName.toLowerCase())
  return (
    <div id={anchorName} className={workflowClass}>
      <h3>{workflowName}</h3>
      <h4>Job Status</h4>
      <>
        {jobs.sort(sortJobsByConclusion).map((job) => (
          <div key={job.id}>
            {getWorkflowJobSummary(job)}
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
      <details>
        <summary
          style={{
            fontSize: "1em",
            marginTop: "1.33em",
            marginBottom: "1.33em",
            fontWeight: "bold",
          }}
        >
          Expand to see Artifacts
        </summary>
        {artifacts.map((artifact, ind) => {
          return <JobArtifact key={ind} {...artifact} />;
        })}
      </details>
    </>
  );
}
