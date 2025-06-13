import { Box, Button, Paper, Typography } from "@mui/material";
import { styled } from "@mui/material/styles";

export const McpQueryPageContainer = styled("div")({
  fontFamily: "Roboto",
  padding: "20px",
  maxWidth: "1200px",
  margin: "0 auto",
});

export const QuerySection = styled(Paper)({
  padding: "20px",
  marginBottom: "20px",
});

export const ResultsSection = styled(Paper)(({ theme }) => ({
  padding: "20px",
  minHeight: "300px",
  position: "relative",
  backgroundColor: theme.palette.mode === "dark" ? "#1a1a1a" : "#f5f5f5",
  scrollBehavior: "smooth",
}));

export const ResponseText = styled("div")(({ theme }) => ({
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "Roboto, 'Helvetica Neue', Arial, sans-serif",
  margin: 0,
  lineHeight: 1.5,
  paddingTop: "1em",
  color: theme.palette.mode === "dark" ? "#e0e0e0" : "inherit",
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

export const TodoListTitle = styled(Typography)(({ theme }) => ({
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
  marginBottom: "16px",
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

export const ScrollToBottomButton = styled(Button)(({ theme }) => ({
  position: "fixed",
  bottom: "20px",
  right: "20px",
  width: "48px",
  height: "48px",
  minWidth: "48px",
  borderRadius: "50%",
  backgroundColor: theme.palette.primary.main,
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
    backgroundColor: theme.palette.primary.dark,
    transform: "scale(1.1)",
    boxShadow: "0 6px 10px rgba(0, 0, 0, 0.4)",
  },
}));
