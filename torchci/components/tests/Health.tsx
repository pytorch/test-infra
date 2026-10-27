import { Box, SxProps, Theme, Tooltip } from "@mui/material";
import { CELL_ROOT_SX, CellBlock, CellFrame } from "components/tests/CellBlock";
import DetailList from "components/tests/DetailList";
import TextButton from "components/tests/TextButton";
import { STATUS_HUES } from "lib/tests/blockColors";
import type { Token } from "lib/tests/environment";
import type { FacetOptions } from "lib/tests/facets";
import {
  blockStatus,
  HealthCounts,
  healthDetails,
  healthFacts,
  healthRate,
  statusLabel,
} from "lib/tests/health";
import { Fragment } from "react";

export interface HealthProps {
  health: HealthCounts;
  // The options, for the status's label; the API's spelling without them.
  options: Partial<FacetOptions> | undefined;
  // The status clicked: show only the rows with it.
  onFilter: (_filters: Token["filters"]) => void;
}

// The counts behind the status, set apart by dots fainter than the words:
// the caption of the cell's frame or block.
function Details({
  parts,
  dotSx,
}: {
  parts: readonly string[];
  dotSx: SxProps<Theme>;
}) {
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <Box component="span" sx={{ mx: 0.5, ...dotSx }}>
              ·
            </Box>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}

// How the test's runs went, in the two voices of the cells beside it. The
// status is the API's word for it. Failing, flaky and skipped are blocks of
// their hue, red, yellow and purple (`CellBlock`), filling the cell less a
// uniform margin, however tall the row, and holding the word, the failure
// rate when there is one, and the counts behind them, "Failing 92%" over
// "36 of 39 runs · 124 skipped", so a rate over one run reads as what it is.
// Healthy is plain muted text in the same frame, the word over the counts,
// the unremarkable case the blocks stand out of. Clicking the word or the
// block shows only the rows with that status, as a token click filters the
// other columns. The tooltip lists every count and rate.
export default function Health({ health, options, onFilter }: HealthProps) {
  const block = blockStatus(health.status);
  const label = statusLabel(health.status, options);
  const rate = healthRate(health);
  const details = healthDetails(health);
  const filter = () => onFilter({ status: health.status });
  return (
    <Tooltip
      enterDelay={600}
      placement="bottom-start"
      title={<DetailList details={healthFacts(health)} />}
    >
      <Box component="span" sx={{ ...CELL_ROOT_SX, color: "text.secondary" }}>
        {block !== null ? (
          <CellBlock
            hue={STATUS_HUES[block]}
            label={`Only ${label.toLowerCase()}`}
            onClick={filter}
            lead={
              <Box component="span" sx={{ display: "inline-flex", gap: "6px" }}>
                <span>{label}</span>
                {rate !== null && <span>{rate}</span>}
              </Box>
            }
            caption={<Details parts={details} dotSx={{ opacity: 0.6 }} />}
          />
        ) : (
          <CellFrame
            lead={
              <TextButton
                label={`Only ${label.toLowerCase()}`}
                onClick={filter}
              >
                {label}
              </TextButton>
            }
            caption={
              <Details parts={details} dotSx={{ color: "text.disabled" }} />
            }
          />
        )}
      </Box>
    </Tooltip>
  );
}
