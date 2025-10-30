import { DefaultAutoRenderContent } from "components/benchmark_v3/components/dataRender/auto/defaultAutoRenderContent";
import { DefaultFanoutRenderContent } from "components/benchmark_v3/components/dataRender/fanout/defaultFanoutRenderContent";
import {
  NotFoundComponent,
  resolveComponent,
} from "components/benchmark_v3/configs/helpers/configRegistration";
import {
  DataBinding,
  DataBindingConfig,
} from "components/benchmark_v3/configs/utils/dataBindingRegistration";
import {
  CompilerDashboardBenchmarkUIConfig,
  CompilerPrecomputeBenchmarkUIConfig,
  COMPILTER_BENCHMARK_NAME,
  COMPILTER_PRECOMPUTE_BENCHMARK_ID,
} from "components/benchmark_v3/configs/teams/compilers/config";
import { defaultDashboardBenchmarkUIConfig } from "components/benchmark_v3/configs/teams/defaults/default_dashboard_config";
import {
  PYTORCH_OPERATOR_MICROBENCHMARK_ID,
  PytorchOperatorMicroBenchmarkDashoboardConfig,
} from "components/benchmark_v3/configs/teams/torchao/config";

import { create } from "zustand";

export const BenchmarkPageType = {
  DashboardPage: "dashboard",
  AggregatePage: "aggregate",
  SinglePage: "single",
} as const;

// Infer the type automatically
export type BenchmarkPageType =
  typeof BenchmarkPageType[keyof typeof BenchmarkPageType];

export type BenchmarkUIConfig = {
  apiId: string;
  type: BenchmarkPageType;
  benchmarkId: string;
  title: string;
  dataBinding: DataBindingConfig; // data binding config
  dataRender: DataRenderOption; // main render components
  required_filter_fields?: readonly string[]; // required filter fields
};

export type BenchmarkUIConfigFilterConstarint = {
  disabled?: boolean; // disable the filter
  disableOptions?: string[]; // disable the options based on value
};
export type BenchmarkUIConfigFilterConstarintConfig = {
  [key: string]: BenchmarkUIConfigFilterConstarint;
};

export type UIRenderConfig = {
  title?: string; // title of the component to render
  id?: string; // id of the component to render
  type: string; // type of the component to render
  config: any; // config of the component to render
};

export type SubSectionRenderConfig = {
  filterConstraint?: BenchmarkUIConfigFilterConstarintConfig; // filter constraint of the component to render, only used when it's subrender
  renders: UIRenderConfig[];
};

export type DataRenderOption = {
  type: string;
  api?: any;
  id?: string; // id of the component to render, this is used when type is 'component'
  sideRender?: { [key: string]: UIRenderConfig }; // this used to render side content, such as regression report access
  renders?: UIRenderConfig[]; // this is used when type is predefined type such as 'default-fanout'
  subSectionRenders?: { [key: string]: SubSectionRenderConfig }; // this is used when type is predefined type such as 'default-f
};

/**
 * A class to host a single benchmark UI config
 */
export class BenchmarkUIConfigHandler {
  private _benchmarkId: string;
  private _type: BenchmarkPageType;
  private _config: BenchmarkUIConfig;
  private _dataBinding: DataBinding;

  constructor(config: BenchmarkUIConfig) {
    this._benchmarkId = config.benchmarkId;
    this._type = config.type;
    this._config = config;
    this._dataBinding = new DataBinding(
      config.dataBinding,
      this._benchmarkId,
      this._type
    );
  }

  get benchmarkId(): string {
    return this._benchmarkId;
  }

  get type(): BenchmarkPageType {
    return this._type;
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

export type BenchmarkConfigMap = Record<
  string,
  Partial<Record<BenchmarkPageType, BenchmarkUIConfig>>
>;
interface State {
  predefined: BenchmarkConfigMap;
  temps: BenchmarkConfigMap;

  initTempConfig: (
    id: string,
    type: BenchmarkPageType,
    params?: Partial<BenchmarkUIConfig>
  ) => BenchmarkUIConfig;

  ensureConfig: (
    id: string,
    type: BenchmarkPageType,
    params?: Partial<BenchmarkUIConfig>
  ) => BenchmarkUIConfigHandler;

  getConfig: (id: string, type: BenchmarkPageType) => BenchmarkUIConfigHandler;
  listIds: () => string[];
}

const predefined: BenchmarkConfigMap = {
  [COMPILTER_BENCHMARK_NAME]: {
    [BenchmarkPageType.DashboardPage]: CompilerDashboardBenchmarkUIConfig,
  },
  [COMPILTER_PRECOMPUTE_BENCHMARK_ID]: {
    [BenchmarkPageType.AggregatePage]: CompilerPrecomputeBenchmarkUIConfig,
  },
  [PYTORCH_OPERATOR_MICROBENCHMARK_ID]: {
    [BenchmarkPageType.DashboardPage]:
      PytorchOperatorMicroBenchmarkDashoboardConfig,
  },
};

export const useBenchmarkBook = create<State>()((set, get) => ({
  predefined,
  temps: {},

  initTempConfig: (
    id,
    type: BenchmarkPageType = BenchmarkPageType.DashboardPage,
    params = {}
  ) => {
    const { temps } = get();
    let defaultConfig = defaultDashboardBenchmarkUIConfig;
    switch (type) {
      case BenchmarkPageType.DashboardPage:
        defaultConfig = defaultDashboardBenchmarkUIConfig;
        break;
      default:
        throw new Error(
          `Cannot create default page, We currently only support default Dashboard Page, but you request page type: ${type}`
        );
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
          type: type,
        },
      },
    };

    // if group exist override the config in there
    const existingGroup = temps[id];
    const updatedGroup = {
      ...(existingGroup ?? {}), // keep all previous types under this id
      [type]: cfg, // override (or add) this type
    };

    set({
      temps: {
        ...temps,
        [id]: updatedGroup,
      },
    });
    return cfg;
  },

  ensureConfig: (id: string, type: BenchmarkPageType, params = {}) => {
    if (!id) throw new Error("ensureConfig: id is required");
    if (!type) throw new Error("ensureConfig: type is required");

    const { predefined, temps, initTempConfig } = get();
    const group = predefined[id] ?? temps[id];
    if (!group) {
      console.log("ensureConfig creating new config");
    } else {
      console.log(`ensureConfig found existing config for ${id} and ${type}`);
    }
    const cfg = group?.[type] ?? initTempConfig(id, type, params);
    return new BenchmarkUIConfigHandler(cfg);
  },

  getConfig: (id: string, type: BenchmarkPageType) => {
    if (!id) throw new Error("getConfig: id is required");
    if (!type) throw new Error("getConfig: type is required");

    const { predefined, temps } = get();
    const group = predefined[id] ?? temps[id];
    const cfg = group?.[type];
    if (!cfg)
      throw new Error(
        `No config found for id: ${id} and ${type}, Group: ${
          group ? "found the group" : "missing the group"
        }`
      );
    return new BenchmarkUIConfigHandler(cfg);
  },

  listIds: () => {
    const { predefined, temps } = get();
    return [...Object.keys(predefined), ...Object.keys(temps)];
  },
}));
