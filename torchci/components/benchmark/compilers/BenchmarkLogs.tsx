import { LOG_PREFIX } from "components/benchmark/common";
import { LogLinks } from "components/benchmark/compilers/LogLinks";
import { SUITES } from "components/benchmark/compilers/SuitePicker";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

export const INDUCTOR_JOB_NAME_REGEX = new RegExp(
  ".+\\s/\\stest\\s\\(inductor_(.+)_perf_?(.*), ([0-9]+), ([0-9]+), (.+)\\)"
);

export function BenchmarkLogs({ workflowId }: { workflowId: number }) {
  const queryName = "get_workflow_jobs";

  // Fetch the job ID to generate the link to its CI logs
  const queryParams: { [key: string]: any } = {
    jobName: "%test (%",
    workflowId: workflowId,
  };
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  let { data, error } = useSWR(url, fetcher, {
    refreshInterval: 60 * 60 * 1000, // refresh every hour
  });

  if (data === undefined || data.length === 0) {
    return <></>;
  }
  console.log(data);

  const logsBySuite: { [k: string]: any } = {};
  data.forEach((record: any) => {
    const id = record.id;
    const url = `${LOG_PREFIX}/${id}`;

    const name = record.name;
    // Extract the shard ID
    const m = name.match(INDUCTOR_JOB_NAME_REGEX);
    if (m === null) {
      return;
    }

    const suite = m[1];
    const setting = m[2];
    const index = m[3];
    const total = m[4];

    if (!(suite in logsBySuite)) {
      logsBySuite[suite] = [];
    }
    logsBySuite[suite].push({
      index: index,
      setting: setting,
      total: total,
      url: url,
    });
  });

  return (
    <>
      The running logs per shard are:{" "}
      {Object.keys(SUITES).map((suite: string) => {
        const name = suite.includes("timm") ? "timm" : suite;
        // Hack alert: The test configuration uses timm instead of timm_model as its output
        if (SUITES[suite].startsWith("[")) {
          return <span key={`log-${name}`}></span>;
        }
        return (
          <LogLinks
            key={`log-${name}`}
            suite={suite}
            logs={logsBySuite[name]}
          />
        );
      })}
    </>
  );
}
