import { Box, Typography } from "@mui/material";
import { NavCategory, NavItem } from "components/layout/NavBarGroupDropdown";
import { BenchmarkCategoryGroup } from "./components/benchmarkList/BenchmarkCategoryCard";
import BenchmarkCategoryCardList from "./components/benchmarkList/BenchmarkCategoryCardList";

export const categories: BenchmarkCategoryGroup[] = [
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
        route: "/benchmark/compilers_regression",
        description:
          "Use `legacy page` to see comparison view for different branches. It will be deprecated soon",
        info: "Powered by [code](https://github.com/pytorch/pytorch/tree/main/benchmarks/dynamo#torchcompile-benchmarking)",
        actions: [
          {
            label: "Legacy Page/Playground",
            href: "/benchmark/compilers",
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
        route:
          "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=PyTorch+operator+microbenchmark",
        info: "Powered by [code](https://github.com/pytorch/pytorch/tree/main/benchmarks/operator_benchmark)",
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
        name: "TorchAO Benchmark",
        route: "/benchmark/llms?repoName=pytorch%2Fao",
      },
      {
        name: "TorchAO Micro API Benchmark",
        route:
          "/benchmark/llms?repoName=pytorch%2Fao&benchmarkName=micro-benchmark+api",
        info: "Powered by [code](https://github.com/pytorch/ao/blob/main/docs/source/benchmarking_api_guide.md)",
      },
    ],
  },
  {
    title: "ExecuTorch Benchmarks",
    tags: ["repo:pytorch/executorch"],
    subtitle: "Benchmarks related to repo pytorch/executorch",
    items: [
      {
        name: "ExecuTorch Benchmark",
        route: "/benchmark/llms?repoName=pytorch%2Fexecutorch",
        info: "Powered by [apple-perf](https://github.com/pytorch/executorch/blob/main/.github/workflows/apple-perf.yml) \
        and [android-perf](https://github.com/pytorch/executorch/blob/main/.github/workflows/android-perf.yml) workflows",
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
      },
    ],
  },
];

export function benchmarkCategoryCardToNavGroup(
  categories: BenchmarkCategoryGroup[]
): NavCategory[] {
  const items: NavCategory[] = categories
    .map((c: BenchmarkCategoryGroup) => ({
      label: c.title,
      items: c.items
        .map((i: any) => ({ label: i.name, route: i.route }))
        .sort((a: NavItem, b: NavItem) => a.label.localeCompare(b.label)),
    }))
    .sort((a: NavCategory, b: NavCategory) => a.label.localeCompare(b.label));
  // Add a "All Benchmarks" item to the top of the list
  items.push({
    label: "View All Benchmarks",
    type: "bottom",
    items: [
      {
        label: "View All Benchmarks",
        route: "/benchmark/benchmark_list",
      },
    ],
  });
  return items;
}

export const benchmarkNavGroup: NavCategory[] =
  benchmarkCategoryCardToNavGroup(categories);

export function BenchmarkListPage() {
  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Benchmarks
      </Typography>
      <BenchmarkCategoryCardList categories={categories} />
    </Box>
  );
}
