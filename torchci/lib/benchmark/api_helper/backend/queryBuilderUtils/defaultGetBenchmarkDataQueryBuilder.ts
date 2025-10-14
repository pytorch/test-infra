import { ExecutableQueryBase, QueryBuilder } from "./queryBuilder";

/**
 * Query to get benchmark data from the benchmark table
 * for repo/benchmark specific data use:
 *  - addInnerExtraInfo(): if the field is also in the extra column as unique key
 *  - addInnerMetadataInfo(): if it's only metadata info and does not act as unique key
 */
export class BenchmarkDataQuery extends ExecutableQueryBase {
  private _inner_query_builder: QueryBuilder;
  private _main_query_builder: QueryBuilder;

  // must included in all select statement
  private _required_metadata_info_statements: Map<string, string>;
  constructor() {
    super();
    this._required_metadata_info_statements = new Map([
      [
        "timestamp",
        "formatDateTime(fromUnixTimestamp(timestamp), '%Y-%m-%dT%H:%i:%sZ')",
      ],
    ]);
    const metadata_infos = this._required_metadata_info_statements.forEach(
      (statement, key) => {
        return `${key},${statement}`;
      }
    );
    this._inner_query_builder = new QueryBuilder(
      {
        table: "benchmark.oss_ci_benchmark_v3",
        select_exists: true,
        where_exists: true,
        // default select statement for customized query
        select: [
          ["map()", "extra"],
          [`map(${metadata_infos})`, "metadata_info"],
        ],
        prewhere: [
          "timestamp >= toUnixTimestamp({startTime: DateTime64(3) })",
          "timestamp < toUnixTimestamp({endTime: DateTime64(3) })",
        ],
      },
      `
      SELECT
        replaceOne(head_branch, 'refs/heads/', '') AS head_branch,
        workflow_id AS workflow_id,
        job_id AS job_id,
        model.'name' AS model,
        model.'backend' AS backend,
        model.'origins' AS origins,
        metric.'name' AS metric,
        floor(arrayAvg(metric.'benchmark_values'), 2) AS value,
        floor(toFloat64(metric.'target_value'), 2) AS target,
        benchmark.'mode' AS mode,
        benchmark.'dtype' AS dtype
        IF(
            empty(runners),
            tupleElement(benchmark, 'extra_info')['device'],
            tupleElement(runners[1], 'name')
        ) AS device,
         IF(
            empty(runners),
            tupleElement(benchmark, 'extra_info')['arch'],
            tupleElement(runners[1], 'type')
        ) AS arch,
        DATE_TRUNC(
            {granularity: String },
            fromUnixTimestamp(timestamp)
        ) AS granularity_bucket
        {{SELECT}}
        FROM {{TABLE}}
        {{PREWHERE}}
        WHERE
            repo = {repo: String }
            AND notEmpty(metric.'name')
            AND (
                has({commits: Array(String) }, head_sha)
                OR empty({commits: Array(String) })
            )
            AND (
                benchmark.'name' in {benchmarks: Array(String) }
                OR empty({benchmarks: Array(String) })
            )
            AND (
                has({models: Array(String) }, model.'name')
                OR empty({models: Array(String) })
            )
            AND (
                has({backends: Array(String) }, model.'backend')
                OR empty({backends: Array(String) })
            )
            AND (
                benchmark.'mode' = {mode: String }
                OR {mode: String } = ''
            )
            AND (
                has({dtypes: Array(String) }, benchmark.'dtype')
                OR empty({dtypes: Array(String) })
            )
            {{WHERE}}
    `
    );
    this._main_query_builder = new QueryBuilder(
      {
        table: "benchmarks",
        select_exists: true,
        where_exists: true,
      },
      `
           SELECT DISTINCT
            workflow_id,
            job_id,
            model,
            backend,
            origins,
            metric,
            actual,
            target,
            mode,
            dtype,
            device,
            arch,
            granularity_bucket,
            extra,
            metadata_info
            {{SELECT}}
        FROM {{TABLE}}
        WHERE
        (
            has({branches: Array(String) }, head_branch)
            OR empty({branches: Array(String) })
        )
        notEmpty(device)
        AND (
            arch LIKE concat('%', {arch: String }, '%')
            OR {arch: String } = ''
        )
        {{WHERE}}
        ORDER BY
            granularity_bucket DESC,
            workflow_id DESC,
            backend,
            model,
            mode,
            dtype,
            device,
            metric
    `
    );
  }

  addInnerExtraInfo(extraInfoMapStatements: Map<string, string>) {
    const mapSelectItem = toQueryMapResult("extra", extraInfoMapStatements);
    this._inner_query_builder.addSelect(mapSelectItem);
  }

  addInnerMetadataInfo(metadataInfoMapStatements: Map<string, string>) {
    const mapSelectItem = toQueryMapResult(
      "metadata_info",
      metadataInfoMapStatements,
      this._required_metadata_info_statements
    );
    this._inner_query_builder.addSelect(mapSelectItem);
  }

  build() {
    const inner = this._inner_query_builder.build();
    const primary = this._main_query_builder.build();
    return `
    WITH benchmarks AS (
        ${inner}
    )
    ${primary}
    `;
  }
}

function toQueryMapResult(
  resultName: string,
  statements: Map<string, string>,
  additionalStatemetns?: Map<string, string>
) {
  let statement_items: string[] = [];
  statements.forEach((statement, key) => {
    statement_items.push(`${key},${statement}`);
  });
  if (additionalStatemetns) {
    additionalStatemetns.forEach((statement, key) => {
      statement_items.push(`${key},${statement}`);
    });
  }
  const statement = statement_items.join(",\n ");
  return [`map(${statement})`, resultName];
}
