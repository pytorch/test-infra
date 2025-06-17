import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import { Box, Button, Tooltip, Typography } from "@mui/material";
import React from "react";
import { ScrollToBottomButton } from "./styles";

interface HeaderSectionProps {
  showScrollButton: boolean;
  onScrollToBottom: () => void;
  featureRequestUrl: string;
  bugReportUrl: string;
}

export const HeaderSection: React.FC<HeaderSectionProps> = ({
  showScrollButton,
  onScrollToBottom,
  featureRequestUrl,
  bugReportUrl,
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

      <Typography variant="h4" gutterBottom>
        TorchAgent
      </Typography>

      <Box sx={{ display: "flex", justifyContent: "flex-end", mb: 2 }}>
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
    </>
  );
};
