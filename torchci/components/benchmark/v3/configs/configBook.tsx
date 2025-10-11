import { DefaultFanoutRenderContent } from "../components/dataRender/fanout/defaultFanoutRenderContent";
import {
  CompilerPrecomputeBenchmarkUIConfig,
  COMPILTER_PRECOMPUTE_BENCHMARK_ID,
} from "./teams/compilers/config";
import {
  NotFoundComponent,
  resolveComponent,
} from "./utils/configComponentRegistration";
import {
  DataBinding,
  DataBindingConfig,
} from "./utils/dataBindingRegistration";

export type UIRenderConfig = {
  title?: string; // title of the component to render
  id?: string; // id of the component to render
  type: string; // type of the component to render
  config: any; // config of the component to render
};

export type DataRenderOption = {
  type: string;
  api?: any;
  id?: string; // id of the component to render, this is used when type is 'component'
  sideRender?: { [key: string]: UIRenderConfig }; // this used to render side content, such as regression report access
  renders?: UIRenderConfig[]; // this is used when type is predefined type such as 'default-fanout'
};

export type BenchmarkUIConfig = {
  benchmarkId: string;
  apiId: string;
  title: string;
  dataBinding: DataBindingConfig; // data binding config
  dataRender?: DataRenderOption; // either binds a component or a converter function to render data
  required_filter_fields?: readonly string[]; // required filter fields
};

export class BenchmarkUI {
  private _benchmarkId: string;
  private _config: BenchmarkUIConfig;
  private _dataBinding: DataBinding;

  constructor(config: BenchmarkUIConfig) {
    this._benchmarkId = config.benchmarkId;
    this._config = config;
    this._dataBinding = new DataBinding(config.dataBinding);
  }

  get benchmarkId(): string {
    return this._benchmarkId;
  }

  get raw(): BenchmarkUIConfig {
    return this._config;
  }

  get dataBinding(): DataBinding {
    return this._dataBinding;
  }

  getDataRenderComponent = (): React.ComponentType<any> => {
    const dr = this._config.dataRender;
    if (!dr || dr.type !== "component") return DefaultFanoutRenderContent;

    const Comp = resolveComponent(dr.id);
    if (Comp) return Comp;

    // inline fallback component to satisfy the return type
    const Missing: React.FC = () => (
      <NotFoundComponent name={dr.id ?? "uknown"} />
    );
    return Missing;
  };
}

export class BenchmarkUIConfigBook {
  private static _instance: BenchmarkUIConfigBook | null = null;
  private readonly configs: Record<string, BenchmarkUIConfig>;

  private constructor() {
    this.configs = {
      [COMPILTER_PRECOMPUTE_BENCHMARK_ID]: CompilerPrecomputeBenchmarkUIConfig,
      // add more configs here ...
    };
  }

  /** Get the global singleton instance */
  static get instance(): BenchmarkUIConfigBook {
    if (!this._instance) {
      this._instance = new BenchmarkUIConfigBook();
    }
    return this._instance;
  }

  get(id: string): BenchmarkUIConfig | undefined {
    const config = this.configs[id];
    return config;
  }

  getConfigInstance(id: string): BenchmarkUI {
    const config = this.get(id);
    if (!config) {
      throw new Error(`No config found for id ${id}`);
    }
    return new BenchmarkUI(config);
  }

  listIds(): string[] {
    return Object.keys(this.configs);
  }

  listAll(): BenchmarkUIConfig[] {
    return Object.values(this.configs);
  }

  getDataBinding(id: string): DataBinding {
    const config = this.get(id);
    if (!config) {
      throw new Error(`No config found for id ${id}, cannot get data binding`);
    }
    return new DataBinding(config.dataBinding);
  }
}

export function getBenchmarkBook(): BenchmarkUIConfigBook {
  return BenchmarkUIConfigBook.instance;
}

export function getConfig(id: string): BenchmarkUI {
  return BenchmarkUIConfigBook.instance.getConfigInstance(id);
}

const REPORT_ID_TO_BENCHMARK_ID_MAPPING: Record<string, string> = {
  compiler_regression: "compiler_inductor",
};

/**
 * A helper function to get benchmark id from report id
 * @param reportId
 * @returns
 */
export function getBenchmarkIdFromReportId(reportId: string): string {
  return REPORT_ID_TO_BENCHMARK_ID_MAPPING[reportId] ?? "";
}
