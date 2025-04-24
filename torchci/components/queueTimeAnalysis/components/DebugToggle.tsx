import { FormControlLabel, Paper, Switch, Typography } from "@mui/material";
import { Box } from "@mui/system";
import { useState } from "react";

export default function DebugToggle(info: any) {
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
        <Paper elevation={2} sx={{ mt: 2, p: 2 }}>
          <Typography variant="subtitle1">Debug Details:</Typography>
          <div>
            <pre
              style={{
                fontSize: "0.85rem",
                overflow: "auto",
                maxHeight: "300px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {JSON.stringify(info, null, 2)}
            </pre>
          </div>
        </Paper>
      )}
    </Box>
  );
}
