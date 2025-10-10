import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Box, Divider, IconButton, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { SideBarMainSection } from "./components/SideBarMainSection";

const SIDEBAR_WIDTH = 300; // expanded width
const RAIL_WIDTH = 44; // collapsed width
const WIDTH_MS = 300;
const FADE_MS = 200;

const styles = {
  container: (open: boolean) => (theme: any) => ({
    width: open
      ? {
          xs: "200px",
          sm: "250px",
          md: "300px",
          lg: "350px",
        }
      : RAIL_WIDTH,
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
    marginBottom: 2,
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

/**
 * Benchmark sidebar (left rail)
 * can be collapsed to a rail with a toggle button
 */
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

  const SidebarTitleAndToggle = () => (
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
  );

  return (
    <Box
      component="aside"
      sx={styles.container(open)}
      onTransitionEnd={handleTransitionEnd}
    >
      <Box sx={styles.inner}>
        {/* Top bar (always visible) */}
        <SidebarTitleAndToggle />
        {/* Content: visible immediately on first open; deferred on toggled open; faded on close */}
        {contentMounted ? (
          <Box sx={styles.content(contentVisible)}>
            <SideBarMainSection />
            <Divider />
          </Box>
        ) : (
          <Box sx={styles.collapsedPlaceholder} />
        )}
      </Box>
    </Box>
  );
}
