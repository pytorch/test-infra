import { BenchmarkListCommitFetcher } from "../type";
import { ExecutableQueryBase, QueryBuilder } from "./queryBuilder";

export class BenchmarkCompilerBenchmarkDataQueryBuilder
  extends ExecutableQueryBase
  implements BenchmarkListCommitFetcher
{
  private builder: QueryBuilder;
  private _DEFAULT_QUERY_PARAMS = {
    branches: [],
    devices: [],
    arch: [],
    dtypes: [],
    modes: [],
    suites: [],
    startTime: "",
    stopTime: "",
  };
  constructor() {
    super();
    this.builder = new QueryBuilder(
      {
        table: "benchmark.oss_ci_benchmark_torchinductor",
        select_exists: true,
        where_exists: true,
      },
      `
  SELECT
    workflow_id,
    job_id,
    head_sha AS commit,
    replaceOne(head_branch, 'refs/heads/', '') AS branch,
    suite,
    model_name AS model,
    metric_name AS metric,
    value,
    metric_extra_info AS extra_info,
    benchmark_extra_info['output'] AS output,
    benchmark_dtype AS dtype,
    benchmark_mode AS mode,
    device,
    arch,
    timestamp,
    DATE_TRUNC({granularity: String}, fromUnixTimestamp(timestamp))
        AS granularity_bucket
    {{SELECT}}
    FROM {{TABLE}}
    {{PREWHERE}}
  WHERE
    workflow_id IN ({workflows: Array(UInt64)})
    AND (
        has(
            {branches: Array(String)},
            replaceOne(head_branch, 'refs/heads/', '')
        )
        OR empty({branches: Array(String)})
    )
    AND (
        has({suites: Array(String) }, suite)
        OR empty({suites: Array(String) })
    )
    AND (
        has({models: Array(String)}, model_name)
        OR empty({models: Array(String) })
    )
    AND (
        has({dtypes: Array(String)}, benchmark_dtype)
        OR empty({dtypes: Array(String) })
    )
    AND (
        has({modes: Array(String)}, benchmark_mode)
        OR empty({modes: Array(String) })
    )
    AND (
        has({devices: Array(String)}, device)
        OR empty({devices: Array(String) })
    )
    AND (
        multiSearchAnyCaseInsensitive(arch, {arches: Array(String)})
        OR empty({arches: Array(String)})
    )
    {{WHERE}}
ORDER BY timestamp
SETTINGS session_timezone = 'UTC';
`
    );
  }

  build() {
    return this.builder.build();
  }
  addWhere(where: string[]) {
    this.builder.addWhere(where);
  }
  toQueryParams(inputs: any) {
    const params = compilerParmsToQueryInput(inputs);
    return {
      ...this._DEFAULT_QUERY_PARAMS,
      ...params,
    };
  }
  postProcess(data: any) {
    return data;
  }
}

export class BenchmarkCompilerListCommitQueryBuilder
  extends ExecutableQueryBase
  implements BenchmarkListCommitFetcher
{
  private builder: QueryBuilder;
  private _DEFAULT_QUERY_PARAMS = {
    branches: [],
    devices: [],
    arch: [],
    dtypes: [],
    modes: [],
    suites: [],
    startTime: "",
    stopTime: "",
  };
  constructor() {
    super();
    this.builder = new QueryBuilder(
      {
        table: "benchmark.oss_ci_benchmark_torchinductor",
        select_exists: true,
        where_exists: true,
        prewhere: [
          "timestamp >= toUnixTimestamp({startTime: DateTime64(3)})",
          "timestamp < toUnixTimestamp({stopTime: DateTime64(3)})",
        ],
      },
      `
  SELECT
    replaceOne(head_branch, 'refs/heads/', '') AS branch,
    head_sha AS commit,
    workflow_id,
    toStartOfHour(min(fromUnixTimestamp(timestamp))) AS date
  {{SELECT}}
  FROM {{TABLE}}
  {{PREWHERE}}
WHERE
    (
        has(
            {branches: Array(String)},
            replaceOne(head_branch, 'refs/heads/', '')
        )
        OR empty({branches: Array(String)})
    )
    AND (
        has({suites: Array(String)}, suite)
        OR empty({suites: Array(String)})
    )
    AND (
      has({dtypes: Array(String) },benchmark_dtype)
      OR empty({dtypes: Array(String) })
    )
    AND (
      has({modes: Array(String) },benchmark_mode)
      OR empty({modes: Array(String) })
    )
    AND (
      has({devices: Array(String) },device)
      OR empty({devices: Array(String) })
    )
    AND (
        multiSearchAnyCaseInsensitive(arch, {arches: Array(String)})
        OR empty({arches: Array(String)})
    )
    {{WHERE}}
GROUP BY
    branch, commit, workflow_id
ORDER BY
    branch, date
SETTINGS session_timezone = 'UTC';
`
    );
  }

  build() {
    return this.builder.build();
  }
  addWhere(where: string[]) {
    this.builder.addWhere(where);
  }
  toQueryParams(inputs: any) {
    const hasRocm = [inputs?.device, inputs?.devices].some((v) =>
      Array.isArray(v) ? v.includes("rocm") : v === "rocm"
    );
    const hasA100 = [inputs?.arch, inputs?.arches].some((v) =>
      Array.isArray(v) ? v.includes("a100") : v === "a100"
    );
    if (hasRocm || hasA100) {
      this.builder.addWhere([
        `
        NOT endsWith(benchmark_extra_info['output'], 'huggingface.csv')
        AND NOT endsWith(benchmark_extra_info['output'], 'torchbench.csv')
        AND NOT endsWith(benchmark_extra_info['output'], 'timm_models.csv')
      `,
      ]);
    }
    const params = compilerParmsToQueryInput(inputs);
    return {
      ...this._DEFAULT_QUERY_PARAMS,
      ...params,
    };
  }
  postProcess(data: any) {
    return data;
  }
}

function toPlural(inputs: any) {
  if (inputs.branch && !inputs.branches) {
    inputs.branches = [inputs.branch];
  }
  if (inputs.suite && !inputs.suites) {
    inputs.suites = [inputs.suite];
  }

  if (inputs.dtype && !inputs.dtypes) {
    inputs.dtypes = [inputs.dtype];
  }
  if (inputs.model && !inputs.models) {
    inputs.models = [inputs.model];
  }
  if (inputs.device && !inputs.devices) {
    inputs.devices = [inputs.device];
  }
  if (inputs.arch && !inputs.arches) {
    inputs.arches = [inputs.arch];
  }
}

function compilerParmsToQueryInput(inputs: any) {
  const queryParams = {
    ...inputs, // override with caller's values
  };
  toPlural(queryParams);
  return queryParams;
}
