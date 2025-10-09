import dayjs, { Dayjs } from "dayjs";
import { TimeRange } from "lib/benchmark/store/benchmark_regression_store";
import DefaultMetricsDropdowns from "../../components/benchmarkSideBar/components/DefaultSideBarMetricsDropdowns";
import { NotFoundComponent, resolveComponent } from "../configRegistration";
import { compilerQueryParameterConverter } from "../teams/compilers/config";

export type DataBindingConfig = {
  initial: BenchmarkUiParameters;
  required_filter_fields: readonly string[];
  filter_options?: FilterOptionsConfiguration;
  query_params?: QueryParamsConfig;
};

export type FilterOptionsConfiguration = {
  customizedDropdown?: {
    type: string;
    id: string;
  };
};

export type BenchmarkUiParameters = {
  benchmarkId: string;
  time: { start: Dayjs; end: Dayjs };
  filters: Record<string, string>;
  lbranch: string;
  rbranch: string;
  lcommit?: string;
  rcommit?: string;
  [key: string]: any;
};

export type QueryParamsConfig = {
  type: string; // type of the query params process user to choose, such as 'converter'
  id: string; // id of the registered convert use to process query params
};

/* ----------------------- Converter function signatures --------------------- */
export type QueryParameterConverterInputs = {
  timeRange: TimeRange;
  branches?: string[];
  commits?: string[];
  filters: Record<string, any>;
  maxSampling?: number;
  [key: string]: any;
};

export type QueryParameterConverter = (
  inputs: QueryParameterConverterInputs
) => any;

/* ---------------------------- Default converter ---------------------------- */
export const getDefaultDataConverter: QueryParameterConverter = (i) => {
  return {
    ...i.filters,
    branches: i.branches ?? [],
    commits: i.commits ?? [],
    startTime: dayjs.utc(i.timeRange.start).format("YYYY-MM-DDTHH:mm:ss"),
    stopTime: dayjs.utc(i.timeRange.end).format("YYYY-MM-DDTHH:mm:ss"),
  };
};

/* ------------------------------ Registry (fixed) --------------------------- */
export const CONVERTER_REGISTRY: Record<string, QueryParameterConverter> = {
  compilerQueryParameterConverter,
  default: getDefaultDataConverter,
};

/* ============================ The Binding Class ============================ */
export class DataBinding {
  private readonly cfg: Required<DataBindingConfig>;
  private readonly converters: Readonly<
    Record<string, QueryParameterConverter>
  > = CONVERTER_REGISTRY;
  private readonly defaultConverter: QueryParameterConverter =
    getDefaultDataConverter;

  constructor(cfg: DataBindingConfig) {
    if (!cfg.initial) throw new Error("initial params are required");
    if (cfg.initial.benchmarkId.length === 0)
      throw new Error("benchmarkId is required");

    const filled: Required<DataBindingConfig> = {
      initial: {
        ...cfg.initial,
        time: cfg.initial?.time ?? {
          start: dayjs.utc().startOf("day").subtract(7, "day"),
          end: dayjs.utc().endOf("day"),
        },
        filters: cfg.initial?.filters ?? {},
        lbranch: cfg.initial?.lbranch ?? "",
        rbranch: cfg.initial?.rbranch ?? "",
      },
      required_filter_fields: cfg.required_filter_fields ?? [],
      filter_options: cfg.filter_options ?? {},
      query_params: cfg.query_params ?? {
        type: "converter",
        id: "default",
      },
    };
    this.cfg = filled;
  }

  get raw(): DataBindingConfig {
    return this.cfg;
  }

  /** Return the default UI parameters block from config (deep read-only). */
  get initialParams(): Readonly<BenchmarkUiParameters> {
    return this.cfg.initial;
  }

  /**
   * render the filter options component based on the filter_options config
   */
  getFilterOptionComponent = (): React.ComponentType<any> => {
    const dr = this.cfg.filter_options?.customizedDropdown;
    if (!dr || dr.type != "component") return DefaultMetricsDropdowns;
    const Comp = resolveComponent(dr.id);
    if (Comp) return Comp;
    // inline fallback component to satisfy the return type
    const Missing: React.FC = () => <NotFoundComponent name={dr.id} />;
    return Missing;
  };

  /** Pick a converter by name; fall back to default. */
  getConverter(): QueryParameterConverter | undefined {
    if (
      !this.cfg.query_params?.type ||
      this.cfg.query_params.type != "converter"
    ) {
      return;
    }
    const id = this.cfg.query_params?.id;
    if (!id) return;
    const conv = this.converters[id];
    if (conv) return conv;
    return this.defaultConverter;
  }

  /**
   * Build backend query params from UI parameters, using a named converter
   * (or the default if name is omitted/unknown).
   */
  toQueryParams(inputs: QueryParameterConverterInputs): any {
    const conv = this.getConverter();
    if (!conv) return undefined;
    const res = conv(inputs);

    // if maxSampling is set, but not in the convertor result
    // control the max threshold of workflow data, if it's too large, sample the data to avoid OOM
    // the maxSampling must be larger than 5
    if (inputs.maxSampling && !res.sampling) {
      const sampling = Math.max(5, inputs.maxSampling);
      res.sampling = {
        max: sampling,
      };
    }
    return res;
  }
}
