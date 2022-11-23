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
  classification,
}: {
  job: JobData;
  classification: JobAnnotation;
}) {
  return (
    <div style={{ padding: "10px" }}>
      <li>
        <JobSummary job={job} />
        <div>
          <CommitLink job={job} />
          {" | "}
          <JobLinks job={job} />
        </div>
        <div>
          <JobAnnotationToggle job={job} annotation={classification} />
        </div>
        <LogViewer job={job} />
      </li>
    </div>
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

  const groupedJobs = _.groupBy(_.sortBy(allJobs, ["jobName"]), (job) => {
    return annotations[job.id.toString()]
      ? annotations[job.id.toString()].annotation
      : "Not Annotated";
  });

  return (
    <>
      {_.map(groupedJobs, (val, key) => (
        <details open key={key}>
          <summary
            style={{
              fontSize: "1em",
              marginTop: "1.33em",
              marginBottom: "1.33em",
              fontWeight: "bold",
            }}
          >
            {key} ({val.length})
          </summary>
          <ul>
            {val.map((job: any) => (
              <FlakyJob
                key={job.id}
                job={job}
                classification={annotations?.[job.id]?.["annotation"] ?? "null"}
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
