import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  IconButton,
  Typography,
} from "@mui/material";
import React, { useMemo, useRef } from "react";
// import { useRouter } from "next/router";

export type BenchmarkShortcutItem = {
  displayName: string;
  fieldName: string;
  value: string;
  description?: string;
  url?: string;
};

type BenchmarkShortcutCardListProps = {
  benchmarkId: string;
  // whatever your query params shape is
  data: any;
  title?: string;
  /**
   * Optional custom navigation (e.g. Next.js router.push).
   * If not provided, falls back to window.location.href.
   */
  onNavigate?: (item: BenchmarkShortcutItem) => void;
};

export const BenchmarkShortcutCardList: React.FC<
  BenchmarkShortcutCardListProps
> = ({ benchmarkId, data, title = "Shortcuts", onNavigate }) => {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // const router = useRouter();

  // ---- map API response -> cardList ----
  const cardList: BenchmarkShortcutItem[] = useMemo(() => {
    if (!data) return [];
    return data;
  }, [data]);

  // ---- scrolling helpers ----
  const handleScroll = (direction: "left" | "right") => {
    const node = scrollContainerRef.current;
    if (!node) return;
    const delta = direction === "left" ? -320 : 320;
    node.scrollBy({ left: delta, behavior: "smooth" });
  };

  // ---- navigation ----
  const handleClickCard = (item: BenchmarkShortcutItem) => {
    if (onNavigate) {
      onNavigate(item);
      return;
    }
    // Fallback: normal navigation
    if (typeof window !== "undefined" && item.url) {
      window.location.href = item.url;
    }
  };

  if (!cardList.length) {
    return null;
  }

  // ---- main UI ----
  return (
    <Box sx={{ mx: 1 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          mb: 1,
          justifyContent: "flex-start",
        }}
      >
        <Typography variant="subtitle1" fontWeight={600}>
          {title}
        </Typography>
        <Box>
          <IconButton
            size="small"
            aria-label="Scroll left"
            onClick={() => handleScroll("left")}
          >
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
          <IconButton
            size="small"
            aria-label="Scroll right"
            onClick={() => handleScroll("right")}
          >
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>

      <Box
        ref={scrollContainerRef}
        sx={{
          display: "flex",
          overflowX: "auto",
          width: "80%",
          border: "1px solid #ccc",
          borderRadius: 1,
          "::-webkit-scrollbar": { height: 6 },
          "::-webkit-scrollbar-thumb": {
            borderRadius: 3,
          },
        }}
      >
        {cardList.map((item) => (
          <Card
            key={item.fieldName}
            sx={{
              minWidth: 200,
              maxWidth: 260,
              flex: "0 0 auto",
            }}
          >
            <CardActionArea onClick={() => handleClickCard(item)}>
              <CardContent sx={{ py: 1.5 }}>
                <Typography
                  variant="subtitle2"
                  fontWeight={600}
                  gutterBottom
                  title={item.displayName}
                >
                  {item.displayName}
                </Typography>
                {item.description && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                      overflow: "hidden",
                    }}
                  >
                    {item.description}
                  </Typography>
                )}
              </CardContent>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Box>
  );
};
