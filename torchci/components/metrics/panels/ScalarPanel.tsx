/**
 * A metrics panel that shows a single scalar value.
 */

import { Box, Paper, Skeleton, Typography } from "@mui/material";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

export function ScalarPanelWithValue({
  // Human-readable title of the panel.
  title,
  // The value to display in the panel
  value,
  // Callback to render the scalar value in some nice way.
  valueRenderer,
  // Callback to decide whether the scalar value is "bad" and should be displayed red.
  badThreshold,
}: {
  title: string;
  value: any;
  valueRenderer: (_value: any) => string;
  badThreshold: (_value: any) => boolean;
}) {
  if (value === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  let fontColor = badThreshold(value) ? "#ee6666" : "inherit";

  return (
    <Paper sx={{ p: 2 }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Typography sx={{ fontSize: "1rem", fontWeight: "bold" }}>
          {title}
        </Typography>
        <Typography
          sx={{
            fontSize: "4rem",
            my: "auto",
            alignSelf: "center",
            color: fontColor,
          }}
        >
          {valueRenderer(value)}
        </Typography>
      </Box>
    </Paper>
  );
}

export default function ScalarPanel({
  // Human-readable title of the panel.
  title,
  // Query name
  queryName,
  // Query parameters
  queryParams,
  // Callback to render the scalar value in some nice way.
  valueRenderer,
  // The name of field to use when retrieving the value from the query result.
  metricName,
  // Callback to decide whether the scalar value is "bad" and should be displayed red.
  badThreshold,
}: {
  title: string;
  queryName: string;
  queryParams: { [key: string]: any };
  valueRenderer: (_value: any) => string;
  metricName: string;
  badThreshold: (_value: any) => boolean;
}) {
  const url = `/api/clickhouse/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const value = data.length > 0 ? data[0][metricName] : undefined;
  return (
    <ScalarPanelWithValue
      title={title}
      value={value}
      valueRenderer={valueRenderer}
      badThreshold={badThreshold}
    />
  );
}
