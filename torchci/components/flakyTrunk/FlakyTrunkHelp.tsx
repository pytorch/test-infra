import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Stack,
  Typography,
} from "@mui/material";
import { ReactNode } from "react";

// Bold, high-contrast lead-in term. Colors come from the theme palette so the
// panel stays readable in both dark and light mode.
function Term({ children }: { children: ReactNode }) {
  return (
    <Box component="span" fontWeight="bold" color="text.primary">
      {children}
    </Box>
  );
}

export default function FlakyTrunkHelp() {
  return (
    <Accordion disableGutters sx={{ mb: 2 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography fontWeight="bold">How to read this</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1.5}>
          <Typography variant="subtitle2" color="text.primary">
            {"How to read this page — trunk/main only"}
          </Typography>

          <Typography variant="body2" color="text.secondary">
            {
              "Every trunk job run passes or fails. Each failure is sorted into: "
            }
            <Term>infra flake</Term>
            {" (the machine/runner broke — not the code), "}
            <Term>job flake</Term>
            {" (the test itself is unreliable — CI quality, not a real bug), "}
            <Term>unclassified</Term>
            {" (a failure we couldn't confidently attribute), or "}
            <Term>real regression</Term>
            {
              " (an actual code bug — excluded from every flakiness number here)."
            }
          </Typography>

          <Typography variant="body2" color="text.secondary">
            <Term>Flakiness rate</Term>
            {' = flakes ÷ (passes + flakes). "When the code was fine, how often ' +
              'did this flake?" It leaves real bugs and unclassified failures out ' +
              "of the denominator, so it measures how unreliable the signal itself is."}
          </Typography>

          <Typography variant="body2" color="text.secondary">
            <Term>% of jobs that are flaky</Term>
            {' (the graph\'s "% of all jobs" mode) = flakes ÷ all runs. Same top ' +
              "number, divided by everything that ran — total flaky volume/impact, " +
              "not intrinsic unreliability. A rarely-run job can have a high " +
              "flakiness rate but a tiny % of all jobs."}
          </Typography>

          <Typography variant="body2" color="text.secondary">
            <Term>% of reds that are flaky</Term>
            {" = flakes ÷ all failures. \"When it's red, how often is that a false " +
              'alarm vs a real problem?"'}
          </Typography>

          <Typography variant="body2" color="text.secondary">
            <Term>Wilson LB</Term>
            {" (Wilson lower bound) = a confidence-adjusted flakiness rate. A job " +
              "that flaked 1 of 2 runs looks 50% flaky, but 2 runs prove nothing — " +
              "Wilson LB discounts small samples, so a steady 4% over 10,000 runs " +
              "ranks above a noisy 50% over 2. The tables sort by this."}
          </Typography>

          <Typography variant="body2" color="text.secondary">
            <Term>works elsewhere</Term>
            {" (instance-labels table only) = of this label's infra-flakes, how " +
              "often the same job passed on a different label. High → likely this " +
              "runner pool's fault, not the job's."}
          </Typography>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
