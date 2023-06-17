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
  isTriggered,
  setIsTriggered,
  message,
  setMessage,
}: {
  accessToken: string;
  userName: string;
  repoOwner: string;
  repoName: string;
  workflow: string;
  sha: string;
  isTriggered: boolean;
  setIsTriggered: any;
  message: string;
  setMessage: any;
}) {
  const url = `/api/github/tags/${repoOwner}/${repoName}/${workflow}/${sha}`;
  // Only want to tag the commit once https://swr.vercel.app/docs/revalidation
  const { data, error } = useSWR(
    [isTriggered ? url : null, accessToken],
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
    <div
      key={workflow}
      onClick={() => {
        setIsTriggered(true);
        setMessage(`Trigger ${workflow} jobs on ${sha}. Refreshing the page`);
      }}
    >
      <input
        type="checkbox"
        disabled={isTriggered}
        name={workflow}
        checked={isTriggered}
        onChange={() => {}}
      />
      <label htmlFor={workflow}> {message}</label>
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

  let missingWorkflows: string[] = [];
  // If this list has already been filled out, just use it
  if (missingWorkflows.length === 0) {
    missingWorkflows = _.filter(
      Object.keys(SUPPORTED_WORKFLOWS),
      (workflow) => !hasWorkflow(jobs, workflow)
    );
  }
  // If this commit has already run all those workflows, there is no need to show
  // this section
  if (missingWorkflows.length === 0) {
    return <></>;
  }

  const triggers = Object.fromEntries(
    missingWorkflows.map((workflow) => {
      const [isTriggered, setIsTriggered] = useState(false);
      return [workflow, [isTriggered, setIsTriggered]];
    })
  );

  const messages = Object.fromEntries(
    missingWorkflows.map((workflow) => {
      const [message, setMessage] = useState(SUPPORTED_WORKFLOWS[workflow]);
      return [workflow, [message, setMessage]];
    })
  );

  const userName = session["user"]["name"];
  const accessToken = session["accessToken"];

  return (
    <div>
      <h2>Run more jobs?</h2>
      {missingWorkflows.map((workflow) => (
        <PeriodicWorkflow
          key={workflow}
          userName={userName}
          accessToken={accessToken}
          repoOwner={repoOwner}
          repoName={repoName}
          workflow={workflow}
          sha={commit.sha}
          isTriggered={triggers[workflow][0] as boolean}
          setIsTriggered={triggers[workflow][1] as any}
          message={messages[workflow][0] as string}
          setMessage={messages[workflow][1] as any}
        />
      ))}
      <br />
    </div>
  );
}
