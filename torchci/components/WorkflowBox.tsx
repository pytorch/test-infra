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
  const groupedArtifacts = groupArtifacts(jobs, artifacts);

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
  const { data, error } = useSWR(`/api/artifacts/s3/${workflowId}`, fetcher, {
    refreshInterval: 60 * 1000,
    refreshWhenHidden: true,
  });
  if (workflowId === undefined) {
    return { artifacts: [], error: "No workflow ID" };
  }
  if (data == null) {
    return { artifacts: [], error: "Loading..." };
  }
  if (error != null) {
    return { artifacts: [], error: "Error occured while fetching artifacts" };
  }
  return { artifacts: data, error };
}

function groupArtifacts(jobs: JobData[], artifacts: Artifact[]) {
  // Group artifacts by job id if possible
  const jobIds = jobs.map((job) => job.id);
  const grouping = new Map<string | undefined, Artifact[]>();
  for (const artifact of artifacts) {
    let key = "none";
    try {
      // Build artifacts usually look like <job name>/artifacts.zip
      const buildArtifactMatch = artifact.name.match(
        new RegExp("([^/]+)/artifacts.zip")
      );
      if (buildArtifactMatch && buildArtifactMatch.length == 2) {
        const jobName = `${buildArtifactMatch.at(1)} / build`;
        const matchingJobs = jobs.filter((job) => job.jobName == jobName);
        if (matchingJobs.length == 1) {
          key = matchingJobs.at(0)?.id!;
        }
      }

      // Other artifacts generally look like <stuff><- or _><job id>.<file extension>
      const id = artifact.name
        .match(new RegExp(".*[_-](\\d+)\\.[^.]+$"))
        ?.at(1)!;
      parseInt(id); // Should raise exception if not an int
      if (jobIds.includes(id)) {
        key = id;
      }
    } finally {
      if (!grouping.has(key)) {
        grouping.set(key, []);
      }
      grouping.get(key)!.push(artifact);
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
  if (artifacts.length == 0) {
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
          Expand to see all Artifacts
        </summary>
        {artifacts.map((artifact, ind) => {
          return <JobArtifact key={ind} {...artifact} />;
        })}
      </details>
    </>
  );
}
