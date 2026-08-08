import { Box, Button, TextField } from "@mui/material";
import React from "react";
import { FeedbackButtons } from "./FeedbackButtons";
import { QuerySection } from "./styles";

interface QueryInputSectionProps {
  query: string;
  isLoading: boolean;
  debugVisible: boolean;
  onQueryChange: (_event: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (_event: React.FormEvent) => void;
  onToggleDebug: () => void;
  onCancel: () => void;
  currentSessionId: string | null;
}

export const QueryInputSection: React.FC<QueryInputSectionProps> = ({
  query,
  isLoading,
  debugVisible,
  onQueryChange,
  onSubmit,
  onToggleDebug,
  onCancel,
  currentSessionId,
}) => {
  return (
    <QuerySection>
      <Box component="form" onSubmit={onSubmit} noValidate>
        <TextField
          fullWidth
          label={"Enter your query"}
          value={query}
          onChange={onQueryChange}
          margin="normal"
          multiline
          minRows={3}
          maxRows={10}
          placeholder={
            "Example: Make a graph of the number of failing jobs per day  (Tip: Ctrl+Enter to submit)"
          }
          variant="outlined"
          sx={{
            "& .MuiInputBase-root": {
              "& textarea": {
                resize: "vertical",
              },
            },
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (!isLoading && query.trim()) {
                onSubmit(e);
              }
            }
          }}
        />
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            mt: 2,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center" }}>
            <Button
              variant="outlined"
              color="secondary"
              onClick={onToggleDebug}
            >
              {debugVisible ? "Hide Debug" : "Show Debug"}
            </Button>
            <FeedbackButtons
              sessionId={currentSessionId}
              visible={!!currentSessionId}
            />
          </Box>
          <Box>
            {isLoading && (
              <Button
                variant="outlined"
                color="error"
                onClick={onCancel}
                sx={{ mr: 1 }}
              >
                Cancel
              </Button>
            )}
            {
              <Button
                variant="contained"
                color="primary"
                type="submit"
                disabled={isLoading}
              >
                {isLoading ? "Running..." : "Send"}
              </Button>
            }
          </Box>
        </Box>
      </Box>
    </QuerySection>
  );
};
