import { Box, Tooltip, Typography } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import DetailList from "components/tests/DetailList";
import { Breakable, breakPieces } from "components/tests/TestName";
import type { TestRecord } from "lib/api/tests/types";
import { caseNameDetails, splitCaseName } from "lib/tests/header";
import { Fragment } from "react";

export interface TestTitleProps {
  // The test named; undefined when there is none, when the title says only
  // what the page is.
  test: Pick<TestRecord, "case_name" | "declared_case_name"> | undefined;
}

// The headline's measure: HUD's h5 size, a step under the list page's h4,
// but heavier and with the tracking drawn in, so an identifier anchors the
// page without filling it.
const HEADLINE_SX = {
  fontSize: (theme: Theme) => theme.typography.h5.fontSize,
  fontWeight: 600,
  letterSpacing: "-0.02em",
  lineHeight: 1.25,
  overflowWrap: "anywhere",
  color: "text.primary",
} as const;

// The headline of a test's page is its case name, the exact string the
// runner selects, in one line of two weights: the name as declared in the
// code at full weight, since that is what a reader knows the test by, and
// the parameters the runner appended at regular weight in the secondary
// tone, so the variant recedes without leaving the name. Selecting the line
// copies the whole case name. A long name wraps after a "_" or "/" in it
// (Breakable, as the list's Name cell wraps), anywhere only in a piece
// longer than the line. Each piece of the parameters is its own span with
// one text node, so a drag can start a selection in it (see TestName).
// Hovering the line tells the two names apart: a tooltip in the cells'
// style (DetailList) gives the declared name and the case name in full.
export default function TestTitle({ test }: TestTitleProps) {
  if (test === undefined) {
    return (
      <Typography component="h1" sx={HEADLINE_SX}>
        Test
      </Typography>
    );
  }
  const { declared, parameters } = splitCaseName(test);
  return (
    <Tooltip
      enterDelay={600}
      placement="bottom-start"
      title={<DetailList details={caseNameDetails(test)} />}
      // Wide enough for a long case name on a line or two, which the
      // default width would break into many.
      slotProps={{
        tooltip: {
          sx: { maxWidth: 720, "& dd": { overflowWrap: "anywhere" } },
        },
      }}
    >
      <Typography component="h1" sx={HEADLINE_SX}>
        <Breakable text={declared} />
        {breakPieces(parameters).map((piece, index) => (
          <Fragment key={index}>
            <wbr />
            <Box
              component="span"
              sx={{ fontWeight: 400, color: "text.secondary" }}
            >
              {piece}
            </Box>
          </Fragment>
        ))}
      </Typography>
    </Tooltip>
  );
}
