import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import MenuIcon from "@mui/icons-material/Menu";
import { Box, Button, Tooltip, Typography, IconButton } from "@mui/material";
import React from "react";
import { ScrollToBottomButton } from "./styles";

interface HeaderSectionProps {
  showScrollButton: boolean;
  onScrollToBottom: () => void;
  featureRequestUrl: string;
  bugReportUrl: string;
  onToggleDrawer: () => void;
  isMobile: boolean;
}

export const HeaderSection: React.FC<HeaderSectionProps> = ({
  showScrollButton,
  onScrollToBottom,
  featureRequestUrl,
  bugReportUrl,
  onToggleDrawer,
  isMobile,
}) => {
  return (
    <>
      {showScrollButton && (
        <Tooltip title="Go to bottom and resume auto-scroll">
          <ScrollToBottomButton
            variant="contained"
            color="primary"
            onClick={onScrollToBottom}
            aria-label="Scroll to bottom and resume auto-scroll"
          >
            <ArrowDownwardIcon />
          </ScrollToBottomButton>
        </Tooltip>
      )}

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center" }}>
          {isMobile && (
            <IconButton
              onClick={onToggleDrawer}
              edge="start"
              sx={{ mr: 1 }}
              aria-label="open drawer"
            >
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h4" gutterBottom>
            TorchAgent
          </Typography>
        </Box>

        <Box>
          <Button
            variant="outlined"
            component="a"
            href={featureRequestUrl}
            target="_blank"
            sx={{ mr: 1 }}
          >
            Feature Request
          </Button>
          <Button
            variant="outlined"
            color="error"
            component="a"
            href={bugReportUrl}
            target="_blank"
          >
            Report Bug
          </Button>
        </Box>
      </Box>
    </>
  );
};
