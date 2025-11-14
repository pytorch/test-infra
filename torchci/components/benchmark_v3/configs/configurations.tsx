import { BenchmarkCategoryGroup } from "../components/benchmarkList/BenchmarkCategoryCard";
import { BenchmarkIdMappingItem } from "./config_book_types";

export const REPORT_ID_TO_BENCHMARK_ID_MAPPING: Record<string, string> = {
  compiler_regression: "compiler_inductor",
};

export const BENCHMARK_ID_MAPPING: Record<string, BenchmarkIdMappingItem> = {
  compiler_inductor: {
    id: "compiler_inductor",
    repoName: "pytorch/pytorch",
    benchmarkName: "compiler_inductor",
  },
  compiler_precompute: {
    id: "compiler_precompute",
    repoName: "pytorch/pytorch",
    benchmarkName: "compiler_precompute",
  },
  pytorch_operator_microbenchmark: {
    id: "pytorch_operator_microbenchmark",
    repoName: "pytorch/pytorch",
    benchmarkName: "PyTorch operator microbenchmark",
  },
  pytorch_helion: {
    id: "pytorch_helion",
    repoName: "pytorch/helion",
    benchmarkName: "Helion Benchmark",
  },
  torchao_micro_api_benchmark: {
    id: "torchao_micro_api_benchmark",
    repoName: "pytorch/ao",
    benchmarkName: "micro-benchmark api",
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
        name: "CacheBench Benchmark",
        route:
          "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=+Benchmark",
        info: "Powered by [code](https://github.com/search?q=repo%3Apytorch%2Fpytorch%20%20TorchCache&type=code)",
      },
      {
        name: "Compiler Inductor Benchmark",
        id: "compiler_inductor",
        route: "/benchmark/compilers_regression",
        description:
          "Use `legacy page` to see comparison view for different branches. It will be deprecated soon",
        info: "Powered by [code](https://github.com/pytorch/pytorch/tree/main/benchmarks/dynamo#torchcompile-benchmarking)",
        actions: [
          {
            label: "New dashboard (WIP)",
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
        name: "LLMs Benchmark",
        route: "/benchmark/llms?repoName=pytorch%2Fpytorch",
        info: "Powered by [code](https://github.com/pytorch/pytorch/tree/main/benchmarks/gpt_fast)",
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
        route: "/benchmark/v3/dashboard/torchao_micro_api_benchmark",
        info: "Powered by [code](https://github.com/pytorch/ao/blob/main/docs/source/benchmarking_api_guide.md)",
        actions: [
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
        route:
          "/benchmark/llms?repoName=pytorch%2Fhelion&benchmarkName=Helion+Benchmark",
        info: "Powered by [code](https://github.com/pytorch/helion/tree/main/benchmarks)",
        actions: [
          {
            label: "New dashboard (WIP)",
            href: "/benchmark/v3/dashboard/pytorch_helion",
          },
        ],
      },
    ],
  },
];
