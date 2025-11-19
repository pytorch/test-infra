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
  const items: (NavCategory | NavItem)[] = categories
    .map((c: BenchmarkCategoryGroup) => {
      if (c.items.length === 1) {
        const item: NavItem = {
          label: c.items[0].name,
          route: c.items[0].route,
          type: "item",
        };
        return item;
      }
      const group: NavCategory = {
        label: c.title,
        items: c.items
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((i) => ({ label: i.name, route: i.route, type: "item" })),
        type: "group",
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
  console.log("benchmark nav items:", items);

  return [
    ...items,
    { type: "divider" },
    {
      label: "View All Benchmarks",
      type: "item",
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
