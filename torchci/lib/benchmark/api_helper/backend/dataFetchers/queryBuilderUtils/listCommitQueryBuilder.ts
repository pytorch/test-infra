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
    arch: [],
    dtypes: [],
    modes: [],
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
    AND notEmpty(device)
    AND (benchmark_dtype = {dtype: String} OR empty({dtype: String}))
    AND (
        arch LIKE concat('%', {arch: String}, '%')
        OR {arch: String} = ''
    )
    AND (
        startsWith(device, {device: String})
        OR {device: String} = ''
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
    return {
      ...this._DEFAULT_QUERY_PARAMS,
      ...inputs,
    };
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
    const params = this._data_query.toQueryParams(inputs);
    return params;
  }

  build() {
    return this._data_query.build();
  }
  postProcess(data: any[]) {
    return this._data_query.postProcess(data);
  }
}
