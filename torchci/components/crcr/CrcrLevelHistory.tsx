import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Chip,
  Collapse,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { useLevelHistory } from "lib/crcr/levelHistory";
import { useState } from "react";

function formatChangedAt(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function CrcrLevelHistory({
  repoFullName,
}: {
  repoFullName: string;
}) {
  const { events, loaded } = useLevelHistory(repoFullName);
  const [expanded, setExpanded] = useState(false);

  if (!loaded) {
    return <Skeleton variant="rectangular" height={80} />;
  }

  return (
    <Paper elevation={1} sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
          sx={{ cursor: "pointer" }}
          onClick={() => setExpanded((value) => !value)}
        >
          <Stack spacing={0.5}>
            <Typography variant="h6">Level History</Typography>
            <Chip
              label={expanded ? "Hide details" : "Details"}
              size="small"
              color="primary"
              variant={expanded ? "filled" : "outlined"}
              clickable
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              deleteIcon={
                <ExpandMoreIcon
                  sx={{
                    transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s",
                  }}
                />
              }
              onDelete={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              sx={{ width: "fit-content" }}
            />
          </Stack>
          <Chip
            label={`${events.length} observed change${
              events.length === 1 ? "" : "s"
            }`}
            size="small"
            variant="outlined"
          />
        </Box>

        <Collapse in={expanded} timeout="auto" unmountOnExit>
          <Stack spacing={1.5}>
            <Typography variant="caption" color="text.secondary">
              Observed from CRCR dispatch records retained by the HUD. Manual PR
              links and automated-decision criteria will be added with the
              dedicated audit ledger.
            </Typography>

            {events.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No level changes were observed in the retained dispatch history.
              </Typography>
            ) : (
              <Stack spacing={0}>
                {events.map((event, index) => (
                  <Box
                    key={`${event.changed_at}-${event.new_level}`}
                    display="grid"
                    gridTemplateColumns="20px minmax(0, 1fr)"
                    columnGap={1}
                    sx={{ pb: index === events.length - 1 ? 0 : 1.5 }}
                  >
                    <Box
                      sx={{
                        borderLeft: index === events.length - 1 ? 0 : 1,
                        borderColor: "divider",
                        display: "flex",
                        justifyContent: "center",
                      }}
                    >
                      <Box
                        sx={{
                          width: 10,
                          height: 10,
                          mt: 0.5,
                          borderRadius: "50%",
                          bgcolor: "primary.main",
                        }}
                      />
                    </Box>
                    <Stack spacing={0.25}>
                      <Typography variant="caption" color="text.secondary">
                        {formatChangedAt(event.changed_at)}
                      </Typography>
                      <Typography variant="body2" fontWeight={600}>
                        {event.previous_level} → {event.new_level}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Observed in CRCR dispatch records
                      </Typography>
                    </Stack>
                  </Box>
                ))}
              </Stack>
            )}
          </Stack>
        </Collapse>
      </Stack>
    </Paper>
  );
}
