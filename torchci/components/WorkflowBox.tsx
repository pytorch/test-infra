import styles from "components/commit.module.css";
import { fetcher } from "lib/GeneralUtils";
import { isFailedJob } from "lib/jobUtils";
import { Artifact, JobData } from "lib/types";
import useSWR from "swr";
import JobArtifact from "./JobArtifact";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";
import { getConclusionSeverityForSorting } from "../lib/JobClassifierUtil";
import TestInsightsLink from "./TestInsights";
import { useState } from "react";

function sortJobsByConclusion(jobA: JobData, jobB: JobData): number {
  // Show failed jobs first, then pending jobs, then successful jobs
  if (jobA.conclusion !== jobB.conclusion) {
    return (
      getConclusionSeverityForSorting(jobB.conclusion) -
      getConclusionSeverityForSorting(jobA.conclusion)
    );
  }

  // Jobs with the same conclusion are sorted alphabetically
  return ("" + jobA.jobName).localeCompare("" + jobB.jobName); // the '' forces the type to be a string
}

function WorkflowJobSummary(job: JobData, artifacts?: Artifact[]) {
  var queueTimeInfo = null;
  if (job.queueTimeS != null) {
    queueTimeInfo = (
      <>
        <i>Queued:</i> {Math.max(Math.round(job.queueTimeS / 60), 0)} mins
      </>
    );
  }

  var durationInfo = null;
  if (job.durationS != null) {
    durationInfo = (
      <>
        <i>Duration:</i> {Math.round(job.durationS / 60)} mins
      </>
    );
  }

  var separator = queueTimeInfo && durationInfo ? ", " : "";

  const [showArtifacts, setShowArtifacts] = useState(false);
  const hasArtifacts = artifacts && artifacts.length > 0;

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
        {hasArtifacts && (
          <a onClick={() => setShowArtifacts(!showArtifacts)}>
            {" "}
            Show artifacts,{" "}
          </a>
        )}
        <a target="_blank" rel="noreferrer" href={job.logUrl}>
          Raw logs
        </a>
        {hasArtifacts &&
          showArtifacts &&
          artifacts?.map((artifact, ind) => {
            return <JobArtifact key={ind} {...artifact} />;
          })}
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
  const anchorName = encodeURIComponent(workflowName.toLowerCase());

  const { artifacts, error } = useArtifacts(workflowId);
  const groupedArtifacts = groupArtifacts(artifacts);

  return (
    <div id={anchorName} className={workflowClass}>
      <h3>{workflowName}</h3>
      <h4>Job Status</h4>
      <>
        {jobs.sort(sortJobsByConclusion).map((job) => (
          <div key={job.id}>
            {WorkflowJobSummary(job, groupedArtifacts?.get(job.id))}
            {isFailedJob(job) && <LogViewer job={job} />}
          </div>
        ))}
      </>
      <>{workflowId && <Artifacts artifacts={artifacts} error={error} />}</>
    </div>
  );
}

function useArtifacts(workflowId: string | undefined): {
  artifacts: any;
  error: any;
} {
  if (workflowId === undefined) {
    return { artifacts: [], error: "No workflow ID" };
  }
  const { data, error } = useSWR(`/api/artifacts/s3/${workflowId}`, fetcher, {
    refreshInterval: 60 * 1000,
    refreshWhenHidden: true,
  });
  if (data == null) {
    return { artifacts: [], error: "Loading..." };
  }
  if (error != null) {
    return { artifacts: [], error: "Error occured while fetching artifacts" };
  }
  return { artifacts: data, error };
}

function groupArtifacts(artifacts: Artifact[]) {
  // Group artifacts by job id if possible
  const grouping = new Map<string | undefined, Artifact[]>();
  for (const artifact of artifacts) {
    try {
      const id = artifact.name.match(new RegExp(".*[_-](\\d+)\\.[^.]+$"))?.at(1)!;
      parseInt(id); // Should raise exception if not an int
      if (!grouping.has(id)) {
        grouping.set(id, []);
      }
      grouping.get(id)!.push(artifact);
    } finally {
    }
  }
  return grouping;
}

function Artifacts({
  artifacts,
  error,
}: {
  artifacts: Artifact[];
  error: string | null;
}) {
  if (error != null) {
    return <div>{error}</div>;
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
          Expand to see all Artifacts
        </summary>
        {artifacts.map((artifact, ind) => {
          return <JobArtifact key={ind} {...artifact} />;
        })}
      </details>
    </>
  );
}
