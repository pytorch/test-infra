import {
  CompilerDashboardBenchmarkUIConfig,
  CompilerPrecomputeBenchmarkUIConfig,
  COMPILTER_BENCHMARK_NAME,
  COMPILTER_PRECOMPUTE_BENCHMARK_ID,
} from "components/benchmark_v3/configs/teams/compilers/config";
import {
  PYTORCH_HELION_BENCHMARK_ID,
  PytorchHelionDashboardConfig,
  PytorchHelionSingleConfig,
} from "components/benchmark_v3/configs/teams/helion/config";
import {
  PYTORCH_OPERATOR_MICROBENCHMARK_ID,
  PytorchOperatorMicroBenchmarkDashoboardConfig,
} from "components/benchmark_v3/configs/teams/torchao/config";
import { BenchmarkCategoryGroup } from "../components/benchmarkList/BenchmarkCategoryCard";
import {
  BenchmarkConfigMap,
  BenchmarkIdMappingItem,
  BenchmarkPageType,
} from "./config_book_types";
import {
  PYTORCH_GPTFAST_BENCHMARK_ID,
  PytorchGptFastBenchmarkDashboardConfig,
} from "./teams/gptfast/config";
import {
  PytorcAoMicroApiBenchmarkDashoboardConfig,
  PYTORCH_AO_MICRO_API_BENCHMARK_ID,
} from "./teams/torchao/ao_micro_api_config";
import {
  PYTORCH_VLLM_BENCHMARK_ID,
  PytorchVllmBenchmarkDashoboardConfig,
} from "./teams/vllm/config";

export const REPORT_ID_TO_BENCHMARK_ID_MAPPING: Record<string, string> = {
  compiler_regression: "compiler_inductor",
};

export const PREDEFINED_BENCHMARK_CONFIG: BenchmarkConfigMap = {
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
  [PYTORCH_HELION_BENCHMARK_ID]: {
    [BenchmarkPageType.DashboardPage]: PytorchHelionDashboardConfig,
    [BenchmarkPageType.SinglePage]: PytorchHelionSingleConfig,
  },
  [PYTORCH_AO_MICRO_API_BENCHMARK_ID]: {
    [BenchmarkPageType.DashboardPage]:
      PytorcAoMicroApiBenchmarkDashoboardConfig,
  },
  [PYTORCH_VLLM_BENCHMARK_ID]: {
    [BenchmarkPageType.DashboardPage]: PytorchVllmBenchmarkDashoboardConfig,
  },
  [PYTORCH_GPTFAST_BENCHMARK_ID]: {
    [BenchmarkPageType.DashboardPage]: PytorchGptFastBenchmarkDashboardConfig,
  },
};

export const BENCHMARK_ID_MAPPING: Record<string, BenchmarkIdMappingItem> = {
  [COMPILTER_BENCHMARK_NAME]: {
    id: COMPILTER_BENCHMARK_NAME,
    repoName: "pytorch/pytorch",
    benchmarkName: "compiler_inductor",
  },
  [COMPILTER_PRECOMPUTE_BENCHMARK_ID]: {
    id: COMPILTER_PRECOMPUTE_BENCHMARK_ID,
    repoName: "pytorch/pytorch",
    benchmarkName: "compiler_precompute",
  },
  [PYTORCH_OPERATOR_MICROBENCHMARK_ID]: {
    id: PYTORCH_OPERATOR_MICROBENCHMARK_ID,
    repoName: "pytorch/pytorch",
    benchmarkName: "PyTorch operator microbenchmark",
  },
  [PYTORCH_HELION_BENCHMARK_ID]: {
    id: PYTORCH_HELION_BENCHMARK_ID,
    repoName: "pytorch/helion",
    benchmarkName: "Helion Benchmark",
  },
  [PYTORCH_AO_MICRO_API_BENCHMARK_ID]: {
    id: PYTORCH_AO_MICRO_API_BENCHMARK_ID,
    repoName: "pytorch/ao",
    benchmarkName: "micro-benchmark api",
  },
  [PYTORCH_VLLM_BENCHMARK_ID]: {
    id: PYTORCH_VLLM_BENCHMARK_ID,
    repoName: "vllm-project/vllm",
    benchmarkName: "vLLM benchmark",
  },
  [PYTORCH_GPTFAST_BENCHMARK_ID]: {
    id: PYTORCH_GPTFAST_BENCHMARK_ID,
    repoName: "pytorch/pytorch",
    benchmarkName: "PyTorch gpt-fast benchmark",
  },
};
/**
 * A helper function to get benchmark id from report id
 * @param reportId
 * @returns
 */
export function getBenchmarkIdFromReportId(reportId: string): string {
  return REPORT_ID_TO_BENCHMARK_ID_MAPPING[reportId] ?? reportId;
}

export function getBenchmarkIdMappingItem(
  benchmarkId: string
): BenchmarkIdMappingItem | undefined {
  return BENCHMARK_ID_MAPPING[benchmarkId];
}

/**
 * conifgurations for benchmark list rendering
 */
export const BENCHMARK_CATEGORIES: BenchmarkCategoryGroup[] = [
  {
    title: "PyTorch Benchmarks",
    subtitle: "Benchmarks related to repo pytorch/pytorch",
    tags: ["repo:pytorch/pytorch"],
    items: [
      {
        name: "Compiler Inductor Benchmark",
        id: "compiler_inductor",
        route: "/benchmark/compilers_regression",
        description:
          "Use `legacy page` to see comparison view for different branches. It will be deprecated soon",
        info: "Powered by [code](https://github.com/pytorch/pytorch/tree/main/benchmarks/dynamo#torchcompile-benchmarking)",
        actions: [
          {
            label: "Dashboard",
            href: "/benchmark/v3/dashboard/compiler_inductor",
          },
          {
            label: "Legacy Page/Playground",
            href: "/benchmark/compilers",
          },
          {
            label: "Regression Reports",
            type: "regression_report",
            href: "/benchmark/regression/reports/compiler_regression",
          },
          {
            label: "Docs",
            href: "https://docs.pytorch.org/docs/main/torch.compiler_performance_dashboard.html",
          },
        ],
      },
      {
        name: "Gpt-fast Benchmark",
        route: `/benchmark/v3/dashboard/${PYTORCH_GPTFAST_BENCHMARK_ID}`,
        info: "Powered by [code](https://github.com/pytorch/pytorch/tree/main/benchmarks/gpt_fast)",
        description:
          "Use `legacy page` to see comparison view for different branches. It will be deprecated soon",
        actions: [
          {
            label: "Legacy Page/Playground",
            href: "/benchmark/llms?repoName=pytorch%2Fpytorch",
          },
        ],
      },
      {
        name: "Operator Microbenchmark",
        route: "/benchmark/v3/dashboard/pytorch_operator_microbenchmark",
        info: "Powered by [code](https://github.com/pytorch/pytorch/tree/main/benchmarks/operator_benchmark)",
        description:
          "Use `legacy page` to see comparison view for different branches. It will be deprecated soon",
        actions: [
          {
            label: "Legacy Page/Playground",
            href: "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=PyTorch+operator+microbenchmark",
          },
        ],
      },
      {
        name: "Triton Benchmark",
        route: "/tritonbench/commit_view",
      },
    ],
  },
  {
    title: "TorchAo Benchmarks",
    tags: ["repo:pytorch/torchao"],
    subtitle: "Benchmarks related to repo pytorch/torchao",
    items: [
      {
        name: "TorchAO Micro API Benchmark",
        route: `/benchmark/v3/dashboard/${PYTORCH_AO_MICRO_API_BENCHMARK_ID}`,
        info: "Powered by [code](https://github.com/pytorch/ao/blob/main/docs/source/benchmarking_api_guide.md)",
        actions: [
          {
            label: "Regression Reports",
            type: "regression_report",
            href: `/benchmark/regression/reports/${PYTORCH_AO_MICRO_API_BENCHMARK_ID}`,
          },
          {
            label: "Legacy dashboard",
            href: "/benchmark/llms?repoName=pytorch%2Fao&benchmarkName=micro-benchmark+api",
          },
        ],
      },
    ],
  },
  {
    title: "vLLM Benchmarks ",
    tags: ["repo:vllm-project/vllm"],
    subtitle: "Benchmarks related to repo vllm-project/vllm",
    items: [
      {
        name: "VLLM V1 Benchmark",
        route: "/benchmark/llms?repoName=vllm-project%2Fvllm",
        info: "Powered by [code](https://github.com/pytorch/pytorch-integration-testing/tree/main/vllm-benchmarks/benchmarks)",
        actions: [
          {
            label: "new UI (wip)",
            href: `/benchmark/v3/dashboard/${PYTORCH_VLLM_BENCHMARK_ID}`,
          },
        ],
      },
    ],
  },
  {
    title: "SGLang Benchmarks",
    subtitle: "Benchmarks related to repo sgl-project/sglang",
    tags: ["repo:sgl-project/sglang"],
    items: [
      {
        name: "SGLang Benchmark",
        route: "/benchmark/llms?repoName=sgl-project%2Fsglang",
        info: "Powered by [code](https://github.com/pytorch/pytorch-integration-testing/tree/main/sglang-benchmarks/benchmarks)",
      },
    ],
  },
  {
    title: "Helion Benchmarks",
    subtitle: "Benchmarks related to repo pytorch/helion",
    tags: ["repo:pytorch/helion"],
    items: [
      {
        name: "Helion Benchmark",
        route: `/benchmark/v3/single/${PYTORCH_HELION_BENCHMARK_ID}`,
        info: "Powered by [code](https://github.com/pytorch/helion/tree/main/benchmarks)",
        actions: [
          {
            label: "dashboard",
            href: `/benchmark/v3/dashboard/${PYTORCH_HELION_BENCHMARK_ID}`,
          },
          {
            label: "Regression Reports",
            type: "regression_report",
            href: `/benchmark/regression/reports/${PYTORCH_HELION_BENCHMARK_ID}`,
          },
          {
            label: "legacy dashboard",
            href: "/benchmark/llms?repoName=pytorch%2Fhelion&benchmarkName=Helion+Benchmark",
          },
        ],
      },
    ],
  },
  {
    title: "ExecuTorch Benchmarks",
    subtitle: "Benchmarks related to repo pytorch/executorch",
    tags: ["repo:pytorch/executorch"],
    items: [
      {
        name: "ExecuTorch Benchmark",
        route: "/benchmark/llms?repoName=pytorch%2Fexecutorch",
        info: "Powered by [code](https://github.com/pytorch/executorch/tree/main/.github/workflows)",
      },
    ],
  },
];
