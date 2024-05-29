import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Skeleton,
} from "@mui/material";
import { MAIN_BRANCH, SHA_DISPLAY_LENGTH } from "components/benchmark/common";
import dayjs from "dayjs";
import { fetcher } from "lib/GeneralUtils";
import { RocksetParam } from "lib/rockset";
import { useEffect } from "react";
import useSWR from "swr";

// Keep the mapping from workflow ID to commit, so that we can use it to
// zoom in and out of the graph. NB: this is to avoid sending commit sha
// again from Rockset in the compilers_benchmark_performance query which
// already returns close to the 6MB data transfer limit. I need to figure
// out a way to compress the data later
export const COMMIT_TO_WORKFLOW_ID: { [k: string]: number } = {};
export const WORKFLOW_ID_TO_COMMIT: { [k: number]: string } = {};

function groupCommitByBranch(data: any) {
  const dedups: { [k: string]: Set<string> } = {};
  const branches: { [k: string]: any[] } = {};
  data.forEach((r: any) => {
    const b = r.head_branch;
    if (!(b in branches)) {
      branches[b] = [];
      dedups[b] = new Set<string>();
    }
    if (dedups[b].has(r.head_sha)) {
      return;
    }

    branches[b].push({
      head_sha: r.head_sha,
      event_time: r.event_time,
      // This is used to sort the list of branches to show the main branch first
      display_priority: r.head_branch === MAIN_BRANCH ? 99 : 1,
    });
    dedups[b].add(r.head_sha);
  });

  return branches;
}

export function BranchAndCommitPicker({
  queryName,
  queryCollection,
  queryParams,
  branch,
  setBranch,
  commit,
  setCommit,
  titlePrefix,
  fallbackIndex,
  timeRange,
}: {
  queryName: string;
  queryCollection: string;
  queryParams: RocksetParam[];
  branch: string;
  setBranch: any;
  commit: string;
  setCommit: any;
  titlePrefix: string;
  fallbackIndex: number;
  timeRange: any;
}) {
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  useEffect(() => {
    if (data !== undefined && data.length !== 0) {
      const branches = groupCommitByBranch(data);

      // The selected branch could have no commit which happens when people are experimenting
      // on their own branches or switching around to different configuration
      if (branches[branch] === undefined || branches[branch].length === 0) {
        branch =
          MAIN_BRANCH in branches ? MAIN_BRANCH : Object.keys(branches)[0];
        // Fallback to the main branch or the first available branch found in result
        setBranch(branch);
      }
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

  const branches = groupCommitByBranch(data);
  // The main branch could have no commit which happens when people are experimenting
  // on their own branches
  if (branches[branch] === undefined || branches[branch].length === 0) {
    return <div>Found no commit for this configurations.</div>;
  }

  function handleBranchChange(e: SelectChangeEvent<string>) {
    const branch: string = e.target.value;
    setBranch(branch);
    setCommit(branches[branch][0].head_sha);
  }

  function handleCommitChange(e: SelectChangeEvent<string>) {
    setCommit(e.target.value);
  }

  // Sort it so that the main branch comes first
  const displayBranches = Object.keys(branches).sort(
    (x, y) => branches[y][0].display_priority - branches[x][0].display_priority
  );
  return (
    <div>
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
        >
          {branches[branch].map((r: any) => (
            <MenuItem key={r.head_sha} value={r.head_sha}>
              {r.head_sha.substring(0, SHA_DISPLAY_LENGTH)} (
              {dayjs(r.event_time).format("YYYY/MM/DD")})
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </div>
  );
}
