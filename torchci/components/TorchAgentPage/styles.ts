import { Box, Button, Paper, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";

export const TorchAgentPageContainer = styled("div")<{
  drawerOpen?: boolean;
  sidebarWidth?: number;
}>(({ drawerOpen = false, sidebarWidth = 300 }) => {
  // When drawer is open, we want to center the content in the remaining space
  // The sidebar takes up sidebarWidth, so we shift left by half of that to center
  const leftOffset = drawerOpen ? -sidebarWidth / 2 : 0;

  return {
    fontFamily: "Roboto",
    padding: "20px",
    width: "100%",
    maxWidth: "900px",
    marginTop: "0",
    marginBottom: "0",
    marginLeft: `calc(50% + ${leftOffset}px)`,
    marginRight: "auto",
    transform: "translateX(-50%)",
    transition: "margin-left 0.3s ease, transform 0.3s ease",
  };
});

export const QuerySection = styled(Paper)(({ theme }) => ({
  padding: "20px",
  position: "sticky",
  bottom: 0,
  zIndex: 15,
  borderTop: `1px solid ${theme.palette.divider}`,
}));

export const ResultsSection = styled(Paper)(({ theme }) => ({
  padding: "20px",
  minHeight: "300px",
  position: "relative",
  backgroundColor: theme.palette.mode === "dark" ? "#1a1a1a" : "#f5f5f5",
  scrollBehavior: "smooth",
}));

export const ChatMain = styled(Box)({
  flexGrow: 1,
  display: "flex",
  flexDirection: "column",
  height: "100vh",
});

export const ChatMessages = styled(Box)(({ theme }) => ({
  flexGrow: 1,
  overflowY: "auto",
  padding: "20px",
  backgroundColor: theme.palette.mode === "dark" ? "#1a1a1a" : "#f5f5f5",
  display: "flex",
  flexDirection: "column",
}));

export const MessageBubble = styled(Box)<{
  from: "user" | "agent";
  fullWidth?: boolean;
}>(({ theme, from, fullWidth }) => ({
  maxWidth: fullWidth ? "100%" : "80%",
  padding: "12px",
  borderRadius: 12,
  marginBottom: "10px",
  alignSelf: from === "user" ? "flex-end" : "flex-start",
  marginLeft: from === "user" ? "auto" : "0",
  marginRight: from === "user" ? "0" : "auto",
  backgroundColor:
    from === "user"
      ? "#059669" // Green color instead of red
      : theme.palette.mode === "dark"
      ? "#333"
      : "#e0e0e0",
  color: from === "user" ? "white" : theme.palette.text.primary,
}));

export const ResponseText = styled("div")(({ theme }) => ({
  wordBreak: "break-word",
  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  margin: 0,
  lineHeight: 1.5,
  color: theme.palette.mode === "dark" ? "#e0e0e0" : "inherit",
  // Reset styles for markdown content
  "& > *:first-of-type": {
    marginTop: 0,
  },
  "& > *:last-child": {
    marginBottom: 0,
  },
  // Dark mode adjustments for code blocks
  "& code": {
    backgroundColor:
      theme.palette.mode === "dark"
        ? "rgba(255, 255, 255, 0.1)"
        : "rgba(0, 0, 0, 0.1)",
    color: theme.palette.mode === "dark" ? "#e0e0e0" : "inherit",
  },
  "& pre": {
    backgroundColor:
      theme.palette.mode === "dark"
        ? "rgba(255, 255, 255, 0.05)"
        : "rgba(0, 0, 0, 0.05)",
  },
  "& blockquote": {
    borderLeftColor: theme.palette.mode === "dark" ? "#666" : "#ccc",
    color:
      theme.palette.mode === "dark"
        ? "rgba(255, 255, 255, 0.7)"
        : "rgba(0, 0, 0, 0.7)",
  },
}));

export const ToolUseBlock = styled(Paper)(({ theme }) => ({
  padding: "12px",
  marginTop: "10px",
  marginBottom: "10px",
  backgroundColor: theme.palette.mode === "dark" ? "#2d3748" : "#e6f7ff",
  borderLeft: `4px solid ${
    theme.palette.mode === "dark" ? "#63b3ed" : "#1890ff"
  }`,
  overflow: "hidden",
  transition: "max-height 0.3s ease-in-out",
}));

export const TodoListBlock = styled(Paper)(({ theme }) => ({
  padding: "8px 12px",
  marginTop: "12px",
  marginBottom: "12px",
  backgroundColor: theme.palette.mode === "dark" ? "#2d2d3a" : "#f7f9fc",
  borderLeft: `4px solid ${
    theme.palette.mode === "dark" ? "#9c27b0" : "#673ab7"
  }`,
  overflow: "hidden",
}));

export const TodoListTitle = styled(Typography)(({ theme: _theme }) => ({
  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  fontWeight: 500,
  marginBottom: "8px",
}));

export const TodoItem = styled(Box)<{ status: string }>(
  ({ theme, status }) => ({
    display: "flex",
    alignItems: "flex-start",
    marginBottom: "2px",
    padding: "2px 0",
    textDecoration: status === "completed" ? "line-through" : "none",
    color:
      status === "completed"
        ? theme.palette.mode === "dark"
          ? "#72bb72"
          : "#2e7d32"
        : status === "in_progress"
        ? theme.palette.mode === "dark"
          ? "#f0c674"
          : "#ed6c02"
        : "inherit",
    fontWeight: status === "in_progress" ? "bold" : "normal",
  })
);

export const ToolName = styled(Typography)(({ theme }) => ({
  fontWeight: "bold",
  marginBottom: "8px",
  color: theme.palette.mode === "dark" ? "#90cdf4" : "#0050b3",
}));

export const ToolInput = styled("pre")(({ theme }) => ({
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "monospace",
  margin: 0,
  fontSize: "0.9em",
  padding: "8px",
  backgroundColor: theme.palette.mode === "dark" ? "#1a202c" : "#f0f7ff",
  borderRadius: "4px",
  color: theme.palette.mode === "dark" ? "#e2e8f0" : "#333",
}));

export const ChunkMetadata = styled(Typography)(({ theme }) => ({
  fontSize: "0.75em",
  color:
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.5)"
      : "rgba(0, 0, 0, 0.5)",
  textAlign: "right",
  marginTop: "4px",
  marginBottom: "-5px",
  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
}));

export const LoaderWrapper = styled(Box)(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px 25px",
  marginTop: "20px",
  marginBottom: "20px",
  backgroundColor:
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.05)"
      : "rgba(0, 0, 0, 0.03)",
  borderRadius: "16px",
  boxShadow:
    theme.palette.mode === "dark"
      ? "0 4px 12px rgba(0, 0, 0, 0.2)"
      : "0 4px 12px rgba(0, 0, 0, 0.05)",
  border: `1px solid ${
    theme.palette.mode === "dark"
      ? "rgba(255, 255, 255, 0.1)"
      : "rgba(0, 0, 0, 0.05)"
  }`,
  transition: "all 0.3s ease-in-out",
  overflow: "visible",
}));

export const GrafanaChartContainer = styled(Box)(({ theme }) => ({
  marginTop: "15px",
  marginBottom: "15px",
  borderRadius: "4px",
  border: `1px solid ${theme.palette.divider}`,
  overflow: "hidden",
}));

export const ChartHeader = styled(Box)(({ theme }) => ({
  padding: "10px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  borderBottom: `1px solid ${theme.palette.divider}`,
  backgroundColor: theme.palette.mode === "dark" ? "#1f1f1f" : "#f5f5f5",
}));

export const ScrollToBottomButton = styled(Button)(({ theme: _theme }) => ({
  position: "fixed",
  bottom: "20px",
  right: "20px",
  width: "48px",
  height: "48px",
  minWidth: "48px",
  borderRadius: "50%",
  backgroundColor: "#059669", // Green color
  color: "white",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  cursor: "pointer",
  zIndex: 2000,
  boxShadow: "0 4px 8px rgba(0, 0, 0, 0.3)",
  transition: "all 0.2s ease-in-out",
  padding: 0,
  "&:hover": {
    backgroundColor: "#047857", // Darker green
    transform: "scale(1.1)",
    boxShadow: "0 6px 10px rgba(0, 0, 0, 0.4)",
  },
}));
