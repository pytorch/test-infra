import { Box, CircularProgress, Typography } from "@mui/material";
import React from "react";

interface LoadingDisplayProps {
  message: string;
  size?: number;
  showFullScreen?: boolean;
}

export const LoadingDisplay: React.FC<LoadingDisplayProps> = ({
  message,
  size = 60,
  showFullScreen = false,
}) => {
  const containerSx = showFullScreen
    ? {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
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
