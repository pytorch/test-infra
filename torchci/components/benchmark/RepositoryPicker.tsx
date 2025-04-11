import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Skeleton,
  SelectChangeEvent,
} from "@mui/material";

import { fetcher } from "lib/GeneralUtils";
import { useEffect } from "react";
import useSWR from "swr";
import { DEFAULT_TRITON_REPOSITORY, MAIN_BRANCH } from "./common";

// Keep the mapping from workflow ID to commit, so that we can use it to
// zoom in and out of the graph. NB: this is to avoid sending commit sha
// again from the database in the compilers_benchmark_performance query which
// already returns close to the 6MB data transfer limit. I need to figure
// out a way to compress the data later
export const COMMIT_TO_WORKFLOW_ID: { [k: string]: number } = {};
export const WORKFLOW_ID_TO_COMMIT: { [k: number]: string } = {};

function getRepositories(data: any) {
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
    }

    repositories[repo][b].push({
      head_sha: sha,
      event_time: r.event_time,
      display_priority: r.head_branch == MAIN_BRANCH ? 99 : 1,
      id: r.id,
    });
  });
  return repositories;
}

export function RepositoryBranchCommitPicker({
  queryName,
  queryParams,
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
  queryParams:  { [k: string]: any };
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
        const repositories = getRepositories(data);
  
        // The selected branch could have no commit which happens when people are experimenting
        // on their own branches or switching around to different configuration
        if (repositories[repository] === undefined || 
            repositories[repository][branch] == undefined || 
            repositories[repository][branch].length == 0) {
          repository = DEFAULT_TRITON_REPOSITORY in repositories ? DEFAULT_TRITON_REPOSITORY : Object.keys(repositories)[0];
          const branches = repositories[repository];
          branch = MAIN_BRANCH in branches ? MAIN_BRANCH : Object.keys(branches)[0];
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


    const repositories = getRepositories(data);
    // The main branch could have no commit which happens when people are experimenting
    // on their own branches
    if (repositories[repository] === undefined || 
        repositories[repository][branch] === undefined || 
        repositories[repository][branch].length === 0) {
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
    const displayBranches = Object.keys(repositories[repository]).sort(
      (x, y) => repositories[repository][y][0].display_priority - repositories[repository][x][0].display_priority
    );
    return (
      <div>
        <FormControl>
          <InputLabel id={`repository-picker-input-label-${commit}`}>
            Repository
          </InputLabel>
          <Select
            value={branch}
            label="Repository"
            labelId={`repository-picker-select-label-${commit}`}
            onChange={handleRepositoryChange}
            id={`repository-picker-select-${commit}`}
          >
            {displayBranches.map((b: string) => (
              <MenuItem key={`${b}-${commit}`} value={b}>
                {b}
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
              <MenuItem key={`${b}-${commit}`} value={b}>
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
          />
        </FormControl>
      </div>
    );
}
