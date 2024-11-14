import { Skeleton, Stack, Typography } from "@mui/material";
import JobAnnotationToggle from "components/JobAnnotationToggle";
import JobLinks from "components/JobLinks";
import JobSummary from "components/JobSummary";
import LogViewer from "components/LogViewer";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { isRerunDisabledTestsJob, isUnstableJob } from "lib/jobUtils";
import { JobAnnotation, JobData } from "lib/types";
import _ from "lodash";
import { useRouter } from "next/router";
import { IssueLabelApiResponse } from "pages/api/issue/[label]";
import { TimeRangePicker } from "pages/metrics";
import { useState } from "react";
import useSWR from "swr";

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
      <ul>
        {showDetail &&
          _.map(similarJobs, (job) => (
            <FailedJob
              job={job}
              similarJobs={[]}
              classification={classification}
              key={job.id}
            />
          ))}
      </ul>
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
  const { data: unstableIssuesData } = useSWR<IssueLabelApiResponse>(
    `/api/issue/unstable`,
    fetcher,
    {
      dedupingInterval: 300 * 1000,
      refreshInterval: 300 * 1000, // refresh every 5 minutes
    }
  );

  const hasSimilarJobs = similarJobs.length > 1;

  return (
    <div style={{ padding: "10px" }}>
      <li key={job.id}>
        <JobSummary job={job} unstableIssues={unstableIssuesData ?? []} />
        <div>
          <JobLinks job={job} showCommitLink={true} />
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
  queryParams: { [key: string]: any };
  repoName: string;
  repoOwner: string;
}) {
  // Note: querying the list of failed jobs here and send their IDs over to get
  // their annotation is not a scalable solution because the list of failures
  // could be longer than the browser-dependent URL-length limit. The workaround
  // here is to send the query param over to another annotation API that will then
  // make a query to the db to get the list of failed jobs itself and return the
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

  const queryParams: { [key: string]: any } = {
    branch: branch,
    repo: `${repoOwner}/${repoName}`,
    startTime: dayjs(startTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
    stopTime: dayjs(stopTime).utc().format("YYYY-MM-DDTHH:mm:ss.SSS"),
  };

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
