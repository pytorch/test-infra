import styles from "components/commit.module.css";
import { fetcher } from "lib/GeneralUtils";
import { isFailedJob } from "lib/jobUtils";
import { Artifact, JobData } from "lib/types";
import useSWR from "swr";
import JobArtifact from "./JobArtifact";
import JobSummary from "./JobSummary";
import LogViewer from "./LogViewer";

export default function WorkflowBox({
  workflowName,
  jobs,
}: {
  workflowName: string;
  jobs: JobData[];
}) {
  const isFailed = jobs.some(isFailedJob) !== false;
  const workflowClass = isFailed
    ? styles.workflowBoxFail
    : styles.workflowBoxSuccess;

  const workflowId = jobs[0].workflowId;
  return (
    <div className={workflowClass}>
      <h3>{workflowName}</h3>
      <h4>Job Status</h4>
      <>
        {jobs.map((job) => (
          <div key={job.id}>
            <JobSummary job={job} />
            <LogViewer job={job} />
          </div>
        ))}
      </>
      <>{workflowId && <Artifacts workflowId={workflowId} />}</>
    </div>
  );
}

function Artifacts({ workflowId }: { workflowId: string }) {
  const { data, error } = useSWR(`/api/artifacts/s3/${workflowId}`, fetcher, {
    refreshInterval: 60 * 1000,
    refreshWhenHidden: true,
  });
  if (data == null) {
    return <div>Loading...</div>;
  }

  if (error != null) {
    return <div>Error occured while fetching artifacts</div>;
  }
  const artifacts = data as Artifact[];
  if (artifacts.length === 0) {
    return null;
  }

  return (
    <>
      <h4>Artifacts</h4>
      {artifacts.map((artifact, ind) => {
        return <JobArtifact key={ind} {...artifact} />;
      })}
    </>
  );
}
