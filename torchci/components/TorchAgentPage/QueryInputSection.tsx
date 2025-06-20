import { Box, Button, TextField } from "@mui/material";
import React from "react";
import { QuerySection } from "./styles";

interface QueryInputSectionProps {
  query: string;
  isLoading: boolean;
  isReadOnly?: boolean;
  onQueryChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: React.FormEvent) => void;
}

export const QueryInputSection: React.FC<QueryInputSectionProps> = ({
  query,
  isLoading,
  isReadOnly = false,
  onQueryChange,
  onSubmit,
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
          disabled={false}
          onKeyDown={(e) => {
            if (!isLoading && (e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (query.trim()) {
                onSubmit(e);
              }
            }
          }}
        />
        <Box
          sx={{
            display: "flex",
            justifyContent: "flex-end",
            mt: 2,
          }}
        >
          <Button
            variant="contained"
            color="primary"
            type="submit"
            disabled={isLoading}
          >
            {isLoading ? "Running..." : "RUN"}
          </Button>
        </Box>
      </Box>
    </QuerySection>
  );
};
