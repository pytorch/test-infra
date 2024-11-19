import { Octokit } from "octokit";
import { isFailure } from "./JobClassifierUtil";
import { CommitData, JobData } from "./types";

export function includesCaseInsensitive(
  value: string,
  pattern: string
): boolean {
  return value.toLowerCase().includes(pattern.toLowerCase());
}

export const fetcher = (url: string) => fetch(url).then((res) => res.json());

export const getMessage = (
  message: string,
  classification: string,
  suffix: string
) => {
  return `@pytorchbot revert -m '${message}' -c '${classification}'

  ${suffix}
  `;
};

export function getFailureMessage(
  commitData: CommitData,
  jobData: JobData[]
): string {
  if (commitData == null || jobData == null) {
    return "";
  }
  const failedJobsString = jobData

    .filter((job) => isFailure(job.conclusion))
    .map((failedJob) => `- [${failedJob.name}](${failedJob.htmlUrl})`)
    .join("\n");
  const hudLink = `https://hud.pytorch.org/pytorch/pytorch/commit/${commitData.sha}`;
  return `
  ### Additional Information

  @${commitData.author} This PR is being reverted. The following jobs failed on this PR:
  ${failedJobsString}

  Debug these failures on [HUD](${hudLink}).
  `;
}

export async function hasWritePermissionsUsingOctokit(
  octokit: Octokit,
  username: string,
  owner: string,
  repo: string
): Promise<boolean> {
  const res = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner: owner,
    repo: repo,
    username: username,
  });
  const permissions = res?.data?.permission;
  return permissions === "admin" || permissions === "write";
}
