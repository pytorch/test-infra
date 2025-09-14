import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Box, Divider, IconButton, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { CommitWorflowSelectSection } from "./components/CommitWorkfowSelectSection";
import { SideBarMainSection } from "./components/SideBarMainSection";

const SIDEBAR_WIDTH = 300; // expanded width
const RAIL_WIDTH = 44; // collapsed rail width
const WIDTH_MS = 180; // match your theme if you like
const FADE_MS = 140;

const styles = {
  container: (open: boolean) => (theme: any) => ({
    width: open ? SIDEBAR_WIDTH : RAIL_WIDTH,
    transition: theme.transitions.create("width", {
      duration: WIDTH_MS,
    }),
    flexShrink: 0,
  }),

  inner: {
    position: "sticky",
    top: 0,
    height: "100dvh",
    borderRight: 1,
    borderColor: "divider",
    bgcolor: "background.paper",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    p: 1, // keep padding constant to avoid layout shift
  },

  headerRow: {
    display: "flex",
    alignItems: "center",
    marginBottom: 8,
  },

  title: { whiteSpace: "nowrap" },
  toggleBox: { marginLeft: "auto" },
  content: (visible: boolean) => ({
    opacity: visible ? 1 : 0,
    transform: visible ? "translateX(0)" : "translateX(-6px)",
    transition: `opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease`,
    pointerEvents: visible ? "auto" : "none",
  }),

  collapsedPlaceholder: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
};

export default function BenchmarkSideBar() {
  const [open, setOpen] = useState(true);

  // initial = open → first paint shows content when open
  const [contentMounted, setContentMounted] = useState(open);
  const [contentVisible, setContentVisible] = useState(open);

  const prevOpenRef = useRef(open);
  const toggle = () => setOpen((o) => !o);

  useEffect(() => {
    // Only run this logic when open actually changes (not on first render)
    if (prevOpenRef.current === open) return;

    if (open) {
      // Opening: mount first, keep hidden; will show after width transition ends
      setContentMounted(true);
      setContentVisible(false);
    } else {
      // Closing: hide immediately (no flash), keep mounted until width transition ends
      setContentVisible(false);
    }

    prevOpenRef.current = open;
  }, [open]);

  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName !== "width") return;

    if (open) {
      // Finished expanding → reveal
      setContentVisible(true);
    } else {
      // Finished collapsing → unmount
      setContentMounted(false);
    }
  };

  return (
    <Box
      component="aside"
      sx={styles.container(open)}
      onTransitionEnd={handleTransitionEnd}
    >
      <Box sx={styles.inner}>
        {/* Top bar (always visible) */}
        <Box sx={styles.headerRow}>
          {open && (
            <Typography variant="h6" sx={styles.title}>
              Search
            </Typography>
          )}
          <Box sx={styles.toggleBox}>
            <IconButton
              size="small"
              onClick={toggle}
              aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            >
              {open ? <ChevronLeftIcon /> : <ChevronRightIcon />}
            </IconButton>
          </Box>
        </Box>

        {/* Content: visible immediately on first open; deferred on toggled open; faded on close */}
        {contentMounted ? (
          <Box sx={styles.content(contentVisible)}>
            <SideBarMainSection />
            <Divider />
            <CommitWorflowSelectSection />
          </Box>
        ) : (
          <Box sx={styles.collapsedPlaceholder} />
        )}
      </Box>
    </Box>
  );
}
