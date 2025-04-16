import { Octokit } from "octokit";
import useSWR from "swr";
import useSWRImmutable from "swr/immutable";
import { isFailure } from "./JobClassifierUtil";
import { CommitData, JobData } from "./types";

class ErrorWithStatusCode extends Error {
  status: number;
  info: any;
  constructor(message: string, status: number, info: any) {
    super(message);
    this.status = status;
    this.info = info;
  }
}

export function includesCaseInsensitive(
  value: string,
  pattern: string
): boolean {
  return value.toLowerCase().includes(pattern.toLowerCase());
}

export const fetcher = (url: string) => fetch(url).then((res) => res.json());

export const fetcherHandleError = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const info = await res.json();
    const error = new ErrorWithStatusCode(
      `An error occurred while fetching the data`,
      res.status,
      info?.error
    );
    throw error;
  }
  return res.json();
};

export const fetcherCatchErrorStatus = async (url: string) => {
  // Code that might throw
  const res = await fetch(url);
  if (!res.ok) {
    const error = new ErrorWithStatusCode("", res.status, "");
    throw error;
  }
  return res.json();
};

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

/**
 * This hook function is a convenience wrapper for useSWR that fetches data from
 * the ClickHouse API.  Handles things like encoding the query name and
 * parameters into the URL in the correct format.
 *
 * @param queryName Name of query, ex "hud_query"
 * @param parameters Parameters, in {key: value} format. If the value is not a
 * string, please stringify (usually with JSON.stringify)
 * @param condition Condition to fetch data. Used with useSWR for conditional
 * fetching. See
 * https://swr.vercel.app/docs/conditional-fetching.en-US#conditional
 * @returns The same as useSWR, with the type being any[] or T[] if T is provided
 */
export function useClickHouseAPI<T = any>(
  queryName: string,
  parameters: { [key: string]: string },
  condition: boolean = true
) {
  // Helper function to format the URL nicely
  return useSWR<T[]>(
    condition &&
      `/api/clickhouse/${encodeURIComponent(queryName)}?${encodeParams({
        parameters: JSON.stringify(parameters),
      })}`,
    fetcher
  );
}

/**
 * This hook function is a convenience wrapper for useSWRImmutable that fetches
 * data from the ClickHouse API. This is the same as useClickHouseAPI, but with
 * the immutable version of useSWR. Handles things like encoding the query name
 * and parameters into the URL in the correct format.
 *
 * @param queryName Name of query, ex "hud_query"
 * @param parameters Parameters, in {key: value} format. If the value is not a
 * string, please stringify (usually with JSON.stringify)
 * @param condition Condition to fetch data. Used with useSWR for conditional
 * fetching. See
 * https://swr.vercel.app/docs/conditional-fetching.en-US#conditional
 * @returns The same as useSWR, with the type being any[] or T[] if T is provided
 */
export function useClickHouseAPIImmutable<T = any>(
  queryName: string,
  parameters: { [key: string]: string },
  condition: boolean = true
) {
  // Helper function to format the URL nicely
  return useSWRImmutable<T[]>(
    condition &&
      `/api/clickhouse/${encodeURIComponent(queryName)}?${encodeParams({
        parameters: JSON.stringify(parameters),
      })}`,
    fetcher
  );
}

export function encodeParams(params: { [key: string]: string }) {
  return Object.keys(params)
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join("&");
}
