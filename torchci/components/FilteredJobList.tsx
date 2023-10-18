import { fetcher } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import { useRouter } from "next/router";
import useSWR from "swr";
import JobAnnotationToggle from "./JobAnnotationToggle";
import JobLinks from "./JobLinks";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";
import { JobAnnotation } from "lib/types";
import useScrollTo from "lib/useScrollTo";
import { isFailedJob } from "lib/jobUtils";

function FailedJobInfo({
  job,
  showClassification,
  annotation,
}: {
  job: JobData;
  showClassification: boolean;
  annotation: JobAnnotation;
}) {
  const router = useRouter();
  useScrollTo();
  const { repoOwner, repoName } = router.query;
  return (
    <li key={job.id} id={job.id}>
      <JobSummary job={job} />
      <div>
        <JobLinks job={job} />
      </div>
      <LogViewer job={job} />
      {showClassification && (
        <JobAnnotationToggle
          job={job}
          annotation={annotation ?? JobAnnotation.NULL}
          repo={`${repoOwner}/${repoName}`}
        />
      )}
    </li>
  );
}

export default function FilteredJobList({
  filterName,
  jobs,
  pred,
  showClassification = false,
}: {
  filterName: string;
  jobs: JobData[];
  pred: (job: JobData) => boolean;
  showClassification?: boolean;
}) {
  const router = useRouter();
  const { repoOwner, repoName } = router.query;
  const filteredJobs = jobs.filter(pred);
  const { data } = useSWR(
    showClassification
      ? `/api/job_annotation/${repoOwner}/${repoName}/annotations/${encodeURIComponent(
          JSON.stringify(filteredJobs.map((failedJob) => failedJob.id))
        )}`
      : null,
    fetcher
  );
  if (showClassification && data == null) {
    return null;
  }

  if (filteredJobs.length === 0) {
    return null;
  }
  console.log("filtered jobs");
  console.log(filteredJobs);
  console.log("pred is ", pred);

  for (const job of filteredJobs) {
    console.log("job is failed as", isFailedJob(job), pred);
  }
  return (
    <div>
      <h2>{filterName}</h2>
      <ul>
        {filteredJobs.map((job) => (
          <FailedJobInfo
            key={job.id}
            job={job}
            showClassification={showClassification}
            annotation={
              (data &&
                data[job?.id ?? ""] &&
                data[job?.id ?? ""]["annotation"]) ??
              JobAnnotation.NULL
            }
          />
        ))}
      </ul>
    </div>
  );
}
