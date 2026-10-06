import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import { LocalTimeHuman } from "components/common/TimeUtils";
import { useLevelHistory } from "lib/crcr/levelHistory";
import { useState } from "react";

export default function CrcrLevelHistory({
  repoFullName,
}: {
  repoFullName: string;
}) {
  const { events, error, loaded } = useLevelHistory(repoFullName);
  const [expanded, setExpanded] = useState(false);

  if (!loaded) {
    return <Skeleton variant="rectangular" height={80} />;
  }

  if (error) {
    return (
      <Paper elevation={1} sx={{ p: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="h6">Level History</Typography>
          <Typography variant="body2" color="error">
            Level history is temporarily unavailable. Please try again later.
          </Typography>
        </Stack>
      </Paper>
    );
  }

  return (
    <Accordion
      disableGutters
      elevation={1}
      expanded={expanded}
      onChange={(_event, isExpanded) => setExpanded(isExpanded)}
      sx={{ "&:before": { display: "none" } }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 2 }}>
        <Box
          display="flex"
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
          width="100%"
        >
          <Typography variant="h6">Level History</Typography>
          <Chip
            label={`${events.length} observed level event${
              events.length === 1 ? "" : "s"
            }`}
            size="small"
            variant="outlined"
          />
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, pb: 2 }}>
        <Stack spacing={1.5}>
            <Typography variant="caption" color="text.secondary">
              Observed from CRCR dispatch records retained by the HUD. Manual PR
              links and automated-decision criteria will be added with the
              dedicated audit ledger.
            </Typography>

            {events.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No level events were observed in the retained dispatch history.
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
                        <LocalTimeHuman timestamp={event.changed_at} />
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
      </AccordionDetails>
    </Accordion>
  );
}
