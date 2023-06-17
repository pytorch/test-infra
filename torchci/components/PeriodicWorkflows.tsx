import { CommitData, JobData } from "lib/types";
import _ from "lodash";
import { useState, useEffect } from "react";
import useSWR from "swr";
import { fetcherWithToken } from "lib/GeneralUtils";
import { Octokit } from "octokit";

const SUPPORTED_PERIODIC_WORKFLOWS: { [k: string]: string } = {
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
  const octokit = new Octokit({
    auth: accessToken,
  });

  const [tags, setTags] = useState(undefined);
  // TIL: Here is the way to call an async function inside React
  useEffect(() => {
    async function fetchTags() {
      await octokit
        .request("GET /repos/{repoOwner}/{repoName}/git/tags/{sha}", {
          repoOwner: repoOwner,
          repoName: repoName,
          sha: sha,
        })
        .then((r) => {
          console.log(r);
          setTags(r);
        })
        .catch((r) => console.log(r));
    }

    async function createTag() {
      const tag = `${sha}-debug`;

      await octokit
        .request("POST /repos/{repoOwner}/{repoName}/git/tags", {
          repoOwner: repoOwner,
          repoName: repoName,
          tag: tag,
          message: `Tag ${tag} created by ${userName}`,
          object: sha,
          type: "commit",
        })
        .then((r) => console.log(r))
        .catch((r) => console.log(r));
    }

    fetchTags();
    if (tags === undefined) {
      createTag();
    }
  }, [isTriggered]);

  return (
    <div
      key={workflow}
      onClick={() => {
        setIsTriggered(true);
        setMessage(`Tag ${workflow} ${sha}`);
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

  const missingWorkflows = _.filter(
    Object.keys(SUPPORTED_PERIODIC_WORKFLOWS),
    (workflow) => !hasWorkflow(jobs, workflow)
  );
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
      const [message, setMessage] = useState(
        SUPPORTED_PERIODIC_WORKFLOWS[workflow]
      );
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
