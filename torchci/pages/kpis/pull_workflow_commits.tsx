import { Grid, Link as MuiLink, Typography } from "@mui/material";
import PullWorkflowCommitScatterPanel from "components/metrics/panels/PullWorkflowCommitScatterPanel";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import NextLink from "next/link";
import { useRouter } from "next/router";
dayjs.extend(utc);

const FMT = "YYYY-MM-DDTHH:mm:ss.SSS";

export default function PullWorkflowCommitsPage() {
  const router = useRouter();
  const startTime = dayjs().subtract(6, "month").utc().format(FMT);
  const stopTime = dayjs().utc().format(FMT);

  // Optional pre-zoom: ?focus=<ISO ts> -> window of focus +/- 5 days.
  const focus =
    typeof router.query.focus === "string" ? router.query.focus : undefined;
  const focusStart = focus
    ? dayjs(focus).subtract(5, "day").format(FMT)
    : undefined;
  const focusStop = focus ? dayjs(focus).add(5, "day").format(FMT) : undefined;

  return (
    <Grid container spacing={2} sx={{ p: 2 }}>
      <Grid size={{ xs: 12 }}>
        <Typography variant="h5">
          pull workflow duration — per trunk commit
        </Typography>
        <NextLink href="/kpis" passHref legacyBehavior>
          <MuiLink>← back to KPIs</MuiLink>
        </NextLink>
      </Grid>
      <Grid size={{ xs: 12 }} height={680}>
        <PullWorkflowCommitScatterPanel
          startTime={startTime}
          stopTime={stopTime}
          focusStart={focusStart}
          focusStop={focusStop}
        />
      </Grid>
    </Grid>
  );
}
