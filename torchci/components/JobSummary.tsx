import { JobData } from "lib/types";
import JobConclusion from "./JobConclusion";
import {
  isFailedJob,
  isRerunDisabledTestsJob,
  isUnstableJob,
} from "lib/jobUtils";

function BranchName({
  name,
  highlight,
}: {
  name: string | undefined;
  highlight: boolean;
}) {
  if (name) {
    if (highlight) {
      return <b> [{name}] </b>;
    } else {
      return <span>[{name}]</span>;
    }
  }
  return <></>;
}

export default function JobSummary({
  job,
  highlight,
}: {
  job: JobData;
  highlight: boolean;
}) {
  return (
    <>
      <JobConclusion
        conclusion={job.conclusion}
        warningOnly={
          isFailedJob(job) &&
          (isRerunDisabledTestsJob(job) || isUnstableJob(job))
        }
      />
      <a href={job.htmlUrl}> {job.jobName} </a>
      <BranchName name={job.branch} highlight={highlight} />
    </>
  );
}

JobSummary.defaultProps = {
  highlight: false,
};
