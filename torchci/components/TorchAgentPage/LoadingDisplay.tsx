import { Box, CircularProgress, Typography } from "@mui/material";
import React from "react";

interface LoadingDisplayProps {
  message: string;
  size?: number;
  showFullScreen?: boolean;
  drawerOpen?: boolean;
  sidebarWidth?: number;
}

export const LoadingDisplay: React.FC<LoadingDisplayProps> = ({
  message,
  size = 60,
  showFullScreen = false,
  drawerOpen = false,
  sidebarWidth = 300,
}) => {
  const containerSx = showFullScreen
    ? {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        width: "100%",
        maxWidth: "900px",
        marginLeft: drawerOpen
          ? `calc(50% + ${-sidebarWidth / 2}px)`
          : "calc(50%)",
        marginRight: "auto",
        transform: "translateX(-50%)",
        transition: "margin-left 0.3s ease, transform 0.3s ease",
      }
    : {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "300px",
      };

  return (
    <Box sx={containerSx}>
      <CircularProgress size={size} />
      <Typography variant="h6" sx={{ mt: 3 }}>
        {message}
      </Typography>
    </Box>
  );
};
