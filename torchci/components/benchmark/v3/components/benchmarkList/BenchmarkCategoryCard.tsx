import {
  Card,
  CardContent,
  CardHeader,
  Chip,
  Divider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { Box } from "@mui/system";
import Link from "next/link";

// ============================
// Styles (centralized)
// ============================
const styles = {
  root: { width: "100%" },
  searchBox: { mb: 2 },
  tip: { color: "text.secondary", mt: 0.5, display: "block" },
  grid: {},
  gridItem: {},
  card: { height: "100%", display: "flex", flexDirection: "column" },
  chipWrap: { flexWrap: "wrap" },
  chip: { mr: 0.5, mb: 0.5 },
  content: { pt: 0, flex: 1, display: "flex", flexDirection: "column" },
  list: { mt: 1 },
};

// ============================
// Types
// ============================
export interface BenchmarkLinkItem {
  name: string;
  route: string;
  description?: string;
  keys?: string[];
  actions?: {
    label: string;
    onClick?: () => void;
    href?: string;
    icon?: React.ReactNode;
  }[];
}
export interface BenchmarkCategoryGroup {
  /** Category title shown on the card header */
  title: string;
  /** Optional short blurb under the title */
  subtitle?: string;
  /** Optional category-level tags (rendered as chips) */
  tags?: string[];
  /** Items in this category */
  items: BenchmarkLinkItem[];
  /** Extra search keys for the whole category */
  keys?: string[];
}

function BenchmarkCardItem({
  it,
  query,
}: {
  it: BenchmarkLinkItem;
  query: string;
}) {
  const buttonProps = isExternal(it.route)
    ? {
        component: "a" as const,
        href: it.route,
        target: "_blank",
        rel: "noopener noreferrer",
      }
    : {
        component: Link as any,
        href: it.route,
        // optional Next.js tweaks:
        prefetch: false,
      };

  return (
    <ListItem key={it.route} disablePadding>
      <Box sx={{ width: "100%" }}>
        <Tooltip title="go to main page" arrow>
          <ListItemButton {...buttonProps}>
            <ListItemText
              primary={
                <Typography variant="subtitle1">
                  {highlight(it.name, query)}
                </Typography>
              }
              secondary={it.description}
            />
          </ListItemButton>
        </Tooltip>

        {/* Actions */}
        {it.actions && (
          <Stack direction="row" spacing={1} sx={{ px: 2, pb: 1, pt: 0.5 }}>
            {it.actions.map((a, idx) => {
              if (!a.href) {
                // non-link action (local click)
                return (
                  <Chip
                    key={idx}
                    clickable
                    size="small"
                    color="secondary"
                    label={a.label}
                    onClick={a.onClick}
                  />
                );
              }
              const linkProps = isExternal(a.href)
                ? {
                    component: "a" as const,
                    href: a.href,
                    target: "_blank",
                    rel: "noopener noreferrer",
                  }
                : {
                    component: Link as any,
                    href: a.href,
                    // optional Next.js tweaks:
                    prefetch: false,
                  };
              return (
                <Chip
                  {...linkProps}
                  clickable
                  size="small"
                  color="primary"
                  label={a.label}
                />
              );
            })}
          </Stack>
        )}
      </Box>
    </ListItem>
  );
}

export function BenchmarkCategoryCard({
  cat,
  query,
}: {
  cat: BenchmarkCategoryGroup;
  query: string;
}) {
  return (
    <Card variant="outlined" sx={styles.card}>
      <CardHeader
        title={highlight(cat.title, query)}
        subheader={cat.subtitle}
        action={
          cat.tags && cat.tags.length > 0 ? (
            <Stack direction="row" spacing={0.5} sx={styles.chipWrap}>
              {cat.tags.map((t) => (
                <Chip key={t} size="small" label={t} sx={styles.chip} />
              ))}
            </Stack>
          ) : null
        }
      />
      <Divider />
      <CardContent sx={styles.content}>
        {cat.items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No matches in this category.
          </Typography>
        ) : (
          <List dense disablePadding sx={styles.list}>
            {cat.items.map((it, index) => {
              // add "Main Page" action to all items
              const actions = [
                { label: "Main Page", href: it.route },
                ...(it.actions ?? []), // keep existing actions if any
              ];
              return (
                <>
                  <BenchmarkCardItem
                    key={it.route}
                    it={{ ...it, actions }}
                    query={query}
                  />
                  {index < cat.items.length - 1 && (
                    <Divider key={`divider-${index}`} />
                  )}
                </>
              );
            })}
          </List>
        )}
      </CardContent>
    </Card>
  );
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  const before = text.slice(0, idx);
  const mid = text.slice(idx, idx + q.length);
  const after = text.slice(idx + q.length);
  return (
    <>
      {before}
      <Box
        component="mark"
        sx={{ bgcolor: "warning.light", px: 0.3, py: 0.1, borderRadius: 0.5 }}
      >
        {mid}
      </Box>
      {after}
    </>
  );
}

const isExternal = (url: string) => /^https?:\/\//i.test(url);
