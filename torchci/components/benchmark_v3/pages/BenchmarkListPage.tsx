import { Box, Typography } from "@mui/material";
import {
  NavCategory,
  NavDivider,
  NavItem,
} from "components/layout/NavBarGroupDropdown";
import { BenchmarkCategoryGroup } from "../components/benchmarkList/BenchmarkCategoryCard";
import BenchmarkCategoryCardList from "../components/benchmarkList/BenchmarkCategoryCardList";
import { BENCHMARK_CATEGORIES } from "../configs/configurations";

export function getBenchmarkMainRouteById(id: string): string | undefined {
  for (const category of BENCHMARK_CATEGORIES) {
    for (const item of category.items) {
      if (item.id === id) {
        return item.route;
      }
    }
  }
  // by default, form the v3 route to dashboard page
  return `/benchmark/v3/dashboard/${id}`;
}

export function benchmarkCategoryCardToNavGroup(
  categories: BenchmarkCategoryGroup[]
): (NavCategory | NavItem | NavDivider)[] {
  const items = categories
    .map((c: BenchmarkCategoryGroup) => {
      if (c.items.length === 1) {
        const item = {
          label: c.items[0].name,
          route: c.items[0].route,
          type: "item" as const,
        };
        return item;
      }
      const group = {
        label: c.title,
        items: c.items
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((i) => ({
            label: i.name,
            route: i.route,
            type: "item" as const,
          })),
        type: "group" as const,
      };
      return group;
    })
    .sort((a, b) =>
      // group comes after item, then sort by label
      a.type != b.type
        ? a.type === "item"
          ? -1
          : 1
        : a.label.localeCompare(b.label)
    );

  return [
    ...items,
    { type: "divider" as const },
    {
      label: "View All Benchmarks",
      type: "item" as const,
      route: "/benchmark/benchmark_list",
    },
  ];
}

export const benchmarkNavGroup: (NavCategory | NavItem | NavDivider)[] =
  benchmarkCategoryCardToNavGroup(BENCHMARK_CATEGORIES);

export function BenchmarkListPage() {
  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Benchmarks
      </Typography>
      <BenchmarkCategoryCardList categories={BENCHMARK_CATEGORIES} />
    </Box>
  );
}
