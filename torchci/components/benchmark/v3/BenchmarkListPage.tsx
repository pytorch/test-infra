import { Box, Typography } from "@mui/material";
import { BenchmarkCategoryGroup } from "./components/benchmarkList/BenchmarkCategoryCard";
import BenchmarkCategoryCardList from "./components/benchmarkList/BenchmarkCategoryCardList";

export function BenchmarkListPage() {
  const categories: BenchmarkCategoryGroup[] = [
    {
      title: "Compiler Inductor Benchmark",
      subtitle: "Pages related to compiler performance and regressions",
      tags: ["torchinductor", "inductor"],
      items: [
        {
          name: "Compiler Inductor Regression Tracking (v3)",
          route: "/benchmark/compilers_regression",
          description: "New compiler regression tracking page.",
          actions: [
            {
              label: "Docs",
              href: "https://pytorch.org/docs/stable/inductor.html",
            },
          ],
        },
        {
          name: "Compiler Regression Tracking (legacy)",
          description:
            "Legacy compiler regression tracking page. Use the new one above",
          route: "benchmark/compilers",
        },
      ],
    },
    {
      title: "TorchAo Benchmark",
      tags: ["torchao", "ao"],
      subtitle:
        "Pages related to torch ao benchmark performance and regressions",
      items: [
        {
          name: "TorchAO",
          route: "/benchmark/llms?repoName=pytorch%2Fao",
          description: "TorchAO benchmark Page",
        },
        {
          name: "TorchAO Micro API",
          route:
            "/benchmark/llms?repoName=pytorch%2Fao&benchmarkName=micro-benchmark+api",
          description: "TorchAO Micro API benchmark Page",
        },
      ],
    },
    {
      title: "PyTorch Operator Microbenchmark",
      tags: ["pytorch", "operator", "micro"],
      items: [
        {
          name: "PyTorch Operator Microbenchmark Page",
          route:
            "/benchmark/llms?repoName=pytorch%2Fpytorch&benchmarkName=PyTorch+operator+microbenchmark",
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
