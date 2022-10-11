import { fetcher } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import { useRouter } from "next/router";
import useSWR from "swr";
import JobAnnotationToggle, { JobAnnotation } from "./JobAnnotationToggle";
import JobLinks from "./JobLinks";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";

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
  const filteredJobs = jobs.filter(pred);

  const router = useRouter();
  const { repoOwner, repoName } = router.query;
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
  return (
    <div>
      <h2>{filterName}</h2>
      <ul>
        {filteredJobs.map((job) => (
          <li key={job.id}>
            <JobSummary job={job} />
            <div>
              <JobLinks job={job} />
            </div>
            <LogViewer job={job} />
            {showClassification && (
              <JobAnnotationToggle
                job={job}
                annotation={
                  (data[job?.id ?? ""] && data[job?.id ?? ""]["annotation"]) ?? JobAnnotation.NULL
                }
                repo={`${repoOwner}/${repoName}`}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
