import { Grid } from "@mui/material";
import { QualityQueryState } from "lib/greenlight/qualityQuery";
import QualityTile, { TILE_SPAN_QUARTER } from "./QualityTile";
import { COVERAGE_TILES } from "./tileConfigs";

// Coverage is fetched by the page rather than here: its effective window also
// decides whether the rest of the page auto-refreshes, so one owner holds it.
export default function CoverageTiles({
  coverage,
}: {
  coverage: QualityQueryState;
}) {
  return (
    <Grid container spacing={2}>
      {COVERAGE_TILES.map((tile) => (
        <Grid key={tile.key} size={TILE_SPAN_QUARTER}>
          <QualityTile
            label={tile.label}
            size={tile.size}
            value={tile.value(coverage.row)}
            caveat={tile.caveat?.(coverage.row)}
            loading={coverage.loading}
            empty={tile.isEmpty?.(coverage.row) ?? false}
            error={coverage.error}
          />
        </Grid>
      ))}
    </Grid>
  );
}
