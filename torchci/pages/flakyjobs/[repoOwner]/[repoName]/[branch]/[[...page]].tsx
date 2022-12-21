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
import JobAnnotationToggle, {
  JobAnnotation,
} from "components/JobAnnotationToggle";
import { JobData } from "lib/types";
import { TimeRangePicker } from "pages/metrics";
import dayjs from "dayjs";

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

function FlakyJob({
  job,
  similarJobs,
  classification,
}: {
  job: JobData;
  similarJobs: JobData[];
  classification: JobAnnotation;
}) {
  return (
    <div style={{ padding: "10px" }}>
      <li>
        <JobSummary job={job} /> (failing {similarJobs.length} times)
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
      </li>
    </div>
  );
}

function FlakyJobsByFailure({
  jobs,
  annotations,
}: {
  jobs: JobData[],
  annotations: { [id: string]: { [key: string]: any } },
}) {
  // Select a random representative job in the group of similar jobs. Once
  // this job is classified, the rest will be put into the same category
  const job: JobData | undefined = _.sample(jobs);

  if (job === undefined) {
    return (<></>);
  }

  return (
    <FlakyJob
      job={job}
      similarJobs={jobs}
      classification={annotations?.[job.id!]?.["annotation"] ?? "null"}
    />
  );
}

function FlakyJobs({
  queryParams,
  repoName,
  repoOwner,
}: {
  queryParams: RocksetParam[];
  repoName: string;
  repoOwner: string;
}) {
  const url = `/api/query/commons/flaky_workflows_jobs?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data: rerunJobs } = useSWR(url, fetcher, {
    refreshInterval: 30 * 60 * 1000, // refresh every 5 minutes
    revalidateOnFocus: false,
  });

  const { data: annotatedJobs } = useSWR(
    `/api/query/commons/annotated_flaky_jobs?parameters=${encodeURIComponent(
      JSON.stringify(queryParams)
    )}`,
    fetcher,
    {
      refreshInterval: 30 * 60 * 1000, // refresh every 5 minutes
      revalidateOnFocus: false,
    }
  );

  var allJobs = rerunJobs
    ?.concat(annotatedJobs)
    .reduce((map: any, job: JobData) => {
      if (job && job.id) {
        map[job.id] = job;
      }
      return map;
    }, {});

  const { data: annotations } = useSWR(
    `/api/job_annotation/${repoOwner}/${repoName}/annotations/${encodeURIComponent(
      JSON.stringify(Object.keys(allJobs ? allJobs : {}))
    )}`,
    fetcher,
    {
      refreshInterval: 30 * 60 * 1000, // refresh every 5 minutes
      revalidateOnFocus: false,
    }
  );

  if (allJobs === undefined || annotations === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  // Grouped by annotation then by job name
  const groupedJobs: {
    [annotation: string]: {
      [name: string]: JobData[]
    }
  } = {};

  // To clean up some variants in the failure message such as timestamp
  const cleanupRegex = /\[.+\]|{.+}/g;

  _.forEach(_.sortBy(allJobs, ["jobName"]), (job) => {
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
    const failureLine = (job.failureLine ?? "").replace(cleanupRegex, "");

    const failure = jobName + workflowName + failureLine;
    if (!(failure in groupedJobs[annotation])) {
      groupedJobs[annotation][failure] = []
    }

    groupedJobs[annotation][failure].push(job)
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
            {key} ({_.reduce(groupedJobsByFailure, (s, v) => { return s + v.length; }, 0)})
          </summary>
          <ul>
            {_.map(groupedJobsByFailure, (jobs, failure) => (
              <FlakyJobsByFailure
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
  ];

  return (
    <div>
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <Typography fontSize={"2rem"} fontWeight={"bold"}>
          Flaky Jobs
        </Typography>
        <TimeRangePicker
          startTime={startTime}
          stopTime={stopTime}
          setStartTime={setStartTime}
          setStopTime={setStopTime}
        />
      </Stack>

      <FlakyJobs
        queryParams={queryParams}
        repoName={repoName as string}
        repoOwner={repoOwner as string}
      />
    </div>
  );
}
