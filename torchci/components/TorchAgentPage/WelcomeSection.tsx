import { Box, Button, TextField, Typography } from "@mui/material";
import React from "react";
import { QuerySection } from "./styles";
import { TipsInfoButton } from "./TipsInfoButton";

interface WelcomeSectionProps {
  query: string;
  isLoading: boolean;
  debugVisible: boolean;
  onQueryChange: (_event: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (_event: React.FormEvent) => void;
  onToggleDebug: () => void;
  onCancel: () => void;
}

export const WelcomeSection: React.FC<WelcomeSectionProps> = ({
  query,
  isLoading,
  debugVisible,
  onQueryChange,
  onSubmit,
  onToggleDebug,
  onCancel,
}) => {
  return (
    <>
      <Box
        sx={{
          mb: 3,
          p: 2,
          backgroundColor: "background.paper",
          borderRadius: 1,
          border: "1px solid",
          borderColor: "divider",
        }}
      >
        <Typography variant="body1">
          Hi, I&apos;m Flambeau, your intelligent assistant for PyTorch
          infrastructure analysis and monitoring. I can help you create custom
          time-series visualizations, analyze CI/CD metrics, and gain insights
          into the PyTorch development workflow. Simply describe what you&apos;d
          like to explore, and I will generate the appropriate queries and
          dashboards for you. Data I have access to:
        </Typography>
        <ul>
          <li>
            PyTorch GitHub repository data (comments, issues, PRs, including
            text inside of these)
          </li>
          <li>
            PyTorch GitHub Actions CI data (build/test/workflow results, error
            log classifications, duration, runner types)
          </li>
          <li>
            CI cost / duration data: how long does the average job/workflow run)
          </li>
          <li>Benchmarking data in the benchmarking database</li>
        </ul>
      </Box>

      <Typography variant="body1" paragraph>
        What can I help you graph today?
        <TipsInfoButton />
      </Typography>

      <QuerySection>
        <Box component="form" onSubmit={onSubmit} noValidate>
          <TextField
            fullWidth
            label="Enter your query"
            value={query}
            onChange={onQueryChange}
            margin="normal"
            multiline
            minRows={3}
            maxRows={10}
            placeholder="Example: Make a graph of the number of failing jobs per day  (Tip: Ctrl+Enter to submit)"
            variant="outlined"
            disabled={isLoading}
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
            <Button
              variant="outlined"
              color="secondary"
              onClick={onToggleDebug}
            >
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
        </Box>
      </QuerySection>
    </>
  );
};
