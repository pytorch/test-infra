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
            {"Every trunk job run passes or fails. Each failure is one of:"}
          </Typography>

          <Box component="ul" sx={{ m: 0, pl: 3 }}>
            <Typography component="li" variant="body2" color="text.secondary">
              <Term>Infra flake</Term>
              {" — the machine/runner broke intermittently (a retry passed, or " +
                "it was green right before and after). Not the code."}
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              <Term>Job flake</Term>
              {" — the test itself is intermittently unreliable (CI quality). " +
                "Not a real bug."}
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              <Term>Real regression</Term>
              {" — a persistent break: the job stayed red across consecutive " +
                "commits and the failure is a test/code failure. A genuine code break."}
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              <Term>Sustained infra outage</Term>
              {" — a persistent break caused by infra (not code) — e.g. a " +
                "fleet/config outage lasting many commits."}
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              <Term>Unclassified</Term>
              {
                " — an isolated one-off red we can't yet attribute (~a few % of reds)."
              }
            </Typography>
          </Box>

          <Typography variant="body2" color="text.secondary">
            {"The GRAPH shows flakiness only (Infra flake / Job flake / " +
              "Unclassified). Real regressions and sustained infra outages are " +
              "shown as the tiles above it, not on the graph — so in " +
              '"% of reds" mode the bars don\'t fill 100%; in aggregate, the ' +
              "remainder is those tiles."}
          </Typography>

          <Typography variant="body2" color="text.secondary">
            <Term>Flakiness rate</Term>
            {" = flakes ÷ (passes + flakes) — when the code was fine, how often " +
              "this flaked (jobs table). "}
            <Term>% of jobs that are flaky</Term>
            {' (graph "% of all jobs") = flakes ÷ all runs. '}
            <Term>% of reds that are flaky</Term>
            {" = flakes ÷ all failures. "}
            <Term>Wilson LB</Term>
            {" = a confidence-adjusted flakiness rate that discounts small " +
              "samples; the tables sort by it. "}
            <Term>works elsewhere</Term>
            {" (labels) = of this label's infra-flakes, how often the same job " +
              "passed on a different label — high = likely this pool's fault."}
          </Typography>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
