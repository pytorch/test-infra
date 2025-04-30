import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Skeleton,
} from "@mui/material";

import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { useEffect } from "react";
import useSWR from "swr";
import { MAIN_BRANCH, SHA_DISPLAY_LENGTH } from "./common";

// Keep the mapping from workflow ID to commit, so that we can use it to
// zoom in and out of the graph. NB: this is to avoid sending commit sha
// again from the database in the compilers_benchmark_performance query which
// already returns close to the 6MB data transfer limit. I need to figure
// out a way to compress the data later
export const COMMIT_TO_WORKFLOW_ID: { [k: string]: number } = {};
export const WORKFLOW_ID_TO_COMMIT: { [k: number]: string } = {};

function getRepositories(default_repository: string, data: any) {
  const dedups: { [k: string]: Set<string> } = {};
  const repositories: { [k: string]: any } = {};

  data.forEach((r: any) => {
    const repo = r.repo;
    const b = r.head_branch;
    const sha = r.head_sha;

    if (!(repo in repositories)) {
      repositories[repo] = {};
    }
    if (!(b in repositories[repo])) {
      repositories[repo][b] = [];
      const dedup_key = repo + "-" + b;
      dedups[dedup_key] = new Set<string>();
    }

    const dedup_key = repo + "-" + b;
    if (dedups[dedup_key].has(sha)) {
      return;
    }

    let display_priority = 1;
    if (repo === default_repository && b === MAIN_BRANCH) {
      display_priority = 99;
    } else if (repo == default_repository) {
      display_priority = 98;
    }

    repositories[repo][b].push({
      head_sha: sha,
      event_time: r.event_time,
      display_priority: display_priority,
      id: r.id,
    });
    dedups[dedup_key].add(sha);
  });
  // sort repositories by event_time
  Object.keys(repositories).forEach((r: string) => {
    Object.keys(repositories[r]).forEach((b: string) => {
      const entries = repositories[r][b].sort((x: any, y: any) => {
        return x.event_time.localeCompare(y.event_time);
      });
      repositories[r][b] = entries;
    });
  });
  return repositories;
}

export function RepositoryBranchCommitPicker({
  queryName,
  queryParams,
  default_repository,
  repository,
  setRepository,
  branch,
  setBranch,
  commit,
  setCommit,
  titlePrefix,
  fallbackIndex,
  timeRange,
}: {
  queryName: string;
  queryParams: { [k: string]: any };
  default_repository: string;
  repository: string;
  setRepository: any;
  branch: string;
  setBranch: any;
  commit: string;
  setCommit: any;
  titlePrefix: string;
  fallbackIndex: number;
  timeRange: any;
}) {
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  useEffect(() => {
    if (data !== undefined && data.length !== 0) {
      const repositories = getRepositories(default_repository, data);

      // The selected branch could have no commit which happens when people are experimenting
      // on their own branches or switching around to different configuration
      if (
        repositories[repository] === undefined ||
        repositories[repository][branch] == undefined ||
        repositories[repository][branch].length == 0
      ) {
        repository =
          default_repository in repositories
            ? default_repository
            : Object.keys(repositories)[0];
        const branches = repositories[repository];
        branch =
          MAIN_BRANCH in branches ? MAIN_BRANCH : Object.keys(branches)[0];
        // Fallback to the main branch or the first available branch found in result
        setRepository(repository);
        setBranch(branch);
      }
      const branches = repositories[repository];
      const branchCommits = branches[branch].map((r: any) => r.head_sha);

      if (
        commit === undefined ||
        commit === "" ||
        !branchCommits.includes(commit) ||
        timeRange !== -1
      ) {
        const index =
          (branchCommits.length + fallbackIndex) % branchCommits.length;
        setCommit(branchCommits[index]);
      }

      data.forEach((r: any) => {
        COMMIT_TO_WORKFLOW_ID[r.head_sha] = r.id;
        WORKFLOW_ID_TO_COMMIT[r.id] = r.head_sha;
      });
    }
  }, [data]);

  if (error !== undefined) {
    return (
      <div>
        An error occurred while fetching data, perhaps there are too many
        results with your choice of time range and granularity?
      </div>
    );
  }

  if (data === undefined || data.length === 0) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const repositories = getRepositories(default_repository, data);

  // The main branch could have no commit which happens when people are experimenting
  // on their own branches
  if (
    repositories[repository] === undefined ||
    repositories[repository][branch] === undefined ||
    repositories[repository][branch].length === 0
  ) {
    return <div>Found no commit for this configurations.</div>;
  }

  function handleRepositoryChange(e: SelectChangeEvent<string>) {
    const r: string = e.target.value;
    setRepository(r);
    const b = Object.keys(repositories[repository])[0];
    setBranch(b);
    setCommit(repositories[r][b][0].head_sha);
  }

  function handleBranchChange(e: SelectChangeEvent<string>) {
    const b: string = e.target.value;
    setBranch(b);
    setCommit(repositories[repository][b][0].head_sha);
  }

  function handleCommitChange(e: SelectChangeEvent<string>) {
    setCommit(e.target.value);
  }

  // Sort it so that the main branch comes first
  const displayRepositories = Object.keys(repositories).sort(
    (x, y) =>
      repositories[x][0][0].display_priority -
      repositories[y][x][0].display_priority
  );
  const displayBranches = Object.keys(repositories[repository]).sort(
    (x, y) =>
      repositories[repository][y][0].display_priority -
      repositories[repository][x][0].display_priority
  );

  return (
    <div>
      <FormControl>
        <InputLabel id={`repositories-picker-input-label-${commit}`}>
          Repository
        </InputLabel>
        <Select
          value={repository}
          label="Repository"
          labelId={`repositories-picker-select-label-${commit}`}
          onChange={handleRepositoryChange}
          id={`repositories-picker-select-${commit}`}
        >
          {displayRepositories.map((r: string) => (
            <MenuItem key={`${r}-${branch}-${commit}`} value={r}>
              {r}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl>
        <InputLabel id={`branch-picker-input-label-${commit}`}>
          Branch
        </InputLabel>
        <Select
          value={branch}
          label="Branch"
          labelId={`branch-picker-select-label-${commit}`}
          onChange={handleBranchChange}
          id={`branch-picker-select-${commit}`}
        >
          {displayBranches.map((b: string) => (
            <MenuItem key={`${repository}-${b}-${commit}`} value={b}>
              {b}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
      <FormControl>
        <InputLabel id={`commit-picker-input-label-${commit}`}>
          {titlePrefix} Commit
        </InputLabel>
        <Select
          value={commit}
          label="Commit"
          labelId={`commit-picker-select-label-${commit}`}
          onChange={handleCommitChange}
          id={`commit-picker-select-${commit}`}
        >
          {repositories[repository][branch].map((c: any) => (
            <MenuItem key={c.head_sha} value={c.head_sha}>
              {c.head_sha.substring(0, SHA_DISPLAY_LENGTH)}(
              {dayjs(c.event_time).format("YYYYMMDD")})
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </div>
  );
}
