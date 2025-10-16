import { DefaultAutoRenderContent } from "components/benchmark/v3/components/dataRender/auto/defaultAutoRenderContent";
import { DefaultFanoutRenderContent } from "components/benchmark/v3/components/dataRender/fanout/defaultFanoutRenderContent";
import {
  NotFoundComponent,
  resolveComponent,
} from "components/benchmark/v3/configs/configRegistration";
import {
  CompilerPrecomputeBenchmarkUIConfig,
  COMPILTER_PRECOMPUTE_BENCHMARK_ID,
} from "components/benchmark/v3/configs/teams/compilers/config";
import { defaultDashboardBenchmarkUIConfig } from "components/benchmark/v3/configs/teams/default/default_dashboard_config";
import {
  DataBinding,
  DataBindingConfig,
} from "components/benchmark/v3/configs/utils/dataBindingRegistration";
import { create } from "zustand";

export type BenchmarkUIConfig = {
  benchmarkId: string;
  apiId: string;
  title: string;
  type: string; // type of the component to render
  dataBinding: DataBindingConfig; // data binding config
  dataRender: DataRenderOption; // either binds a component or a converter function to render data
  required_filter_fields?: readonly string[]; // required filter fields
};

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

/**
 * A class to host a single benchmark UI config
 */
export class BenchmarkUIConfigHandler {
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

  /**
   * Get DataRenderComponent, this fetches the skeleton to render the content of the benchmark
   * - fanout: the component calls the api once and passes the data to the component
   * - self-fetching: the component calls the api multiple times and maintain the state by themselves
   * - customized: user defined component
   * @returns the component to render the data
   */
  getDataRenderComponent = (): React.ComponentType<any> => {
    const dr = this._config.dataRender;
    if (!dr) {
      throw new Error(
        `No data render config found for ${this._benchmarkId}, this is internal error, please report `
      );
    }
    switch (dr.type) {
      case "fanout":
        return DefaultFanoutRenderContent;
      case "auto":
        return DefaultAutoRenderContent;
      case "customized":
        const Comp = resolveComponent(dr.id);
        if (Comp) return Comp;
      default:
        // inline fallback component to satisfy the return type
        const Missing: React.FC = () => (
          <NotFoundComponent name={`ID: ${dr.id} and Type:${dr.type}`} />
        );
        return Missing;
    }
  };
}

type ConfigMap = Record<string, BenchmarkUIConfig>;

interface State {
  predefined: ConfigMap;
  temps: ConfigMap;

  initTempConfig: (
    id: string,
    type?: string,
    params?: Partial<BenchmarkUIConfig>
  ) => BenchmarkUIConfig;
  ensureConfig: (
    id: string,
    type?: string,
    params?: Partial<BenchmarkUIConfig>
  ) => BenchmarkUIConfigHandler;
  getConfig: (id: string) => BenchmarkUIConfigHandler;
  listIds: () => string[];
}

const predefined: ConfigMap = {
  [COMPILTER_PRECOMPUTE_BENCHMARK_ID]: CompilerPrecomputeBenchmarkUIConfig,
};

export const useBenchmarkBook = create<State>()((set, get) => ({
  predefined,
  temps: {},

  initTempConfig: (id, type = "dashboard", params = {}) => {
    const { temps } = get();
    let defaultConfig = defaultDashboardBenchmarkUIConfig;
    switch (type) {
      case "dashboard":
        defaultConfig = defaultDashboardBenchmarkUIConfig;
        break;
      default:
        throw new Error(`Unknown type: ${type}`);
    }
    const cfg: BenchmarkUIConfig = {
      ...defaultDashboardBenchmarkUIConfig,
      type,
      benchmarkId: id,
      apiId: params.apiId ?? id,
      title: params.title ?? id,
      dataBinding: {
        ...defaultConfig.dataBinding,
        initial: {
          ...defaultConfig.dataBinding.initial,
          benchmarkId: id,
        },
      },
    };
    set({ temps: { ...temps, [id]: cfg } });
    return cfg;
  },

  ensureConfig: (id, type = "dashboard", params = {}) => {
    const { predefined, temps, initTempConfig } = get();
    const cfg = predefined[id] ?? temps[id] ?? initTempConfig(id, type, params);
    return new BenchmarkUIConfigHandler(cfg);
  },

  getConfig: (id) => {
    const { predefined, temps } = get();
    const cfg = predefined[id] ?? temps[id];
    if (!cfg) throw new Error(`No config found for id: ${id}`);
    return new BenchmarkUIConfigHandler(cfg);
  },

  listIds: () => {
    const { predefined, temps } = get();
    return [...Object.keys(predefined), ...Object.keys(temps)];
  },
}));
