import { Box, Button, TextField } from "@mui/material";
import React from "react";
import { QuerySection } from "./styles";

interface QueryInputSectionProps {
  query: string;
  isLoading: boolean;
  debugVisible: boolean;
  isReadOnly?: boolean;
  onQueryChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: React.FormEvent) => void;
  onToggleDebug: () => void;
  onCancel: () => void;
}

export const QueryInputSection: React.FC<QueryInputSectionProps> = ({
  query,
  isLoading,
  debugVisible,
  isReadOnly = false,
  onQueryChange,
  onSubmit,
  onToggleDebug,
  onCancel,
}) => {
  return (
    <QuerySection>
      <Box component="form" onSubmit={onSubmit} noValidate>
        <TextField
          fullWidth
          label={isReadOnly ? "Query" : "Enter your query"}
          value={query}
          onChange={onQueryChange}
          margin="normal"
          multiline
          rows={3}
          placeholder={
            isReadOnly
              ? ""
              : "Example: Make a graph of the number of failing jobs per day  (Tip: Ctrl+Enter to submit)"
          }
          variant="outlined"
          disabled={isReadOnly}
          InputProps={{
            readOnly: isReadOnly,
          }}
          onKeyDown={(e) => {
            if (!isReadOnly && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
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
          <Button variant="outlined" color="secondary" onClick={onToggleDebug}>
            {debugVisible ? "Hide Debug" : "Show Debug"}
          </Button>
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
            {!isReadOnly && (
              <Button
                variant="contained"
                color="primary"
                type="submit"
                disabled={isLoading}
              >
                {isLoading ? "Running..." : "RUN"}
              </Button>
            )}
          </Box>
        </Box>
      </Box>
    </QuerySection>
  );
};
