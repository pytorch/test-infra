import useSWR from "swr";
import _ from "lodash";
import { Skeleton, Stack, Typography } from "@mui/material";
import { useRouter } from "next/router";
import { RocksetParam } from "lib/rockset";
import { fetcher } from "lib/GeneralUtils";
import React, { useState } from "react";
import JobSummary from "components/JobSummary";
import JobLinks from "components/JobLinks";
import LogViewer from "components/LogViewer";
import JobAnnotationToggle from "components/JobAnnotationToggle";
import { JobData, JobAnnotation } from "lib/types";
import { TimeRangePicker } from "pages/metrics";
import dayjs from "dayjs";
import { isRerunDisabledTestsJob, isUnstableJob } from "lib/jobUtils";

function CommitLink({ job }: { job: JobData }) {
  return (
    <span>
      <a
        target="_blank"
        rel="noreferrer"
        href={`/${job.repo}/commit/${job.sha}`}
      >
        Commit
      </a>
    </span>
  );
}

function SimilarFailedJobs({
  job,
  similarJobs,
  classification,
}: {
  job: JobData;
  similarJobs: JobData[];
  classification: JobAnnotation;
}) {
  const [showDetail, setShowDetail] = useState(false);

  function handleClick() {
    setShowDetail(!showDetail);
  }

  return (
    <div>
      <button
        style={{ background: "none", cursor: "pointer" }}
        onClick={handleClick}
      >
        {showDetail ? "▼ " : "▶ "}
        <code>Failing {similarJobs.length} times</code>
      </button>
      {showDetail &&
        _.map(similarJobs, (job) => (
          <FailedJob
            job={job}
            similarJobs={[]}
            classification={classification}
          />
        ))}
    </div>
  );
}

function FailedJob({
  job,
  similarJobs,
  classification,
}: {
  job: JobData;
  similarJobs: JobData[];
  classification: JobAnnotation;
}) {
  const hasSimilarJobs = similarJobs.length > 1;

  return (
    <div style={{ padding: "10px" }}>
      <li key={job.id}>
        <JobSummary job={job} />
        <div>
          <CommitLink job={job} />
          {" | "}
          <JobLinks job={job} />
        </div>
        <div>
          <JobAnnotationToggle
            job={job}
            similarJobs={similarJobs}
            annotation={classification}
          />
        </div>
        <LogViewer job={job} />
        {hasSimilarJobs && (
          <SimilarFailedJobs
            job={job}
            similarJobs={similarJobs}
            classification={classification}
          />
        )}
      </li>
    </div>
  );
}

function FailedJobsByFailure({
  jobs,
  annotations,
}: {
  jobs: JobData[];
  annotations: { [id: string]: { [key: string]: any } };
}) {
  // Select a random representative job in the group of similar jobs. Once
  // this job is classified, the rest will be put into the same category
  const job: JobData | undefined = _.sample(jobs);

  if (job === undefined) {
    return <></>;
  }

  return (
    <FailedJob
      job={job}
      similarJobs={jobs}
      classification={annotations?.[job.id!]?.["annotation"] ?? "null"}
    />
  );
}

function FailedJobs({
  queryParams,
  repoName,
  repoOwner,
}: {
  queryParams: RocksetParam[];
  repoName: string;
  repoOwner: string;
}) {
  // Note: querying the list of failed jobs here and send their IDs over to get
  // their annotation is not a scalable solution because the list of failures
  // could be longer than the browser-dependent URL-length limit. The workaround
  // here is to send the query param over to another annotation API that will then
  // make a query to Rockset to get the list of failed jobs itself and return the
  // list to the caller here
  const { data: failedJobsWithAnnotations } = useSWR(
    `/api/job_annotation/${repoOwner}/${repoName}/failures/${encodeURIComponent(
      JSON.stringify(queryParams)
    )}`,
    fetcher,
    {
      refreshInterval: 30 * 60 * 1000, // refresh every 30 minutes
      revalidateOnFocus: false,
    }
  );

  if (failedJobsWithAnnotations === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const failedJobs = failedJobsWithAnnotations["failedJobs"] ?? [];
  const annotations = failedJobsWithAnnotations["annotationsMap"] ?? {};

  // Grouped by annotation then by job name
  const groupedJobs: {
    [annotation: string]: {
      [name: string]: JobData[];
    };
  } = {};

  _.forEach(_.sortBy(failedJobs, ["jobName"]), (job) => {
    if (isRerunDisabledTestsJob(job) || isUnstableJob(job)) {
      return;
    }

    const annotation = annotations[job.id.toString()]
      ? annotations[job.id.toString()].annotation
      : "Not Annotated";
    if (!(annotation in groupedJobs)) {
      groupedJobs[annotation] = {};
    }

    // For simplicity, having same name, workflow, failure line are consider having
    // the same failure
    const jobName = job.jobName;
    const workflowName = job.workflowName;

    // The failure message might include some variants such as timestamp, so we need
    // to clean that up
    const failureCaptures = job.failureCaptures ?? "";

    const failure = jobName + workflowName + failureCaptures;
    if (!(failure in groupedJobs[annotation])) {
      groupedJobs[annotation][failure] = [];
    }

    groupedJobs[annotation][failure].push(job);
  });

  return (
    <>
      {_.map(groupedJobs, (groupedJobsByFailure, key) => (
        <details open key={key}>
          <summary
            style={{
              fontSize: "1em",
              marginTop: "1.33em",
              marginBottom: "1.33em",
              fontWeight: "bold",
            }}
          >
            {key} (
            {_.reduce(
              groupedJobsByFailure,
              (s, v) => {
                return s + v.length;
              },
              0
            )}
            )
          </summary>
          <ul>
            {_.map(groupedJobsByFailure, (jobs, failure) => (
              <FailedJobsByFailure
                key={failure}
                jobs={jobs}
                annotations={annotations}
              />
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}

export default function Page() {
  const router = useRouter();
  const { repoName, repoOwner, branch } = router.query;
  const [startTime, setStartTime] = useState(dayjs().subtract(1, "week"));
  const [stopTime, setStopTime] = useState(dayjs());
  const [timeRange, setTimeRange] = useState<number>(7);

  const queryParams: RocksetParam[] = [
    {
      name: "startTime",
      type: "string",
      value: startTime,
    },
    {
      name: "stopTime",
      type: "string",
      value: stopTime,
    },
    {
      name: "repo",
      type: "string",
      value: `${repoOwner}/${repoName}`,
    },
    {
      name: "branch",
      type: "string",
      value: `${branch}`,
    },
    {
      name: "count",
      type: "int",
      value: "0", // Set the count to 0 to query all failures
    },
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Failures
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          setStartTime={setStartTime}
          stopTime={stopTime}
          setStopTime={setStopTime}
          timeRange={timeRange}
          setTimeRange={setTimeRange}
        />
      </Stack>

      <FailedJobs
        queryParams={queryParams}
        repoName={repoName as string}
        repoOwner={repoOwner as string}
      />
    </div>
  );
}
