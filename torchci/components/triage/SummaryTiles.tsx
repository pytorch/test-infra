import { Grid, Paper, Skeleton, Typography, useTheme } from "@mui/material";
import {
  formatDays,
  formatPct,
  OverviewRow,
  SLA_DAYS,
  slaLevel,
  SlaLevel,
  slaPct,
} from "lib/triage/issueTriage";

const TILE_HEIGHT = 120;

export function useSlaColor() {
  const theme = useTheme();
  return (level: SlaLevel) =>
    ({
      good: theme.palette.success.main,
      warn: theme.palette.warning.main,
      bad: theme.palette.error.main,
      none: theme.palette.text.primary,
    }[level]);
}

function Tile({
  title,
  value,
  caption,
  color,
}: {
  title: string;
  value: string;
  caption?: string;
  color?: string;
}) {
  return (
    <Paper sx={{ p: 2, height: TILE_HEIGHT }} elevation={3}>
      <Typography variant="body2" fontWeight="bold">
        {title}
      </Typography>
      <Typography fontSize="2.25rem" sx={{ color: color ?? "text.primary" }}>
        {value}
      </Typography>
      {caption !== undefined && (
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

export default function SummaryTiles({
  overview,
}: {
  overview: OverviewRow | undefined;
}) {
  const theme = useTheme();
  const slaColor = useSlaColor();

  if (overview === undefined) {
    return <Skeleton variant="rectangular" height={TILE_HEIGHT} />;
  }

  const pct = slaPct(overview.met_sla, overview.sla_eligible);
  const tiles = [
    <Tile
      key="created"
      title="Issues created"
      value={overview.issues_created.toLocaleString()}
    />,
    <Tile
      key="sla"
      title={`Fully triaged within ${SLA_DAYS} days`}
      value={formatPct(pct)}
      caption={`${overview.met_sla.toLocaleString()} of ${overview.sla_eligible.toLocaleString()} older than ${SLA_DAYS} days`}
      color={slaColor(slaLevel(pct))}
    />,
    <Tile
      key="median"
      title="Median time to full triage"
      value={`${formatDays(overview.median_days_to_triage)} d`}
      caption="Of the issues fully triaged"
    />,
    <Tile
      key="queue"
      title="In a triage queue"
      value={overview.queue_size.toLocaleString()}
      caption="Open, with no state label"
      color={overview.queue_size > 0 ? theme.palette.warning.main : undefined}
    />,
    <Tile
      key="overdue"
      title="Overdue"
      value={overview.overdue.toLocaleString()}
      caption={`In a queue for more than ${SLA_DAYS} days`}
      color={overview.overdue > 0 ? theme.palette.error.main : undefined}
    />,
    <Tile
      key="triage_review"
      title="Waiting on triage review"
      value={overview.triage_review.toLocaleString()}
      caption="Open, labelled triage review"
      color={
        overview.triage_review > 0 ? theme.palette.warning.main : undefined
      }
    />,
  ];

  return (
    <Grid container spacing={2}>
      {tiles.map((tile) => (
        <Grid key={tile.key} size={{ xs: 12, sm: 6, md: 4, lg: 2 }}>
          {tile}
        </Grid>
      ))}
    </Grid>
  );
}
