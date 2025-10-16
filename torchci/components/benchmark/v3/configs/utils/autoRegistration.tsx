import { BenchmarkCommitMeta } from "lib/benchmark/store/benchmark_regression_store";
import { AutoBenchmarkPairwiseComparisonTable } from "../../components/dataRender/auto/AutoComponents";


export type AutoComponent = React.ComponentType;

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
      AutoBenchmarkPairwiseComparisonTable: {
        Component: AutoBenchmarkPairwiseComparisonTable,
      },
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
