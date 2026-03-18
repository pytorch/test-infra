import CloseIcon from "@mui/icons-material/Close";
import { Divider, Drawer, IconButton, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { UMDenseButtonLight } from "components/uiModules/UMDenseComponents";
import { useState } from "react";
import { BenchmarkLogViewContent, LogSrc } from "./BenchmarkLogViewContent";

export function BenchmarkLogSidePanelWrapper({
  urls,
  current,
  editorWidth = "60vw",
  listWidth = "20vw",
  buttonLabel = "Show logs",
  panelTitle = "Benchmark Logs",
  width = "80vw",
}: {
  urls: LogSrc[];
  current?: { fileIndex: number; line: number };
  buttonLabel?: string;
  panelTitle?: string;
  width?: any;
  editorWidth?: string | number;
  listWidth?: string | number;
}) {
  const [open, setOpen] = useState(false);
  const handleOpen = () => setOpen(true);
  const handleClose = () => setOpen(false);
  return (
    <Box>
      <UMDenseButtonLight onClick={handleOpen}>
        {buttonLabel}
      </UMDenseButtonLight>
      <Drawer
        anchor="right"
        open={open}
        onClose={handleClose}
        slotProps={{
          paper: {
            sx: {
              width: width,
              minWidth: "500px",
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
            <BenchmarkLogViewContent
              urls={urls}
              current={current}
              editorWidth={editorWidth}
              listWidth={listWidth}
            />
          </Box>
        )}
      </Drawer>
    </Box>
  );
}
