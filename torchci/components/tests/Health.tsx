import { Box, SxProps, Theme, Tooltip } from "@mui/material";
import { CELL_ROOT_SX, CellBlock, CellFrame } from "components/tests/CellBlock";
import DetailList from "components/tests/DetailList";
import TextLink from "components/tests/TextLink";
import { STATUS_HUES } from "lib/tests/blockColors";
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
  // Where the runs behind the counts are seen: the test's page, opened on
  // the window and code sources the counts cover with this configuration
  // marked (testRunsHref). Undefined while the page cannot say yet, when the
  // cell is plain text.
  href?: string;
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
// the unremarkable case the blocks stand out of. The cell is the test's own
// figure, so it leads to the test: the block, or the word of a healthy
// cell, is a link to the test's page opened on the runs the counts were
// made over (`href`), where the tokens in the cells beside it narrow the
// list. The block keeps its hue's ink and the healthy word its muted tone,
// not the link blue the name and the duration figure take, so the column
// stays about status. Narrowing the list by status is the Health header's
// filter. The tooltip lists every count and rate, and says where a click
// leads.
export default function Health({ health, options, href }: HealthProps) {
  const block = blockStatus(health.status);
  const label = statusLabel(health.status, options);
  const rate = healthRate(health);
  const details = healthDetails(health);
  return (
    <Tooltip
      enterDelay={600}
      placement="bottom-start"
      title={
        <>
          <DetailList details={healthFacts(health)} />
          {href !== undefined && (
            <Box sx={{ mt: 0.75, opacity: 0.7 }}>
              Click to see its runs by commit.
            </Box>
          )}
        </>
      }
    >
      <Box component="span" sx={{ ...CELL_ROOT_SX, color: "text.secondary" }}>
        {block !== null ? (
          <CellBlock
            hue={STATUS_HUES[block]}
            href={href}
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
              href === undefined ? (
                label
              ) : (
                <TextLink href={href} tone="text">
                  {label}
                </TextLink>
              )
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
