import { fetcher } from "lib/GeneralUtils";
import { JobData } from "lib/types";
import { useRouter } from "next/router";
import useSWR from "swr";
import JobAnnotationToggle from "./JobAnnotationToggle";
import JobLinks from "./JobLinks";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";
import { JobAnnotation, IssueData } from "lib/types";
import useScrollTo from "lib/useScrollTo";

function FailedJobInfo({
  job,
  showClassification,
  annotation,
  unstableIssues,
}: {
  job: JobData;
  showClassification: boolean;
  annotation: JobAnnotation;
  unstableIssues: IssueData[];
}) {
  const router = useRouter();
  useScrollTo();
  const { repoOwner, repoName } = router.query;
  return (
    <li key={job.id} id={job.id}>
      <JobSummary job={job} unstableIssues={unstableIssues} />
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
  unstableIssues,
}: {
  filterName: string;
  jobs: JobData[];
  pred: (_job: JobData) => boolean;
  showClassification?: boolean;
  unstableIssues: IssueData[];
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
            unstableIssues={unstableIssues}
          />
        ))}
      </ul>
    </div>
  );
}
