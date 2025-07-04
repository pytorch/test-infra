import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import BugReportIcon from "@mui/icons-material/BugReport";
import LightbulbIcon from "@mui/icons-material/Lightbulb";
import ShareIcon from "@mui/icons-material/Share";
import { Box, Button, Tooltip, Typography } from "@mui/material";
import React, { useState } from "react";
import { ShareModal } from "./ShareModal";
import { ScrollToBottomButton } from "./styles";

interface HeaderSectionProps {
  showScrollButton: boolean;
  onScrollToBottom: () => void;
  featureRequestUrl: string;
  bugReportUrl: string;
  currentSessionId?: string | null;
  chatTitle?: string;
  isSharedView?: boolean;
  sharedInfo?: {
    uuid: string;
    sharedAt: string;
    shareUrl: string;
  } | null;
}

export const HeaderSection: React.FC<HeaderSectionProps> = ({
  showScrollButton,
  onScrollToBottom,
  featureRequestUrl,
  bugReportUrl,
  currentSessionId,
  chatTitle,
  isSharedView = false,
  sharedInfo,
}) => {
  const [shareModalOpen, setShareModalOpen] = useState(false);

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

      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <Typography variant="h4" sx={{ flexGrow: 1 }}>
          Flambeau - PyTorch CI Agent
        </Typography>

        <Box sx={{ display: "flex" }}>
          {!isSharedView && currentSessionId && (
            <>
              {sharedInfo ? (
                <Tooltip title="Chat is shared - click to view/copy link">
                  <Button
                    variant="contained"
                    color="success"
                    onClick={() => setShareModalOpen(true)}
                    sx={{ mr: 1, minWidth: "auto", p: 1 }}
                  >
                    <ShareIcon />
                  </Button>
                </Tooltip>
              ) : (
                <Tooltip title="Share this chat">
                  <Button
                    variant="outlined"
                    onClick={() => setShareModalOpen(true)}
                    sx={{ mr: 1, minWidth: "auto", p: 1 }}
                  >
                    <ShareIcon />
                  </Button>
                </Tooltip>
              )}
            </>
          )}
          <Tooltip title="Create feature request">
            <Button
              variant="outlined"
              component="a"
              href={featureRequestUrl}
              target="_blank"
              sx={{ mr: 1, minWidth: "auto", p: 1 }}
            >
              <LightbulbIcon />
            </Button>
          </Tooltip>
          <Tooltip title="Report bug">
            <Button
              variant="outlined"
              color="error"
              component="a"
              href={bugReportUrl}
              target="_blank"
              sx={{ minWidth: "auto", p: 1 }}
            >
              <BugReportIcon />
            </Button>
          </Tooltip>
        </Box>
      </Box>
      <ShareModal
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        sessionId={currentSessionId || ""}
        chatTitle={chatTitle || ""}
        existingShareUrl={sharedInfo?.shareUrl}
      />
    </>
  );
};
