import { deepClone } from "@mui/x-data-grid/internals";
import { toBenchmarkTimeSeriesReponseFormat } from "../common/utils";
import { ExecutableQueryBase, QueryBuilder } from "./queryBuilder";

const DEFAULT_TS_GROUP_KEY = [
  "dtype",
  "arch",
  "device",
  "backend",
  "metric",
  "mode",
  "model",
  "branch",
];
const DEFAULT_TS_SUBGROUP_KEY = ["workflow_id"];

const DEFAULT_TABLE_GROUP_KEY = [
  "workflow_id",
  "dtype",
  "arch",
  "device",
  "backend",
  "mode",
  "branch",
  "model",
];
const DEFAULT_TABLE_SUB_GROUP_KEY = ["metric"];

export interface BenchmarkGroupConfig {
  group_key: string[];
  sub_group_key: string[];
}

export const DEFAULT_BENCHMARK_GROUP_MAP = {
  time_series: {
    group_key: DEFAULT_TS_GROUP_KEY,
    sub_group_key: DEFAULT_TS_SUBGROUP_KEY,
  },
  table: {
    group_key: DEFAULT_TABLE_GROUP_KEY,
    sub_group_key: DEFAULT_TABLE_SUB_GROUP_KEY,
  },
};

/**
 * Query to get benchmark data from the benchmark table
 * for repo/benchmark specific data use:
 *  - addInnerExtraInfo(): if the field is also in the extra column as unique key
 *  - addInnerMetadataInfo(): if it's only metadata info and does not act as unique key
 */
export class BenchmarkDataQuery extends ExecutableQueryBase {
  private _inner_query_builder: QueryBuilder;
  private _main_query_builder: QueryBuilder;
  private _format_config: { [key: string]: BenchmarkGroupConfig } = deepClone(
    DEFAULT_BENCHMARK_GROUP_MAP
  );
  private _extra_keys = new Set<string>();

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

    const metadata_info_select = toQueryMapResult(
      "metadata_info",
      this._required_metadata_info_statements
    );

    this._inner_query_builder = new QueryBuilder(
      {
        table: "benchmark.oss_ci_benchmark_v3 o",
        select_exists: true,
        where_exists: true,
        // default select statement for customized query
        select: [["map()", "extra"], metadata_info_select],
        prewhere: [
          "o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })",
          "o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })",
        ],
      },
      `
      SELECT
        replaceOne(o.head_branch, 'refs/heads/', '') AS head_branch,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
        o.model.'name' AS model,
        o.model.'backend' AS backend,
        o.model.'origins' AS origins,
        o.metric.'name' AS metric,
        -- Arithmetic mean
        floor(arrayAvg(o.metric.'benchmark_values'), 2) AS actual,
        -- Geometric mean
        floor(exp(arrayAvg(arrayMap(x -> log(x), o.metric.'benchmark_values'))), 2) AS actual_geomean,
        floor(toFloat64(o.metric.'target_value'), 2) AS target,
        o.benchmark.'mode' AS mode,
        o.benchmark.'dtype' AS dtype,
        o.benchmark.'extra_info' AS debugging_info,
        IF(
            empty(o.runners),
            tupleElement(o.benchmark, 'extra_info')['device'],
            tupleElement(o.runners[1], 'name')
        ) AS device,
        IF(
            empty(o.runners),
            tupleElement(o.benchmark, 'extra_info')['arch'],
            tupleElement(o.runners[1], 'type')
        ) AS arch,
        DATE_TRUNC(
            {granularity: String },
            fromUnixTimestamp(o.timestamp)
        ) AS granularity_bucket
        {{SELECT}}
        FROM {{TABLE}}
        {{PREWHERE}}
     WHERE
        o.repo = {repo: String }
        AND (
            has({commits: Array(String) }, o.head_sha)
            OR empty({commits: Array(String) })
        )
        AND (
            o.benchmark.'name' in {benchmarkNames: Array(String) }
            OR empty({benchmarkNames: Array(String) })
        )
        AND (
            has({models: Array(String) }, o.model.'name')
            OR empty({models: Array(String) })
        )
        AND (
            has({backends: Array(String) }, o.model.'backend')
            OR empty({backends: Array(String) })
        )
        AND (
            o.benchmark.'mode' = {mode: String }
            OR {mode: String } = ''
        )
        AND (
            has({dtypes: Array(String) }, o.benchmark.'dtype')
            OR empty({dtypes: Array(String) })
        )
        AND (
            NOT has({excludedMetrics: Array(String) }, o.metric.'name')
            OR empty({excludedMetrics: Array(String) })
        )
        AND notEmpty(o.metric.'name')
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
        AND notEmpty(device)
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

  /**
   * map of extra info statements to be added to the query
   * notice this will override the default extra info statement, but will not override the required fields
   * @param extraInfoMapStatements
   */
  addExtraInfos(extraInfoMapStatements: Map<string, string>) {
    // store the extra keys for later use
    this._extra_keys = new Set<string>(extraInfoMapStatements.keys());

    const mapSelectItem = toQueryMapResult("extra", extraInfoMapStatements);
    this._inner_query_builder.addSelect([mapSelectItem]);
  }

  /**
   * map of extra info statements to be added to the query
   * @param metadataInfoMapStatements
   */
  addMetadataInfos(metadataInfoMapStatements: Map<string, string>) {
    const mapSelectItem = toQueryMapResult(
      "metadata_info",
      metadataInfoMapStatements,
      this._required_metadata_info_statements
    );
    this._inner_query_builder.addSelect([mapSelectItem]);
  }

  /**
   *
   * @param rawData
   * @param formats
   * @returns
   */
  toFormat(rawData: any[], formats: string[], includesAllExtraKey: boolean) {
    const config = this._format_config;
    if (includesAllExtraKey) {
      config.time_series.group_key = [
        ...config.time_series.sub_group_key,
        ...Array.from(this._extra_keys),
      ];
      config.table.sub_group_key = [
        ...config.table.sub_group_key,
        ...Array.from(this._extra_keys),
      ];
    }
    return toBenchmarkTimeSeriesReponseFormat(rawData, config, formats);
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

  validateInputs(inputs: any) {
    if (!inputs.benchmarkName && !inputs.benchmarkNames) {
      throw new Error(
        "Either benchmarkName or benchmarkNames must be provided"
      );
    }
    if (!inputs.repo) {
      throw new Error("repo must be provided");
    }
  }

  toQueryParams(inputs: any, id?: string): Record<string, any> {
    this.validateInputs(inputs);
    const defaults = {
      excludedMetrics: [],
      commits: [],
      arch: "",
      mode: "",
      models: [],
      branches: [],
      granularity: "hour",
      backends: [],
      dtypes: [],
    };

    if (inputs.benchmarkName) {
      inputs.benchmarkNames = [inputs.benchmarkName];
    }

    const params = { ...defaults, ...inputs };
    return params;
  }
}

function toQueryMapResult(
  resultName: string,
  statements: Map<string, string>,
  additionalStatements?: Map<string, string>
): [string, string] {
  // Merge both maps into one array of [key, statement]
  const allEntries: [string, string][] = [
    ...Array.from(statements.entries()),
    ...(additionalStatements ? Array.from(additionalStatements.entries()) : []),
  ];

  // Build key-value pairs like `'key', value`
  const pairs = allEntries
    .filter(([key, stmt]) => key && stmt)
    .map(([key, stmt]) => `'${key}', ${stmt}`)
    .join(",\n  ");
  // Final SQL fragment: map('key1', value1, 'key2', value2, ...)
  const sqlExpr = allEntries.length > 0 ? `map(${pairs})` : "map()";

  return [sqlExpr, resultName];
}

export class PytorchOperatorMicroBenchmarkDataQuery extends ExecutableQueryBase {
  private _data_query: BenchmarkDataQuery;
  constructor() {
    super();
    this._data_query = new BenchmarkDataQuery();
    this._data_query.addExtraInfos(
      new Map([
        [
          "operator_name",
          `IF(
              mapContains(tupleElement(o.benchmark, 'extra_info'), 'operator_name'),
              tupleElement(o.benchmark, 'extra_info')['operator_name'],
              ''
            )`,
        ],
      ])
    );
  }
  toQueryParams(inputs: any, id?: string): Record<string, any> {
    return this._data_query.toQueryParams(inputs, id);
  }
  build() {
    return this._data_query.build();
  }
}

export function getBenchmarkDataQuery(name: string) {
  const MAP: Record<string, any> = {
    pytorch_operator_micro_benchmark:
      new PytorchOperatorMicroBenchmarkDataQuery(),
  };
  return MAP[name] ?? new BenchmarkDataQuery();
}
