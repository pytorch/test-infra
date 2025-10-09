import ChevronRightIcon from "@mui/icons-material/ChevronRight";
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
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { Box } from "@mui/system";
import Link from "next/link";
import ReactMarkdown from "react-markdown";

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
  info?: string;
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
    <ListItem key={it.route} disablePadding sx={{ mb: 1 }}>
      <Paper
        variant="outlined"
        sx={{
          p: 1,
          width: "100%",
          borderRadius: 2,
          overflow: "hidden",
          borderColor: "divider",
          "&:hover": {
            boxShadow: 3,
            borderColor: "primary.main",
          },
        }}
      >
        <Tooltip title="Go to Main Page" arrow>
          <ListItemButton {...buttonProps}>
            <ListItemText
              primary={
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Typography variant="h6" color="primary">
                    {highlight(it.name, query)}
                  </Typography>
                  <ChevronRightIcon fontSize="small" />
                </Stack>
              }
              secondary={
                it.description?.length ? (
                  <>{highlight(it.description, query)}</>
                ) : null
              }
            />
          </ListItemButton>
        </Tooltip>

        {it.info ? (
          <Stack
            spacing={1}
            sx={{ px: 2, pb: 1, pt: 0.5 }}
            direction="row"
            alignItems="center"
            flexWrap="wrap"
          >
            <Typography variant="subtitle1">Details:</Typography>
            <Typography
              variant="subtitle1"
              color="text.secondary"
              sx={{
                "& p": { margin: 0, lineHeight: 1.2 },
                "& ul, & ol": { margin: 0, paddingLeft: "1.2rem" },
                "& li": { margin: 0, lineHeight: 1.2 },
              }}
            >
              <MarkdownText text={it.info} />
            </Typography>
          </Stack>
        ) : null}

        {it.actions && (
          <Box sx={{ px: 2, pb: 1, pt: 0.5 }}>
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              flexWrap="wrap"
            >
              <Typography variant="subtitle1">Pages:</Typography>
              {it.actions.map((a, idx) => {
                if (!a.href) {
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
                      prefetch: false,
                    };
                return (
                  <Chip
                    {...linkProps}
                    key={idx}
                    clickable
                    size="small"
                    color="primary"
                    label={
                      <Stack direction="row" alignItems="center" spacing={0.5}>
                        <span>{a.label}</span>
                        <ChevronRightIcon fontSize="small" />
                      </Stack>
                    }
                  />
                );
              })}
            </Stack>
          </Box>
        )}
      </Paper>
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
                <BenchmarkCardItem
                  key={it.route}
                  it={{ ...it, actions }}
                  query={query}
                />
              );
            })}
          </List>
        )}
      </CardContent>
    </Card>
  );
}

// ============================
// Helpers
// ============================

/**
 * Highlight a substring in a string based on a query string
 * @param text
 * @param q
 * @returns
 */
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

export function MarkdownText({ text }: { text: string }) {
  return <ReactMarkdown>{text}</ReactMarkdown>;
}
