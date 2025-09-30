import SearchIcon from "@mui/icons-material/Search";
import {
  Box,
  Grid,
  InputAdornment,
  TextField,
  Typography,
} from "@mui/material";
import * as React from "react";
import { useMemo, useState } from "react";
import {
  BenchmarkCategoryCard,
  BenchmarkCategoryGroup,
} from "./BenchmarkCategoryCard";

export interface BenchmarkCategoryCardsProps {
  /** Categories to render */
  categories: BenchmarkCategoryGroup[];
  /** Placeholder for the search box */
  searchPlaceholder?: string;
  /** Optional initial query */
  initialQuery?: string;
  /** Grid column count at breakpoints */
  columns?: { xs?: number; sm?: number; md?: number; lg?: number; xl?: number };
  /** Optional override for link component (defaults to Next.js Link). */
  linkComponent?: React.ElementType<{
    href: string;
    children: React.ReactNode;
  }>;
}

// ============================
// Component
// ============================
export default function BenchmarkCategoryCardList({
  categories,
  searchPlaceholder = "Search benchmarks, categories, tags…",
  initialQuery = "",
  columns = { xs: 12, sm: 12, md: 6, lg: 4, xl: 3 },
}: BenchmarkCategoryCardsProps) {
  const [query, setQuery] = useState(initialQuery);

  // Filter categories and items based on user input from search box
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return categories;
    return categories
      .map((cat) => {
        const catMatches = matchQuery(q, cat.title, cat.subtitle, cat.tags);
        const matchedItems = cat.items.filter((it) =>
          matchQuery(q, it.name, it.description)
        );
        // If category matches but no items matched, keep all; else keep only matched items
        const items =
          catMatches && matchedItems.length === 0 ? cat.items : matchedItems;
        return items.length > 0 || catMatches ? { ...cat, items } : null;
      })
      .filter((x): x is BenchmarkCategoryGroup => Boolean(x));
  }, [categories, query]);

  return (
    <Box sx={{ width: "100%" }}>
      <Box sx={{ mb: 2 }}>
        <TextField
          fullWidth
          size="medium"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon />
                </InputAdornment>
              ),
              // native input attributes go under inputProps
              inputProps: { "aria-label": "search benchmarks" },
            },
          }}
        />
        <Typography
          variant="caption"
          sx={{ color: "text.secondary", mt: 0.5, display: "block" }}
        >
          Tip: search by category, page name, description, tag, or route.
        </Typography>
      </Box>
      <Grid container spacing={2} columns={12}>
        {filtered.map((cat, i) => (
          <Grid key={cat.title + i} size={columns}>
            <BenchmarkCategoryCard cat={cat} query={query} />
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

// ============================
// Helper utils
// ============================
function safeLowercase(s?: string) {
  return (s ?? "").toLowerCase();
}

function matchQuery(
  q: string,
  ...fields: Array<string | undefined | string[]>
) {
  if (!q) return true;
  const nq = safeLowercase(q);
  return fields.some((f) => {
    if (Array.isArray(f)) return f.some((x) => safeLowercase(x).includes(nq));
    return safeLowercase(f).includes(nq);
  });
}
