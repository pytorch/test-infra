import { Box, Grid, useTheme } from "@mui/material";
import { intFormatter } from "components/common/numberFormat";
import {
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
} from "lib/greenlight/greenlightRender";
import { ABSENT } from "lib/greenlight/qualityFigures";
import { QualityQueryState } from "lib/greenlight/qualityQuery";
import QualityTile, { TILE_SPAN } from "./QualityTile";
import { QualityColors, qualityColors, tinted } from "./tileColors";
import { COVERAGE_TILES, StatTileConfig } from "./tileConfigs";

// An absent field renders as the page's absence mark, and a green or red dash
// asserts a LAND/NO_LAND reading of a number that is not there.
function splitCount(value: any, color: string) {
  const text = intFormatter(value);
  return text === ABSENT ? text : tinted(text, color);
}

function splitValue(tile: StatTileConfig, row: any, colors: QualityColors) {
  return (
    <Box component="span" sx={{ fontVariantNumeric: "tabular-nums" }}>
      {intFormatter(row?.[tile.totalField])}
      {" ("}
      {splitCount(row?.[tile.landField], colors.land)}
      {" / "}
      {splitCount(row?.[tile.noLandField], colors.fault)}
      {")"}
    </Box>
  );
}

// Named on the face rather than left to the caveat behind the info affordance:
// colour is the only other thing distinguishing the two numbers, and it carries
// no mapping at all for a red-green colour-deficient reader.
function splitLegend(tile: StatTileConfig, row: any, colors: QualityColors) {
  const note = tile.subNote?.(row);
  return (
    <>
      {tinted(GREENLIGHT_STATUS_LAND, colors.land)}
      {" / "}
      {tinted(GREENLIGHT_STATUS_NO_LAND, colors.fault)}
      {note === undefined ? "" : ` · ${note}`}
    </>
  );
}

// Coverage is fetched by the page rather than here: its effective window also
// decides whether the rest of the page auto-refreshes, so one owner holds it.
export default function CoverageTiles({
  coverage,
}: {
  coverage: QualityQueryState;
}) {
  const colors = qualityColors(useTheme());

  return (
    <>
      {COVERAGE_TILES.map((tile) => (
        <Grid key={tile.key} size={TILE_SPAN}>
          <QualityTile
            label={tile.label}
            value={splitValue(tile, coverage.row, colors)}
            sub={splitLegend(tile, coverage.row, colors)}
            caveat={tile.caveat?.(coverage.row)}
            loading={coverage.loading}
            empty={tile.isEmpty?.(coverage.row) ?? false}
            error={coverage.error}
          />
        </Grid>
      ))}
    </>
  );
}
