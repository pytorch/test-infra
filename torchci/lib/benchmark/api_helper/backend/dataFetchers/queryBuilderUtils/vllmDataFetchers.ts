import { BenchmarkDataFetcher } from "../type";
import {
  buildBaseRecordFromTemplate,
  createGroupKey,
  geometricMean,
} from "./aggregationUtils";
import { BenchmarkDataQuery } from "./benchmarkDataQueryBuilder";
import { ExecutableQueryBase } from "./queryBuilder";

/**
 * Builder to get Vllm X Pytorch Benchmark
 * It inherits method from BenchmarkDataQuery
 */
export class VllmXPytorchBenchmarkDataFetcher
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
          "model_category",
          `IF(
              tupleElement(o.benchmark, 'extra_info')['model_category'] = '',
              arrayElement(splitByChar('/', tupleElement(o.model, 'name')), 1),
              tupleElement(o.benchmark, 'extra_info')['model_category']
            )`,
        ],
        [
          "use_compile",
          `IF(
                tupleElement(o.benchmark, 'extra_info')['use_compile'] = '',
                'true',
                tupleElement(o.benchmark, 'extra_info')['use_compile']
                )`,
        ],
        [
          "request_rate",
          `JSONExtractString(
              tupleElement(o.benchmark, 'extra_info')['args'],
              'request_rate'
          )
          `,
        ],
        [
          "tensor_parallel_size",
          `JSONExtractString(
                tupleElement(o.benchmark, 'extra_info')['args'],
                'tensor_parallel_size'
            )`,
        ],
        [
          "random_input_len",
          `JSONExtractString(
              tupleElement(benchmark, 'extra_info')['args'],
              'random_input_len'
            )`,
        ],
        [
          "random_output_len",
          `JSONExtractString(
              tupleElement(benchmark, 'extra_info')['args'],
              'random_output_len'
            )`,
        ],
        [
          "input_len",
          `JSONExtractString(
              tupleElement(benchmark, 'extra_info')['args'],
              'input_len'
            )`,
        ],
        [
          "output_len",
          `JSONExtractString(
              tupleElement(benchmark, 'extra_info')['args'],
              'output_len'
            )`,
        ],
      ])
    );

    this._data_query.addInnerWhereStatements([
      `(
          {modelCategory:String} = ''
          OR startsWith(tupleElement(o.model, 'name'), {modelCategory:String})
      )
    `,
    ]);
  }
  applyFormat(
    data: any[],
    formats: string[],
    includesAllExtraKey: boolean = true,
    _groupByFields?: string[]
  ) {
    // nput and output length is the number of token feed into vLLM and the max output it returns.
    //  random_input_len is the name of the the parameter on vLLM bench,
    // for other type of benchmark, it could be called input_len
    data.forEach((d) => {
      if (d.extra_key) {
        const dk = d.extra_key;
        const input_len = dk?.input_len;
        const random_input_len = dk?.random_input_len;
        const output_len = dk?.output_len;
        const random_output_len = dk?.random_output_len;
        dk.input_len = input_len || random_input_len;
        dk.output_len = output_len || random_output_len;
      }
    });

    return this._data_query.applyFormat(data, formats, includesAllExtraKey);
  }

  toQueryParams(inputs: any, _id?: string): Record<string, any> {
    const excludedMetrics = [
      "mean_itl_ms",
      "mean_tpot_ms",
      "mean_ttft_ms",
      "std_itl_ms",
      "std_tpot_ms",
      "std_ttft_ms",
    ];
    const params = {
      ...inputs,
      modelCategory: inputs.modelCategory ?? "",
      useCompile: inputs.useCompile ?? "true",
      excludedMetrics: excludedMetrics,
    };

    return this._data_query.toQueryParams(params);
  }

  build() {
    return this._data_query.build();
  }
}

/**
 * Builder to get Vllm X Pytorch Benchmark with aggregated data.
 * Inherits from VllmXPytorchBenchmarkDataFetcher but aggregates data
 * by computing the geomean speedup of use_compile=true vs use_compile=false.
 */
export class VllmXPytorchBenchmarkAggregatedDataFetcher extends VllmXPytorchBenchmarkDataFetcher {
  // Only include these metrics for aggregation
  private static readonly ALLOWED_METRICS = new Set([
    "median_ttft_ms",
    "median_tpot_ms",
    "median_itl_ms",
    "latency",
    "tokens_per_second",
  ]);

  // Metrics where higher is better (throughput metrics)
  // For these: speedup = compiled / non_compiled
  private static readonly HIGHER_IS_BETTER_METRICS = new Set([
    "tokens_per_second",
  ]);

  // Compilation time metrics - pass through without speedup calculation (lower is better)
  // These are averaged directly without comparing compiled vs non-compiled
  private static readonly COMPILATION_TIME_METRICS = new Set([
    "avg_cold_compilation_time",
    "avg_cold_startup_time",
    "avg_warm_compilation_time",
    "avg_warm_startup_time",
  ]);

  // Metric group mapping for chart grouping
  // For speedup metrics: metric_group = metric (each metric gets its own chart)
  // For time metrics: group cold/warm together
  private static readonly METRIC_GROUP_MAP: Record<string, string> = {
    // Compilation time metrics - grouped together
    geomean_avg_cold_compilation_time: "compilation_time",
    geomean_avg_warm_compilation_time: "compilation_time",
    // Startup time metrics - grouped together
    geomean_avg_cold_startup_time: "startup_time",
    geomean_avg_warm_startup_time: "startup_time",
  };

  /**
   * Get metric group for a metric.
   * Returns the metric itself if not in the group map (each speedup metric gets its own chart).
   */
  private static getMetricGroup(metric: string): string {
    return (
      VllmXPytorchBenchmarkAggregatedDataFetcher.METRIC_GROUP_MAP[metric] ||
      metric
    );
  }

  constructor() {
    super();
  }

  // Default groupByFields for aggregation (excludes model to aggregate across all models)
  private static readonly DEFAULT_GROUP_BY_FIELDS = [
    "workflow_id",
    "metric",
    "device",
    "arch",
    "branch",
    "granularity_bucket",
  ];

  applyFormat(
    data: any[],
    formats: string[],
    _includesAllExtraKey: boolean = true,
    groupByFields?: string[]
  ) {
    // Use provided groupByFields or default
    const fields =
      groupByFields ??
      VllmXPytorchBenchmarkAggregatedDataFetcher.DEFAULT_GROUP_BY_FIELDS;

    console.log("[DEBUG] VllmXPytorchBenchmarkAggregatedDataFetcher.applyFormat - fields:", fields);
    console.log("[DEBUG] First data item model:", data[0]?.model);

    data.forEach((d) => {
      if (d.extra_key) {
        const dk = d.extra_key;
        const input_len = dk?.input_len;
        const random_input_len = dk?.random_input_len;
        const output_len = dk?.output_len;
        const random_output_len = dk?.random_output_len;
        dk.input_len = input_len || random_input_len;
        dk.output_len = output_len || random_output_len;
      }
    });

    // Normalize granularity_bucket per workflow_id (use smallest/earliest)
    const workflowBucketMap = new Map<string, string>();
    data.forEach((d) => {
      const wfId = String(d.workflow_id);
      const bucket = d.granularity_bucket;
      if (!workflowBucketMap.has(wfId)) {
        workflowBucketMap.set(wfId, bucket);
      } else {
        const existing = workflowBucketMap.get(wfId)!;
        if (new Date(bucket) < new Date(existing)) {
          workflowBucketMap.set(wfId, bucket);
        }
      }
    });

    // Apply normalized granularity_bucket to all records
    data.forEach((d) => {
      const wfId = String(d.workflow_id);
      d.granularity_bucket = workflowBucketMap.get(wfId);
    });

    // Filter to only allowed metrics (speedup metrics)
    const filteredData = data.filter((d) =>
      VllmXPytorchBenchmarkAggregatedDataFetcher.ALLOWED_METRICS.has(d.metric)
    );
    // Aggregate data by computing geomean speedup (use_compile=true vs false)
    const aggregatedData = this.aggregateData(filteredData, fields);

    // Filter and aggregate compilation time metrics (pass-through without speedup)
    const compilationTimeData = data.filter((d) =>
      VllmXPytorchBenchmarkAggregatedDataFetcher.COMPILATION_TIME_METRICS.has(
        d.metric
      )
    );
    const aggregatedCompilationTimeData = this.aggregateCompilationTimeData(
      compilationTimeData,
      fields
    );

    // Combine both aggregated datasets
    const combinedData = [...aggregatedData, ...aggregatedCompilationTimeData];

    const resp = super.applyFormat(combinedData, formats, false);

    // Add metric_group to group_info for each formatted record
    // This is needed for chart grouping to work properly
    if ("data" in resp && resp.data) {
      resp.data.time_series?.forEach((item: any) => {
        if (item.group_info && item.group_info.metric) {
          item.group_info.metric_group =
            VllmXPytorchBenchmarkAggregatedDataFetcher.getMetricGroup(
              item.group_info.metric
            );
        }
      });
      resp.data.table?.forEach((item: any) => {
        if (item.group_info && item.group_info.metric) {
          item.group_info.metric_group =
            VllmXPytorchBenchmarkAggregatedDataFetcher.getMetricGroup(
              item.group_info.metric
            );
        }
      });
    }

    // Apply the standard format using the parent's format method
    return resp;
  }

  /**
   * Aggregate data by grouping (excluding use_compile) and computing
   * geomean speedup based on metric type:
   * - For latency metrics (lower is better): speedup = non_compiled / compiled
   * - For throughput metrics (higher is better): speedup = compiled / non_compiled
   */
  private aggregateData(
    data: any[],
    groupByFields: string[] = [
      "workflow_id",
      "metric",
      "device",
      "arch",
      "branch",
      "granularity_bucket",
    ]
  ): any[] {
    // Group by all keys EXCEPT use_compile
    const groupMap = new Map<
      string,
      { compiled: any[]; nonCompiled: any[]; template: any }
    >();

    console.log("[DEBUG] aggregateData - groupByFields:", groupByFields);
    console.log("[DEBUG] aggregateData - data length:", data.length);

    data.forEach((d) => {
      const key = createGroupKey(d, groupByFields);
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          compiled: [],
          nonCompiled: [],
          template: { ...d },
        });
      }

      const group = groupMap.get(key)!;
      const useCompile = d.extra_key?.use_compile;

      // Categorize by use_compile value
      if (useCompile === "true" || useCompile === true) {
        group.compiled.push(d);
      } else if (useCompile === "false" || useCompile === false) {
        group.nonCompiled.push(d);
      }
    });

    console.log("[DEBUG] aggregateData - groupMap size:", groupMap.size);
    // Log first few keys to see if model is in the key
    const keys = Array.from(groupMap.keys()).slice(0, 3);
    console.log("[DEBUG] aggregateData - sample keys:", keys);

    // Compute geomean speedup for each group
    const aggregatedData: any[] = [];
    groupMap.forEach((group, _key) => {
      const { compiled, nonCompiled, template } = group;

      // Get values for compiled (use_compile=true) and track valid models
      const compiledFiltered = compiled.filter(
        (item) => item.value != null && item.value > 0
      );
      const compiledValues = compiledFiltered.map((item) => item.value);
      const compiledModels = compiledFiltered
        .map((item) => item.model)
        .filter(Boolean);

      // Get values for non-compiled (use_compile=false) and track valid models
      const nonCompiledFiltered = nonCompiled.filter(
        (item) => item.value != null && item.value > 0
      );
      const nonCompiledValues = nonCompiledFiltered.map((item) => item.value);
      const nonCompiledModels = nonCompiledFiltered
        .map((item) => item.model)
        .filter(Boolean);

      // Skip if either group is empty
      if (compiledValues.length === 0 || nonCompiledValues.length === 0) {
        return;
      }
      const geomeanCompiled = geometricMean(compiledValues);
      const geomeanNonCompiled = geometricMean(nonCompiledValues);

      // Calculate speedup based on metric type
      // For latency (lower is better): speedup = baseline / compiled = non_compiled / compiled
      // For throughput (higher is better): speedup = compiled / baseline = compiled / non_compiled
      let speedup: number;
      const metric = template.metric;

      if (
        VllmXPytorchBenchmarkAggregatedDataFetcher.HIGHER_IS_BETTER_METRICS.has(
          metric
        )
      ) {
        // Throughput: compiled / non_compiled
        speedup =
          geomeanNonCompiled > 0
            ? Math.round((geomeanCompiled / geomeanNonCompiled) * 100) / 100
            : 0;
      } else {
        // Latency (default): non_compiled / compiled
        speedup =
          geomeanCompiled > 0
            ? Math.round((geomeanNonCompiled / geomeanCompiled) * 100) / 100
            : 0;
      }

      // Create aggregated record
      // Collect unique models from both compiled and nonCompiled (all models, not just valid ones)
      const allModels = new Set<string>();
      compiled.forEach((item) => {
        if (item.model) allModels.add(item.model);
      });
      nonCompiled.forEach((item) => {
        if (item.model) allModels.add(item.model);
      });

      // Collect unique valid models (models that passed the filter)
      const validModels = new Set<string>([
        ...compiledModels,
        ...nonCompiledModels,
      ]);

      const metricName = `${template.metric}_compile_speedup`;
      const baseRecord = buildBaseRecordFromTemplate(template, groupByFields);
      const aggregatedRecord = {
        ...baseRecord,
        value: speedup,
        metric: metricName,
        metric_group:
          VllmXPytorchBenchmarkAggregatedDataFetcher.getMetricGroup(metricName),
        geomean_compiled: geomeanCompiled,
        geomean_non_compiled: geomeanNonCompiled,
        compiled_values: compiledValues,
        non_compiled_values: nonCompiledValues,
        models: Array.from(allModels),
        valid_models: Array.from(validModels),
      };

      aggregatedData.push(aggregatedRecord);
    });

    return aggregatedData;
  }

  /**
   * Aggregate compilation time metrics by computing the geometric mean value
   * across all models for each workflow/metric/device/arch combination.
   * These metrics are pass-through without compile vs non-compile comparison.
   */
  private aggregateCompilationTimeData(
    data: any[],
    groupByFields: string[] = [
      "workflow_id",
      "metric",
      "device",
      "arch",
      "branch",
      "granularity_bucket",
    ]
  ): any[] {
    // Group by specified fields
    const groupMap = new Map<
      string,
      { values: number[]; template: any; models: Set<string> }
    >();

    data.forEach((d) => {
      const key = createGroupKey(d, groupByFields);
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          values: [],
          template: { ...d },
          models: new Set(),
        });
      }

      const group = groupMap.get(key)!;
      if (d.value != null && d.value > 0) {
        group.values.push(d.value);
      }
      if (d.model) {
        group.models.add(d.model);
      }
    });

    // Compute geomean for each group
    const aggregatedData: any[] = [];
    groupMap.forEach((group) => {
      const { values, template, models } = group;

      if (values.length === 0) {
        return;
      }

      // Compute geometric mean
      const geomeanValue = geometricMean(values);

      const metricName = `geomean_${template.metric}`;
      const baseRecord = buildBaseRecordFromTemplate(template, groupByFields);
      const aggregatedRecord = {
        ...baseRecord,
        value: geomeanValue,
        metric: metricName,
        metric_group:
          VllmXPytorchBenchmarkAggregatedDataFetcher.getMetricGroup(metricName),
        geomean_value: geomeanValue,
        raw_values: values,
        models: Array.from(models),
        valid_models: Array.from(models),
      };

      aggregatedData.push(aggregatedRecord);
    });

    return aggregatedData;
  }
}
