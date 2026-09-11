import { Paper, Skeleton, Stack, Typography } from "@mui/material";
import { NO_DATA_IN_WINDOW } from "lib/greenlight/qualityFigures";
import { ReactNode } from "react";
import InfoTooltip from "./InfoTooltip";

const TILE_MIN_HEIGHT = 128;
const VALUE_SKELETON_HEIGHT = 56;
const VALUE_FONT_SIZE = "1.75rem";

// One span for every tile on the page, which all sit in a single Grid container
// so they reflow as one run and pack as many per row as the width allows,
// instead of each panel holding a row of its own.
export const TILE_SPAN = { xs: 12, sm: 6, md: 4, lg: 3 };

// Every figure on this page needs a caveat, which ScalarPanelWithValue has no
// slot for, so the tile lives here once instead of being re-styled in each of
// the three panel files.
//
// caveat and note are the tile's long prose and are reachable only through the
// header's info affordance. sub stays on the face: it carries whatever stops the
// value being misread — the n and the fractions it is computed from, the key to
// any colour it is encoded in — and none of that may be a hover away.
export default function QualityTile({
  label,
  value,
  sub,
  caveat,
  note,
  loading = false,
  empty = false,
  error,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  caveat?: string;
  note?: string;
  loading?: boolean;
  empty?: boolean;
  error?: string;
}) {
  // The prose interpolates the row's own counts, so it says nothing while the
  // row is absent. Shown on exactly the states that show a value.
  const showProse = !loading && error === undefined && !empty;

  return (
    <Paper
      elevation={3}
      sx={{
        p: 2,
        height: "100%",
        minHeight: TILE_MIN_HEIGHT,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Typography variant="subtitle2" color="text.secondary">
          {label}
        </Typography>
        {showProse && <InfoTooltip label={label} paragraphs={[caveat, note]} />}
      </Stack>

      {loading && (
        <Skeleton
          variant="rectangular"
          height={VALUE_SKELETON_HEIGHT}
          sx={{ mt: 1 }}
        />
      )}

      {!loading && error !== undefined && (
        <Typography variant="body2" color="error.main" sx={{ mt: 1 }}>
          {error}
        </Typography>
      )}

      {!loading && error === undefined && empty && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {NO_DATA_IN_WINDOW}
        </Typography>
      )}

      {showProse && (
        <>
          <Typography
            component="div"
            color="text.primary"
            sx={{
              mt: 0.5,
              lineHeight: 1.2,
              fontSize: VALUE_FONT_SIZE,
            }}
          >
            {value}
          </Typography>
          {sub !== undefined && (
            <Typography variant="body2" color="text.primary" sx={{ mt: 0.5 }}>
              {sub}
            </Typography>
          )}
        </>
      )}
    </Paper>
  );
}
