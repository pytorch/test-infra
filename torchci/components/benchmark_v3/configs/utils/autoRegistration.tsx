import {
  AutoBenchmarkLogs,
  AutoBenchmarkPairwiseTable,
  AutoBenchmarkRawDataTable,
  AutoBenchmarkTimeSeriesChartGroup,
  AutoBenchmarkTimeSeriesTable,
} from "components/benchmark_v3/components/dataRender/auto/autoComponents";

export type AutoComponentProps = {
  config?: any;
};
export type AutoComponent = React.ComponentType<AutoComponentProps>;

export type AutoComponentConfig = {
  Component: AutoComponent;
};

/** ---------------- Fixed components (examples/placeholders) ---------------- */
// Replace with your actual import

const ErrorAutoComponent: AutoComponent = (config) => {
  console.warn(
    "Rendering default fallback auto component. Bad config:",
    config
  );
  return (
    <div style={{ color: "red", padding: "1rem" }}>
      ⚠ Unknown auto component type. Please check config.
    </div>
  );
};

/** ---------------- Immutable class ---------------- */
export class AutoComponentRegistry {
  /** singleton instance */
  private static _instance: AutoComponentRegistry | null = null;

  /** read-only registry */
  readonly map: Readonly<Record<string, AutoComponentConfig>>;

  /** read-only fallback */
  readonly fallback: Readonly<AutoComponentConfig>;

  private constructor() {
    const registry: Record<string, AutoComponentConfig> = {
      AutoBenchmarkTimeSeriesTable: {
        Component: AutoBenchmarkTimeSeriesTable,
      },
      AutoBenchmarkPairwiseTable: {
        Component: AutoBenchmarkPairwiseTable,
      },
      AutoBenchmarkTimeSeriesChartGroup: {
        Component: AutoBenchmarkTimeSeriesChartGroup,
      },
      AutoBenchmarkRawDataTable: {
        Component: AutoBenchmarkRawDataTable,
      },
      AutoBenchmarkLogs: {
        Component: AutoBenchmarkLogs,
      },
      // Add your auto components here
    };
    this.map = Object.freeze({ ...registry });
    this.fallback = Object.freeze({ Component: ErrorAutoComponent });
    Object.freeze(this); // freeze the instance so it can't be mutated
  }

  /** get the singleton */
  static get instance(): AutoComponentRegistry {
    if (!this._instance) this._instance = new AutoComponentRegistry();
    return this._instance;
  }

  /** lookup a config; fall back to default */
  get(type: string): AutoComponentConfig {
    return this.map[type] ?? this.fallback;
  }

  /** list all supported component types */
  listTypes(): string[] {
    return Object.keys(this.map);
  }
}

/** ---------------- Helper function (optional) ---------------- */
export function getAutoRenderComponent(config: {
  type: string;
}): AutoComponentConfig {
  return AutoComponentRegistry.instance.get(config.type);
}
