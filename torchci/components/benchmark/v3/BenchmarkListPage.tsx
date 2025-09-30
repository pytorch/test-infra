import { Box, Typography } from "@mui/material";
import { BenchmarkCategoryGroup } from "./components/benchmarkList/BenchmarkCategoryCard";
import BenchmarkCategoryCardList from "./components/benchmarkList/BenchmarkCategoryCardList";

export function BenchmarkListPage() {
  const categories: BenchmarkCategoryGroup[] = [
    {
      title: "PyTorch Benchmarks",
      subtitle: "Benchmarks related to repo pytorch/pytorch",
      tags: ["repo:pytorch/pytorch"],
      items: [
        {
          name: "PyTorch CacheBench Benchmark",
          route:
            "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=TorchCache+Benchmark",
        },
        {
          name: "Pytorch Compiler Inductor Benchmark Dashboard",
          route: "/benchmark/compilers_regression",
          description:
            "Use `legacy page` to see comparison view for different branches. It will be deprecated soon",
          actions: [
            {
              label: "Legacy Page/ Playground",
              href: "/benchmark/compilers",
            },
            {
              label: "Docs",
              href: "https://docs.pytorch.org/docs/main/torch.compiler_performance_dashboard.html",
            },
          ],
        },
        {
          name: "PyTorch LLMs Benchmark",
          route: "/benchmark/llms?repoName=pytorch%2Fpytorch",
        },
        {
          name: "PyTorch Operator Microbenchmark",
          description: "PyTorch Operator Microbenchmark Behcnmarks",
          route:
            "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=PyTorch+operator+microbenchmark",
        },
        {
          name: "Pytorch Triton Benchmark Dashboard",
          description: "Pytorch Triton Benchmark Dashboard",
          route: "/tritonbench/commit_view",
        },
      ],
    },
    {
      title: "TorchAo Benchmark",
      tags: ["repo:pytorch/torchao"],
      subtitle: "Benchmarks related to repo pytorch/torchao",
      items: [
        {
          name: "TorchAO Benchmark Danshboard",
          route: "/benchmark/llms?repoName=pytorch%2Fao",
          description: "TorchAO benchmark Page",
        },
        {
          name: "TorchAO Micro API Benchmark Danshboard",
          route:
            "/benchmark/llms?repoName=pytorch%2Fao&benchmarkName=micro-benchmark+api",
          description: "TorchAO Micro API benchmark Page",
        },
      ],
    },
    {
      title: "ExecuTorch",
      tags: ["repo:pytorch/executorch"],
      subtitle: "Benchmarks related to repo pytorch/executorch",
      items: [
        {
          name: "ExecuTorch Benchmark",
          route: "/benchmark/llms?repoName=pytorch%2Fexecutorch",
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
        },
      ],
    },
    {
      title: "SGLang Benchmark",
      subtitle: "Benchmarks related to repo sgl-project/sglang",
      tags: ["repo:sgl-project/sglang"],
      items: [
        {
          name: "SGLang Benchmark Dashboard",
          route: "/benchmark/llms?repoName=sgl-project%2Fsglang",
        },
      ],
    },
    {
      title: "Helion Benchmark",
      subtitle: "Benchmarks related to repo pytorch/helion",
      tags: ["repo:pytorch/helion"],
      items: [
        {
          name: "Helion Benchmark Dashboard",
          route:
            "/benchmark/llms?repoName=pytorch%2Fhelion&benchmarkName=Helion+Benchmark",
        },
      ],
    },
  ];

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Benchmarks
      </Typography>
      <BenchmarkCategoryCardList categories={categories} />
    </Box>
  );
}
