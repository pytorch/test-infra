import styles from "components/commit.module.css";
import { fetcher } from "lib/GeneralUtils";
import { isFailedJob } from "lib/jobUtils";
import { getSearchRes, LogSearchResult } from "lib/searchLogs";
import { Artifact, IssueData, JobData } from "lib/types";
import React, { useEffect, useState } from "react";
import useSWR from "swr";
import { getConclusionSeverityForSorting } from "../lib/JobClassifierUtil";
import { TestInfo } from "./additionalTestInfo/TestInfo";
import JobArtifact from "./JobArtifact";
import JobSummary from "./JobSummary";
import LogViewer, { SearchLogViewer } from "./LogViewer";
import TestInsightsLink from "./TestInsights";
import { durationDisplay } from "./TimeUtils";

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

function WorkflowJobSummary({
  job,
  artifacts,
  artifactsToShow,
  setArtifactsToShow,
  unstableIssues,
}: {
  job: JobData;
  artifacts?: Artifact[];
  artifactsToShow: Set<string>;
  setArtifactsToShow: any;
  unstableIssues: IssueData[];
}) {
  const subInfo = [];
  if (job.queueTimeS != null) {
    subInfo.push(
      <>
        <i>Queued:</i> {durationDisplay(Math.max(job.queueTimeS, 0))}
      </>
    );
  }

  if (job.durationS != null) {
    subInfo.push(
      <>
        <i>Duration:</i> {durationDisplay(job.durationS)}
      </>
    );
  }

  const testInsightsLink = TestInsightsLink({ job: job, separator: "" });
  if (testInsightsLink != null) {
    subInfo.push(testInsightsLink);
  }

  const hasArtifacts = artifacts && artifacts.length > 0;

  function setArtifactsToShowHelper() {
    const id = job.id;
    if (id === undefined) {
      return;
    }
    if (artifactsToShow.has(id)) {
      const newSet = new Set(artifactsToShow);
      newSet.delete(id);
      setArtifactsToShow(newSet);
    } else {
      setArtifactsToShow(new Set(artifactsToShow).add(id));
    }
  }

  if (hasArtifacts) {
    subInfo.push(
      <a onClick={() => setArtifactsToShowHelper()}>Show artifacts</a>
    );
  }

  if (job.logUrl) {
    subInfo.push(
      <a target="_blank" rel="noreferrer" href={job.logUrl}>
        Raw logs
      </a>
    );
  }

  return (
    <>
      <JobSummary job={job} unstableIssues={unstableIssues} />
      <br />
      <small>
        &nbsp;&nbsp;&nbsp;&nbsp;
        {subInfo.map((info, ind) => {
          return (
            <span key={ind}>
              {info}
              {ind < subInfo.length - 1 && ", "}
            </span>
          );
        })}
        {hasArtifacts &&
          artifactsToShow.has(job.id!) &&
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
  unstableIssues,
  wide,
  setWide,
  repoFullName,
}: {
  workflowName: string;
  jobs: JobData[];
  unstableIssues: IssueData[];
  wide: boolean;
  setWide: any;
  repoFullName: string;
}) {
  const isFailed = jobs.some(isFailedJob) !== false;
  const workflowClass = isFailed
    ? styles.workflowBoxFail
    : styles.workflowBoxSuccess;

  const workflowId = jobs[0].workflowId;
  const anchorName = encodeURIComponent(workflowName.toLowerCase());

  const { artifacts, error } = useArtifacts(workflowId);
  const [artifactsToShow, setArtifactsToShow] = useState(new Set<string>());
  const groupedArtifacts = groupArtifacts(jobs, artifacts);

  const [searchString, setSearchString] = useState("");
  const [searchRes, setSearchRes] = useState<{
    results: Map<string, LogSearchResult>;
    info: undefined | string;
  }>({
    results: new Map(),
    info: undefined,
  });
  useEffect(() => {
    getSearchRes(jobs, searchString, setSearchRes);
  }, [jobs, searchString]);

  return (
    <div
      id={anchorName}
      className={workflowClass}
      style={wide ? { gridColumn: "1 / -1" } : {}}
    >
      <h3>{workflowName}</h3>
      <div>
        <div
          // Similar styling to an h4
          style={{ float: "left", marginBottom: "1.33em", fontWeight: "bold" }}
        >
          Job Status
        </div>
        <div style={{ float: "right" }}>
          <div style={{ margin: ".5em 0em" }}>
            {repoFullName == "pytorch/pytorch" && (
              <button
                onClick={() => {
                  setWide(!wide);
                }}
                className={styles.buttonBorder}
              >
                {wide
                  ? "Hide Additional Test Info"
                  : "Show Additional Test Info"}
              </button>
            )}
          </div>
          <form
            style={{ float: "right", paddingBottom: ".5em" }}
            onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              // @ts-ignore
              const searchString = e.target[0].value;
              setSearchString(searchString);
            }}
          >
            <input
              type="text"
              style={{ width: "15em" }}
              placeholder="Search raw logs with regex"
            ></input>
            <input type="submit" value="Search"></input>
          </form>
          <div
            style={{
              // Ensures elements after this div are actually below it (due to float)
              clear: "both",
            }}
          ></div>
          {searchString && <div>{searchRes.info}</div>}
        </div>
        <div
          style={{
            // Ensures elements after this div are actually below it (due to float)
            clear: "both",
          }}
        ></div>
      </div>
      {wide && (
        <TestInfo workflowId={workflowId!} runAttempt={"1"} jobs={jobs} />
      )}
      <>
        {jobs.sort(sortJobsByConclusion).map((job) => (
          <div key={job.id} id={`${job.id}-box`}>
            <WorkflowJobSummary
              job={job}
              artifacts={groupedArtifacts?.get(job.id?.toString())}
              artifactsToShow={artifactsToShow}
              setArtifactsToShow={setArtifactsToShow}
              unstableIssues={unstableIssues}
            />
            {(searchString && (
              <SearchLogViewer
                url={job.logUrl!}
                logSearchResult={searchRes.results.get(job.id!)}
              />
            )) ||
              (isFailedJob(job) && <LogViewer job={job} />)}
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
  const jobIds = jobs.map((job) => job.id?.toString());
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
