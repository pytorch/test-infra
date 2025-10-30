import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import {
  FanoutBenchmarkTimeSeriesChartSection,
  FanoutBenchmarkTimeSeriesComparisonTableSection,
} from "../../components/dataRender/fanout/FanoutComponents";

/** ---------------- Types ---------------- */
export type FanoutComponentProps = {
  data?: any[];
  config: any; // your UIRenderConfig slice
  onChange?: (payload: any) => void;
  lcommit?: BenchmarkCommitMeta | null;
  rcommit?: BenchmarkCommitMeta | null;
};
export type FanoutComponent = React.ComponentType<FanoutComponentProps>;

export type FanoutComponentConfig = {
  Component: FanoutComponent;
  /** optional: path to the data in the payload */
  data_path?: string;
};

/** ---------------- Fixed components (examples/placeholders) ---------------- */
// Replace with your actual import

const ErrorFanoutComponent: FanoutComponent = ({ config }) => {
  console.warn(
    "Rendering default fallback fanout component. Bad config:",
    config
  );
  return (
    <div style={{ color: "red", padding: "1rem" }}>
      ⚠ Unknown fanout component type. Please check config.
    </div>
  );
};

/** ---------------- Immutable class ---------------- */
export class FanoutRegistry {
  /** singleton instance */
  private static _instance: FanoutRegistry | null = null;

  /** read-only registry */
  readonly map: Readonly<Record<string, FanoutComponentConfig>>;

  /** read-only fallback */
  readonly fallback: Readonly<FanoutComponentConfig>;

  private constructor() {
    const registry: Record<string, FanoutComponentConfig> = {
      FanoutBenchmarkTimeSeriesChartSection: {
        Component: FanoutBenchmarkTimeSeriesChartSection,
        data_path: "time_series",
      },
      FanoutBenchmarkTimeSeriesComparisonTableSection: {
        Component: FanoutBenchmarkTimeSeriesComparisonTableSection,
        data_path: "table",
      },
    };
    this.map = Object.freeze({ ...registry });
    this.fallback = Object.freeze({ Component: ErrorFanoutComponent });
    Object.freeze(this); // freeze the instance so it can't be mutated
  }

  /** get the singleton */
  static get instance(): FanoutRegistry {
    if (!this._instance) this._instance = new FanoutRegistry();
    return this._instance;
  }

  /** lookup a config; fall back to default */
  get(type: string): FanoutComponentConfig {
    return this.map[type] ?? this.fallback;
  }

  /** list all supported component types */
  listTypes(): string[] {
    return Object.keys(this.map);
  }
}

/** ---------------- Helper function (optional) ---------------- */
export function getFanoutRenderComponent(config: {
  type: string;
}): FanoutComponentConfig {
  return FanoutRegistry.instance.get(config.type);
}
