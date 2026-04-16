import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Box, Button, Collapse, Divider, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
const styles = {
  root: {
    textTransform: "none",
    display: "flex",
    justifyContent: "flex-start",
    alignItems: "center",
    gap: 0.5,
  },
};
export function ToggleSection({
  id,
  title,
  children,
  defaultOpen = true,
}: {
  id: string;
  title?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { id: wantId } = (e as CustomEvent<{ id: string }>).detail || {};
      if (wantId === id && !openRef.current) setOpen(true);
    };
    window.addEventListener("toggle:open", onOpen as EventListener);
    return () =>
      window.removeEventListener("toggle:open", onOpen as EventListener);
  }, [id]);

  return (
    <Box sx={{ mb: 1.5 }} id={id}>
      <Button
        fullWidth
        variant="text"
        size="small"
        onClick={() => setOpen(!open)}
        sx={styles.root}
        endIcon={
          <ExpandMoreIcon
            sx={{
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform 0.2s",
            }}
          />
        }
      >
        {title && <Typography variant="h6">{title}</Typography>}
      </Button>
      <Collapse in={open} timeout="auto">
        <Box sx={{ mt: 1 }}>{children}</Box>
      </Collapse>
      <Divider sx={{ mt: 1 }} />
    </Box>
  );
}
// A method to able to open the toggle section from the dom managment
export function openToggleSectionById(sectionId: string) {
  window.dispatchEvent(
    new CustomEvent("toggle:open", { detail: { id: sectionId } })
  );
  // Optionally update hash for deep-linking
  history.replaceState(null, "", `#${encodeURIComponent(sectionId)}`);
}

export function toToggleSectionId(name: string | number) {
  return `toggle-section-${name}`;
}
