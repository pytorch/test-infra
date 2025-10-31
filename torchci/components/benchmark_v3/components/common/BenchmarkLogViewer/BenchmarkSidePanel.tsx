import CloseIcon from "@mui/icons-material/Close";
import { Button, Divider, Drawer, IconButton, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { useState } from "react";
import { BenchmarkLogViewer, LogSrc } from "./BenchmarkLogViewer";

export function BenchmarkLogSidePanelWrapper({
  urls,
  current,
  height = "50vh",
  buttonLabel = "Show logs",
  panelTitle = "Benchmark Logs",
  widthPx = "80vw",
}: {
  urls: LogSrc[];
  current?: { fileIndex: number; line: number };
  height?: string | number;
  buttonLabel?: string;
  panelTitle?: string;
  widthPx?: any;
}) {
  const [open, setOpen] = useState(false);
  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);

  return (
    <Box>
      <Button variant="outlined" size="small" onClick={handleOpen}>
        {buttonLabel}
      </Button>
      <Drawer
        anchor="right"
        open={open}
        onClose={handleClose}
        slotProps={{
          paper: {
            sx: {
              width: widthPx,
              maxWidth: "90vw",
            },
          },
        }}
      >
        {/* Header */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            py: 1,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography variant="subtitle1">{panelTitle}</Typography>
          <IconButton size="small" onClick={handleClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
        <Divider />
        {/* Lazy-render the log viewer only when open */}
        {open && (
          <Box sx={{ flex: 1, overflow: "hidden", mx: 1 }}>
            <BenchmarkLogViewer urls={urls} current={current} height={height} />
          </Box>
        )}
      </Drawer>
    </Box>
  );
}
