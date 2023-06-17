import { CommitData, JobData } from "lib/types";
import _ from "lodash";
import { useState, useEffect } from "react";
import useSWR from "swr";
import { fetcherWithToken } from "lib/GeneralUtils";
import { Octokit } from "octokit";

const SUPPORTED_WORKFLOWS: { [k: string]: string } = {
  trunk: "Run trunk jobs",
  periodic: "Run periodic jobs",
  slow: "Run slow jobs",
};

function hasWorkflow(jobs: JobData[], workflow: string) {
  return _.find(
    jobs,
    (job) => job.name !== undefined && job.name.startsWith(workflow)
  );
}

function PeriodicWorkflow({
  accessToken,
  userName,
  repoOwner,
  repoName,
  workflow,
  sha,
  jobs,
}: {
  accessToken: string;
  userName: string;
  repoOwner: string;
  repoName: string;
  workflow: string;
  sha: string;
  jobs: JobData[];
}) {
  const [alreadyRun, setAlreadyRun] = useState(
    hasWorkflow(jobs, workflow) !== undefined
  );
  const [isClicked, setIsClicked] = useState(false);
  const [message, setMessage] = useState(SUPPORTED_WORKFLOWS[workflow]);

  const url = `/api/github/tags/${repoOwner}/${repoName}/${workflow}/${sha}`;
  // Only want to tag the commit once https://swr.vercel.app/docs/revalidation
  const { data, error } = useSWR(
    [isClicked && !alreadyRun ? url : null, accessToken],
    fetcherWithToken,
    {
      revalidateOnFocus: false,
      revalidateOnMount: false,
      revalidateOnReconnect: false,
      refreshWhenOffline: false,
      refreshWhenHidden: false,
      refreshInterval: 0,
    }
  );

  return (
    <div>
      {!alreadyRun && (
        <div
          key={workflow}
          onClick={() => {
            setIsClicked(true);
            setMessage(
              `Trigger ${workflow} jobs on ${sha}. Please refresh the page after a few minutes to see the jobs.`
            );
          }}
        >
          <input
            type="checkbox"
            disabled={isClicked}
            name={workflow}
            checked={isClicked}
            onChange={() => {}}
          />
          <label htmlFor={workflow}> {message}</label>
        </div>
      )}
    </div>
  );
}

export default function PeriodicWorkflows({
  repoOwner,
  repoName,
  commit,
  jobs,
  session,
}: {
  repoOwner: string;
  repoName: string;
  commit: CommitData;
  jobs: JobData[];
  session: any;
}) {
  if (
    session === undefined ||
    session["accessToken"] === undefined ||
    session["user"] == undefined
  ) {
    return <></>;
  }

  const userName = session["user"]["name"];
  const accessToken = session["accessToken"];

  return (
    <div>
      <h2>Run more jobs?</h2>
      {Object.keys(SUPPORTED_WORKFLOWS).map((workflow) => (
        <PeriodicWorkflow
          key={workflow}
          userName={userName}
          accessToken={accessToken}
          repoOwner={repoOwner}
          repoName={repoName}
          workflow={workflow}
          sha={commit.sha}
          jobs={jobs}
        />
      ))}
      <br />
    </div>
  );
}
