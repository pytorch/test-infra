import * as React from "react";
import { Box, IconButton, Typography, Tooltip } from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import type { SxProps, Theme } from "@mui/material/styles";


export function HoverOnMoreVertButton({
  onClick = () => {},
}: {
  onClick?: () => void;
}) {
  return (
    <Box>
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation(); // safe if inside clickable rows
          onClick();
        }}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}
