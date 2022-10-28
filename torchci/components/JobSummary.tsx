import { JobData } from "lib/types";
import JobConclusion from "./JobConclusion";

export default function JobSummary({ job, highlight }: { job: JobData; highlight: boolean; }) {
  return (
    <>
      <JobConclusion conclusion={job.conclusion} />
      <a href={job.htmlUrl}> {job.jobName} </a>
      {highlight ? <b> [{job.branch}] </b> : <span>[{job.branch}]</span> }
    </>
  );
}
