import { JobData } from "lib/types";
import JobConclusion from "./JobConclusion";

export default function JobSummary({ job }: { job: JobData }) {
  var queueTimeInfo = null
  if (job.queueTimeS != null) {
    queueTimeInfo = <><i>Queued:</i> {Math.max(Math.round(job.queueTimeS / 60), 0)} mins</>
  }

  var durationInfo = null
  if (job.durationS != null) {
    durationInfo = <><i>Duration:</i> {Math.round((job.durationS / 60))} mins</>
  }

  var separator = (queueTimeInfo && durationInfo) ? ", ": ""

  return (
    <>
      <JobConclusion conclusion={job.conclusion} />
      <a href={job.htmlUrl}> {job.jobName}</a> {queueTimeInfo}{separator} {durationInfo}
    </>
  );
}
