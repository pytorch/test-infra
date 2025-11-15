import { Box, Typography } from "@mui/material";
import { NavCategory, NavItem } from "components/layout/NavBarGroupDropdown";
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
