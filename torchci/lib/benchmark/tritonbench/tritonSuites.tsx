export interface SuiteConfig {
  name: string;
  id: string;
  description?: string;
  showGraph: boolean;
}

/**
 * Tritonbench suites map returns  map of suites and their rendering configurations.
 */
export const TRITON_SUITES_MAP: { [k: string]: SuiteConfig } = {
  tritonbench: {
    name: "Tritonbench",
    id: "tritonbench",
    showGraph: true,
  },
};
