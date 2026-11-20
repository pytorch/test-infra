import {
  Box,
  Paper,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { OUTCOMES, OverviewRow } from "lib/triage/issueTriage";
import { useOutcomeColors } from "./LabelTable";

// Where the label's issues ended up: each outcome, plus those still in the
// queue, as shares of the issues created since the start date.
export default function OutcomeBreakdown({
  overview,
}: {
  overview: OverviewRow | undefined;
}) {
  const theme = useTheme();
  const colors = useOutcomeColors();

  if (overview === undefined) {
    return <Skeleton variant="rectangular" height={110} />;
  }

  // Still waiting is not an outcome but work left to do: red, striped so it
  // reads as "not decided yet".
  const queueBackground = `repeating-linear-gradient(45deg, ${theme.palette.error.main} 0 4px, ${theme.palette.error.light} 4px 8px)`;
  const segments = [
    ...OUTCOMES.map((o, i) => ({
      key: o.key,
      label: o.label,
      count: overview[o.key],
      background: colors[i],
    })),
    {
      key: "queue",
      label: "still in queue",
      // no_queue: open, untriaged, without any module:/oncall: label (0 when
      // the page is filtered to one label).
      count: overview.queue_size + overview.no_queue,
      background: queueBackground,
    },
  ];
  const total = overview.issues_created;
  const pct = (count: number) =>
    total > 0 ? `${Math.round((100 * count) / total)}%` : "–";

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Typography fontWeight="bold">Outcomes</Typography>
      <Typography variant="caption" color="text.secondary">
        Where the {total.toLocaleString()} issues created since the start date
        are now.
      </Typography>
      {total > 0 && (
        <Box
          sx={{
            display: "flex",
            height: 24,
            borderRadius: 1,
            overflow: "hidden",
            my: 1.5,
            border: 1,
            borderColor: "divider",
          }}
        >
          {segments.map((s) =>
            s.count > 0 ? (
              <Tooltip
                key={s.key}
                title={`${s.label}: ${s.count} (${pct(s.count)})`}
              >
                <Box sx={{ flexGrow: s.count, background: s.background }} />
              </Tooltip>
            ) : null
          )}
        </Box>
      )}
      <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {segments.map((s) => (
          <Box
            key={s.key}
            sx={{ display: "flex", alignItems: "center", gap: 1 }}
          >
            <Box
              sx={{
                width: 12,
                height: 12,
                borderRadius: 0.5,
                background: s.background,
                border: 1,
                borderColor: "divider",
              }}
            />
            <Typography variant="body2">
              {s.label} <b>{s.count.toLocaleString()}</b>{" "}
              <Typography
                component="span"
                variant="caption"
                color="text.secondary"
              >
                {pct(s.count)}
              </Typography>
            </Typography>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
