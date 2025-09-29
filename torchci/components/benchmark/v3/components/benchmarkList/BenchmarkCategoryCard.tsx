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
  Typography,
} from "@mui/material";
import { Box } from "@mui/system";

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
  /** Visible link text */
  name: string;
  /** Route href, e.g. "/benchmark/compiler_regression" */
  route: string;
  /** Optional sentence describing what the page shows */
  description?: string;
  /** Optional tags to render as chips */
  tags?: string[];
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
  LinkComponent,
}: {
  it: BenchmarkLinkItem;
  query: string;
  LinkComponent: React.ElementType<{ href: string; children: React.ReactNode }>;
}) {
  return (
    <ListItem key={it.route} disablePadding>
      <ListItemButton component={LinkComponent as any} href={it.route}>
        <ListItemText
          primary={
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="subtitle1" component="span">
                {highlight(it.name, query)}
              </Typography>
              {it.tags && it.tags.length > 0 && (
                <Stack direction="row" spacing={0.5} sx={styles.chipWrap}>
                  {it.tags.map((t) => (
                    <Chip key={t} size="small" label={t} />
                  ))}
                </Stack>
              )}
            </Stack>
          }
          secondary={
            it.description ? (
              <Typography variant="body2" color="text.secondary">
                {highlight(it.description, query)}
              </Typography>
            ) : undefined
          }
        />
      </ListItemButton>
    </ListItem>
  );
}

export function BenchmarkCategoryCard({
  cat,
  query,
  LinkComponent,
}: {
  cat: BenchmarkCategoryGroup;
  query: string;
  LinkComponent: React.ElementType<{ href: string; children: React.ReactNode }>;
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
      <CardContent sx={styles.content}>
        {cat.items.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No matches in this category.
          </Typography>
        ) : (
          <List dense disablePadding sx={styles.list}>
                {cat.items.map((it, index) => (
                <>
                    <BenchmarkCardItem
                        key={it.route}
                        it={it}
                        query={query}
                        LinkComponent={LinkComponent}
                    />
                    {index<cat.items.length - 1 && <Divider key={`divider-${index}`} />}
                </>
            ))}
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
