import styled from "@emotion/styled";
import { FormControlLabel, Paper, Switch, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { useState } from "react";
const DebugDetailBox = styled("pre")({
  fontSize: "0.85rem",
  overflow: "auto",
  maxHeight: "300px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
});

export default function DebugToggle({ info, sx }: { info: any; sx?: any }) {
  const [showDebug, setShowDebug] = useState(false);

  return (
    <Box p={2}>
      <FormControlLabel
        control={
          <Switch
            checked={showDebug}
            onChange={(e) => setShowDebug(e.target.checked)}
            color="primary"
          />
        }
        label="Show Search Debug"
      />
      {showDebug && (
        <Paper
          elevation={2}
          sx={{
            ...sx,
          }}
        >
          <Typography variant="subtitle1">Debug Details:</Typography>
          <div>
            <DebugDetailBox>{JSON.stringify(info, null, 2)}</DebugDetailBox>
          </div>
        </Paper>
      )}
    </Box>
  );
}
