import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Box, Button, Collapse, Divider, Typography } from "@mui/material";
import { useState } from "react";
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
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Box sx={{ mb: 1.5 }}>
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
        <Typography variant="h6">{title}</Typography>
      </Button>

      <Collapse in={open} timeout="auto" unmountOnExit>
        <Box sx={{ mt: 1 }}>{children}</Box>
      </Collapse>

      <Divider sx={{ mt: 1 }} />
    </Box>
  );
}
