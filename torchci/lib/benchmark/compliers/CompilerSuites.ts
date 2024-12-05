export interface SuiteConfig {
  name: string;
  id: string;
  description?: string;
  showGraph: boolean;
}

export const COMPILER_SUITES_MAP: { [k: string]: SuiteConfig } = {
  torchbench: {
    name: "Torchbench",
    id: "torchbench",
    showGraph: true,
  },
  huggingface: {
    name: "HuggingFace",
    id: "huggingface",
    showGraph: true,
  },
  timm_models: {
    name: "Timm Models",
    id: "timm_models",
    showGraph: true,
  },
  dynamic: {
    name: "[Dynamic]",
    id: "dynamic",
    showGraph: false,
  },
  blueberries: {
    name: "[Blueberries]",
    id: "blueberries",
    showGraph: false,
  },
};
