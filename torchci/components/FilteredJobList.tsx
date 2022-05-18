import { JobData } from "lib/types";
import JobLinks from "./JobLinks";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";

export default function FilteredJobList({
  filterName,
  jobs,
  pred,

}: {
  filterName: string;
  jobs: JobData[];
  pred: (job: JobData) => boolean;
}) {
  const filteredJobs = jobs.filter(pred);
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
          </li>
        ))}
      </ul>
    </div>
  );
}
