import { Box } from "@mui/material";
import type { Detail } from "lib/tests/environment";
import { Fragment } from "react";

// Names and their values in two columns, for a tooltip: an environment's
// eleven fields, a health cell's counts and rates.
export default function DetailList({
  details,
}: {
  details: readonly Detail[];
}) {
  return (
    <Box
      component="dl"
      sx={{
        m: 0,
        display: "grid",
        gridTemplateColumns: "auto auto",
        columnGap: 1.5,
        rowGap: 0.25,
        "& dt": { opacity: 0.7 },
        "& dd": { m: 0 },
      }}
    >
      {details.map((detail) => (
        <Fragment key={detail.name}>
          <dt>{detail.name}</dt>
          <dd>{detail.value}</dd>
        </Fragment>
      ))}
    </Box>
  );
}
