import { IsJobInProgress } from "./JobClassifierUtil";
import { JobData } from "./types";

export interface LogSearchResult {
  results: { lineNumber: number; lineText: string }[];
  info: string;
}

export async function getSearchRes(
  jobs: JobData[],
  query: string,
  setSearchRes: any
) {
  // Helper function to be called in useEffect to make sure the component
  // reloads when it should (hopefully).  The actual searching is done in
  // searchLogs
  if (query == "") {
    setSearchRes({
      results: new Map(),
      info: undefined,
    });
    return;
  }
  setSearchRes({
    results: new Map(),
    info: "Loading... (this might take a while)",
  });
  const searchRes = await searchLogs(jobs, query);
  setSearchRes({
    results: searchRes,
    info: undefined,
  });
}

async function searchLogs(
  jobs: JobData[],
  query: string
): Promise<Map<string, LogSearchResult>> {
  if (query == "") {
    return new Map();
  }
  const results: [string, LogSearchResult][] = await Promise.all(
    jobs.map(async (job) => {
      return [job.id!, await searchLog(job, query)];
    })
  );
  return new Map(results);
}

async function searchLog(
  job: JobData,
  query: string
): Promise<LogSearchResult> {
  // Search individual log
  try {
    if (IsJobInProgress(job.conclusion)) {
      return {
        results: [],
        info: "Job is still in progress",
      };
    }

    if (job.logUrl == undefined) {
      return {
        results: [],
        info: "No log URL",
      };
    }

    const log = await fetch(job.logUrl);
    if (log.status != 200) {
      return {
        results: [],
        info: `Error searching log ${log.statusText}`,
      };
    }
    const result: LogSearchResult = {
      results: [],
      info: "",
    };
    const threshold = 100;
    for (const [index, line] of (await log.text()).split("\n").entries()) {
      if (RegExp(query).test(line)) {
        result.results.push({
          lineNumber: index + 1,
          lineText: line.length > 100 ? `${line.substring(0, 100)}...` : line,
        });
        if (result.results.length >= threshold) {
          result.info = `Found ${threshold}+ matching lines, showing first ${threshold}`;
          break;
        }
      }
    }
    if (result.info == "") {
      result.info = `Found ${result.results.length} matching lines`;
    }
    return result;
  } catch (error) {
    return {
      results: [],
      info: `Error searching log ${error}`,
    };
  }
}
