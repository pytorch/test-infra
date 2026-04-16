import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import {
  Box,
  Button,
  Collapse,
  IconButton,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import React from "react";
import ToolIcon from "../ToolIcon";
import { ChunkMetadata, ToolInput, ToolName, ToolUseBlock } from "./styles";
import {
  CLICKHOUSE_CONSOLE_BASE_URL,
  formatTokenCount,
  generateQueryId,
} from "./utils";

interface ToolUseProps {
  toolName: string;
  toolInput: any;
  toolResult?: string;
  outputTokens?: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
}

export const ToolUse: React.FC<ToolUseProps> = ({
  toolName,
  toolInput,
  toolResult,
  outputTokens,
  isExpanded,
  onToggleExpand,
}) => {
  const theme = useTheme();

  return (
    <ToolUseBlock>
      <Box display="flex" justifyContent="space-between" alignItems="center">
        <Box display="flex" alignItems="center">
          <ToolIcon toolName={toolName} />
          <ToolName variant="subtitle2">Tool: {toolName}</ToolName>
        </Box>
        <IconButton onClick={onToggleExpand} size="small">
          {isExpanded ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
        </IconButton>
      </Box>

      <Collapse in={isExpanded} timeout="auto">
        <Typography
          variant="caption"
          sx={{
            display: "block",
            mt: 1,
            mb: 0.5,
            color: "text.secondary",
          }}
        >
          Input:
        </Typography>
        <ToolInput>{JSON.stringify(toolInput, null, 2)}</ToolInput>

        {toolResult && (
          <>
            <Typography
              variant="caption"
              sx={{
                display: "block",
                mt: 2,
                mb: 0.5,
                color: "text.secondary",
              }}
            >
              Result:
            </Typography>
            <ToolInput
              sx={{
                backgroundColor:
                  theme.palette.mode === "dark" ? "#252e3d" : "#f0f7ff",
                borderLeft: `4px solid ${
                  theme.palette.mode === "dark" ? "#4caf50" : "#2e7d32"
                }`,
              }}
            >
              {(() => {
                try {
                  const parsed = JSON.parse(toolResult);
                  return JSON.stringify(parsed, null, 2);
                } catch (e) {
                  return toolResult;
                }
              })()}
            </ToolInput>
          </>
        )}

        {toolName?.toLowerCase().includes("clickhouse") && toolInput?.query && (
          <Box sx={{ mt: 2, textAlign: "right" }}>
            <Tooltip
              title="This will copy the query and open a new page in ClickHouse. Paste the query to run it there"
              arrow
            >
              <Button
                variant="outlined"
                size="small"
                startIcon={<ContentCopyIcon />}
                onClick={() => {
                  const query =
                    typeof toolInput.query === "string"
                      ? toolInput.query
                      : JSON.stringify(toolInput.query);

                  navigator.clipboard.writeText(query);
                  window.open(
                    CLICKHOUSE_CONSOLE_BASE_URL + generateQueryId(),
                    "_blank"
                  );
                }}
              >
                Copy query and go to ClickHouse
              </Button>
            </Tooltip>
          </Box>
        )}
      </Collapse>

      <ChunkMetadata>
        {outputTokens ? `${formatTokenCount(outputTokens)} tokens` : ""}
      </ChunkMetadata>
    </ToolUseBlock>
  );
};
