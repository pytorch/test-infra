import { BenchmarkListCommitFetcher } from "../type";
import { ExecutableQueryBase, QueryBuilder } from "./queryBuilder";

export class BenchmarkListCommitQueryBuilder
  extends ExecutableQueryBase
  implements BenchmarkListCommitFetcher
{
  private builder: QueryBuilder;
  private _DEFAULT_QUERY_PARAMS = {
    branches: [],
    devices: [],
    arches: [],
    dtypes: [],
    modes: [],
    backends: [],
    startTime: "",
    stopTime: "",
  };
  constructor() {
    super();
    this.builder = new QueryBuilder(
      {
        table: "benchmark.oss_ci_benchmark_metadata",
        select_exists: true,
        where_exists: true,
        prewhere: [
          "timestamp >= toUnixTimestamp({startTime: DateTime64(3)})",
          "timestamp < toUnixTimestamp({stopTime: DateTime64(3)})",
        ],
      },
      `
  SELECT
    replaceAll(head_branch, 'refs/heads/', '') AS branch,
    head_sha AS commit,
    workflow_id,
    toStartOfHour(min(fromUnixTimestamp(timestamp))) AS date
  {{SELECT}}
  FROM {{TABLE}}
  {{PREWHERE}}
WHERE
    repo = {repo: String}
    AND (
        has(
            {branches: Array(String)},
            replaceAll(head_branch, 'refs/heads/', '')
        )
        OR empty({branches: Array(String)})
    )
    AND (
        has({benchmarkNames: Array(String)}, benchmark_name)
        OR empty({benchmarkNames: Array(String)})
    )
    AND notEmpty(metric_name)
    AND (
        has({models: Array(String)}, model_name)
        OR empty({models: Array(String)})
    )
    AND (
        has({backends: Array(String)}, model_backend)
        OR empty({backends: Array(String)})
    )
    AND (
      has({dtypes: Array(String) },benchmark_dtype)
      OR empty({dtypes: Array(String) })
    )
    AND (
        multiSearchAnyCaseInsensitive(arch, {arches: Array(String)})
        OR empty({arches: Array(String)})
    )
    AND (
        has({devices: Array(String)}, device)
        OR empty({devices: Array(String) })
    )
    {{WHERE}}
GROUP BY
    replaceAll(head_branch, 'refs/heads/', ''),
    head_sha,
    workflow_id
ORDER BY
    branch,
    date;
`
    );
  }

  build() {
    return this.builder.build();
  }

  addWhere(where: string[]) {
    this.builder.addWhere(where);
  }

  toQueryParams(inputs: any, id?: string) {
    if (inputs.backend && !inputs.backends) {
      inputs.backends = [inputs.backend];
    }

    if (inputs.dtype && !inputs.dtypes) {
      inputs.dtypes = [inputs.dtype];
    }

    if (inputs.model && !inputs.models) {
      inputs.models = [inputs.model];
    }
    if (inputs.branch && !inputs.branches) {
      inputs.branches = [inputs.branch];
    }

    if (inputs.arch && !inputs.arches) {
      inputs.arches = [inputs.arch];
    }

    if (inputs.device && !inputs.devices) {
      inputs.devices = [inputs.device];
    }

    const params = {
      ...this._DEFAULT_QUERY_PARAMS,
      ...inputs,
    };

    console.log("[listCommitQueryBuilder] query calls to db:", params);
    return params;
  }
  postProcess(data: any) {
    return data;
  }
}

export class PytorchOperatorMicroListCommitsDataFetcher
  extends ExecutableQueryBase
  implements BenchmarkListCommitFetcher
{
  private _data_query: BenchmarkListCommitQueryBuilder;
  constructor() {
    super();
    this._data_query = new BenchmarkListCommitQueryBuilder();
    this._data_query.addWhere([
      "(startsWith(model_name, {operatorName: String}) OR {operatorName: String} = '')",
    ]);
  }

  toQueryParams(inputs: any, id?: string): Record<string, any> {
    const pq = {
      ...inputs,
      operatorName: inputs.operatorName ?? "",
    };
    const params = this._data_query.toQueryParams(pq);
    return params;
  }

  build() {
    return this._data_query.build();
  }
  postProcess(data: any[]) {
    return this._data_query.postProcess(data);
  }
}

export class VllmListCommitsDataFetcher
  extends ExecutableQueryBase
  implements BenchmarkListCommitFetcher
{
  private _data_query: BenchmarkListCommitQueryBuilder;
  constructor() {
    super();
    this._data_query = new BenchmarkListCommitQueryBuilder();
    this._data_query.addWhere([
      "(startsWith(model_name, {modelCategory: String}) OR {modelCategory: String} = '')",
    ]);
  }

  toQueryParams(inputs: any, id?: string): Record<string, any> {
    const pq = {
      ...inputs,
      operatorName: inputs.operatorName ?? "",
    };
    const params = this._data_query.toQueryParams(pq);
    return params;
  }

  build() {
    return this._data_query.build();
  }
  postProcess(data: any[]) {
    return this._data_query.postProcess(data);
  }
}
