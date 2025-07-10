import ThumbDownIcon from "@mui/icons-material/ThumbDown";
import ThumbUpIcon from "@mui/icons-material/ThumbUp";
import { Box, IconButton, Tooltip } from "@mui/material";
import { useState } from "react";

interface FeedbackButtonsProps {
  sessionId: string | null;
  visible: boolean;
}

export const FeedbackButtons = ({
  sessionId,
  visible,
}: FeedbackButtonsProps) => {
  const [feedbackSubmitted, setFeedbackSubmitted] = useState<number | null>(
    null
  );
  const [feedbackSelected, setFeedbackSelected] = useState<number | null>(null);

  const sendFeedback = async (value: number) => {
    if (!sessionId) return;
    try {
      await fetch("/api/torchagent-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId, feedback: value }),
      });
      setFeedbackSelected(value);
      setFeedbackSubmitted(value);
      // Hide confirmation message after 5 seconds, but keep button selected
      setTimeout(() => {
        setFeedbackSubmitted(null);
      }, 5000);
    } catch (e) {
      console.error("Failed to send feedback", e);
    }
  };

  if (!visible) return null;

  return (
    <Box sx={{ ml: 2, position: "relative" }}>
      <Tooltip title="This session was helpful and gave me what I asked for">
        <IconButton
          color="primary"
          size="small"
          onClick={() => sendFeedback(1)}
          sx={{
            backgroundColor:
              feedbackSelected === 1 ? "primary.main" : "transparent",
            color:
              feedbackSelected === 1 ? "primary.contrastText" : "primary.main",
            "&:hover": {
              backgroundColor:
                feedbackSelected === 1 ? "primary.dark" : "primary.light",
            },
          }}
        >
          <ThumbUpIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="This output is not what I asked">
        <IconButton
          color="primary"
          size="small"
          onClick={() => sendFeedback(-1)}
          sx={{
            backgroundColor:
              feedbackSelected === -1 ? "primary.main" : "transparent",
            color:
              feedbackSelected === -1 ? "primary.contrastText" : "primary.main",
            "&:hover": {
              backgroundColor:
                feedbackSelected === -1 ? "primary.dark" : "primary.light",
            },
          }}
        >
          <ThumbDownIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {feedbackSubmitted !== null && (
        <Box
          sx={{
            position: "absolute",
            top: -40,
            left: "50%",
            transform: "translateX(-50%)",
            backgroundColor: "success.main",
            color: "success.contrastText",
            px: 2,
            py: 1,
            borderRadius: 1,
            fontSize: "0.875rem",
            fontWeight: "medium",
            boxShadow: 2,
            zIndex: 1000,
            whiteSpace: "nowrap",
            "&::after": {
              content: '""',
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              width: 0,
              height: 0,
              borderLeft: "6px solid transparent",
              borderRight: "6px solid transparent",
              borderTop: "6px solid",
              borderTopColor: "success.main",
            },
          }}
        >
          Feedback recorded, thank you!
        </Box>
      )}
    </Box>
  );
};
