import { deepClone } from "@mui/x-data-grid/internals";
import { toBenchmarkTimeSeriesReponseFormat } from "../../common/utils";
import { BenchmarkDataFetcher } from "../type";
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
  "commit",
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

// TODO(elainewy) apply listCommits first to get the completed data
/**
 * QueryBuilder to get benchmark data from the benchmark table
 * for repo/benchmark specific data use:
 *  - addExtraInfo(): if the field is also in the extra column as unique key
 *  - addMetadataInfo(): if it's only metadata info and does not act as unique key
 *  - applyFormat(): to format the data to the desired format, default is time series
 *
 */
export class BenchmarkDataQuery extends ExecutableQueryBase {
  private _EXTRA_KEY_FIELD_NAME = "extra_key";
  private _METADATA_INFO_FIELD_NAME = "metadata_info";
  private _inner_query_builder: QueryBuilder;
  private _main_query_builder: QueryBuilder;
  private _format_config: { [key: string]: BenchmarkGroupConfig } = deepClone(
    DEFAULT_BENCHMARK_GROUP_MAP
  );
  private _extra_keys = new Set<string>();

  DEFAULT_PARAMS = {
    arch: "",
    mode: "",
    device: "",
    granularity: "hour",
    excludedMetrics: [],
    models: [],
    branches: [],
    commits: [],
    backends: [],
    dtypes: [],
  };

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
      this._METADATA_INFO_FIELD_NAME,
      this._required_metadata_info_statements
    );

    this._inner_query_builder = new QueryBuilder(
      {
        table: "benchmark.oss_ci_benchmark_v3 o",
        select_exists: true,
        where_exists: true,
        // default select statement for customized query
        select: [["map()", this._EXTRA_KEY_FIELD_NAME], metadata_info_select],
        prewhere: [
          "o.timestamp >= toUnixTimestamp({startTime: DateTime64(3) })",
          "o.timestamp < toUnixTimestamp({stopTime: DateTime64(3) })",
        ],
      },
      `
      SELECT
        replaceOne(o.head_branch, 'refs/heads/', '') AS branch,
        o.workflow_id AS workflow_id,
        o.job_id AS job_id,
        o.head_sha AS commit,
        o.model.'name' AS model,
        o.model.'backend' AS backend,
        o.model.'origins' AS origins,
        o.metric.'name' AS metric,
        floor(arrayAvg(o.metric.'benchmark_values'), 2) AS actual,
        floor(toFloat64(o.metric.'target_value'), 2) AS target,
        o.benchmark.'mode' AS mode,
        o.benchmark.'dtype' AS dtype,
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
            branch,
            commit,
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
            extra_key,
            metadata_info
            {{SELECT}}
        FROM {{TABLE}}
        WHERE
        (
            has({branches: Array(String) }, branch)
            OR empty({branches: Array(String) })
        )
        AND notEmpty(device)
        AND (
            startsWith({device: String }, device)
            OR {device: String } = ''
        )
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
    const mapSelectItem = toQueryMapResult(
      this._EXTRA_KEY_FIELD_NAME,
      extraInfoMapStatements
    );
    this._inner_query_builder.addSelect([mapSelectItem]);
  }

  /**
   * map of extra info statements to be added to the query
   * @param metadataInfoMapStatements
   */
  addMetadataInfos(metadataInfoMapStatements: Map<string, string>) {
    const mapSelectItem = toQueryMapResult(
      this._METADATA_INFO_FIELD_NAME,
      metadataInfoMapStatements,
      this._required_metadata_info_statements
    );
    this._inner_query_builder.addSelect([mapSelectItem]);
  }

  addInnerWhereStatements(statements: string[]) {
    this._inner_query_builder.addWhere(statements);
  }

  /**
   *
   * @param rawData
   * @param formats
   * @returns
   */
  applyFormat(
    rawData: any[],
    formats: string[],
    includesAllExtraKey: boolean = true
  ) {
    const config = this._format_config;
    if (includesAllExtraKey) {
      config.time_series.group_key = [
        ...config.time_series.group_key,
        ...Array.from(this._extra_keys).map(
          (key) => `${this._EXTRA_KEY_FIELD_NAME}.${key}`
        ),
      ];
      config.table.group_key = [
        ...config.table.group_key,
        ...Array.from(this._extra_keys).map(
          (key) => `${this._EXTRA_KEY_FIELD_NAME}.${key}`
        ),
      ];
    }
    return toBenchmarkTimeSeriesReponseFormat(rawData, config, formats);
  }

  // reset format config
  setFormatConfig(config: { [key: string]: BenchmarkGroupConfig }) {
    this._format_config = config;
  }

  getFormatConfig() {
    return deepClone(this._format_config);
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

    if (inputs.benchmarkName && !inputs.benchmarkNames) {
      inputs.benchmarkNames = [inputs.benchmarkName];
    }
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

    const params = { ...this.DEFAULT_PARAMS, ...inputs };
    return params;
  }
}

/**
 * helper function to convert a map of statements to a query map result
 * e.g. map('key1', value1, 'key2', value2, ...)
 * @param statements
 * @param additionalStatements
 * @returns
 */
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

/**
 * Builder to get PytorchOperatorMicroBenchmark
 * It inherits method from BenchmarkDataQuery
 *
 */
export class PytorchOperatorMicroBenchmarkDataFetcher
  extends ExecutableQueryBase
  implements BenchmarkDataFetcher
{
  private _data_query: BenchmarkDataQuery;
  constructor() {
    super();
    this._data_query = new BenchmarkDataQuery();

    // add extra info to the query
    this._data_query.addExtraInfos(
      new Map([
        [
          "operator_name",
          `IF(
            tupleElement(o.benchmark, 'extra_info')['operator_name'] = '',
            arrayElement(splitByChar('_', tupleElement(o.model, 'name')), 1),
            tupleElement(o.benchmark, 'extra_info')['operator_name']
          )`,
        ],
        [
          "use_compile",
          `IF(
              tupleElement(o.benchmark, 'extra_info')['use_compile'] = '',
              'false',
              -- Default to true
              tupleElement(o.benchmark, 'extra_info')['use_compile']
          )`,
        ],
      ])
    );
    this._data_query.addInnerWhereStatements([
      `(
          {operatorName:String} = ''
          OR startsWith(tupleElement(o.model, 'name'), {operatorName:String})
      )
    `,
    ]);
  }

  applyFormat(
    data: any[],
    formats: string[],
    includesAllExtraKey: boolean = true
  ) {
    return this._data_query.applyFormat(data, formats, includesAllExtraKey);
  }

  toQueryParams(inputs: any, id?: string): Record<string, any> {
    const params = {
      ...inputs,
      operatorName: inputs.operatorName ?? "",
    };
    return this._data_query.toQueryParams(params, id);
  }

  build() {
    return this._data_query.build();
  }
}
