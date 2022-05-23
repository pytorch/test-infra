/**
 * A metrics panel that shows a single scalar value.
 */

import { RocksetParam } from "lib/rockset";
import { Box, Paper, Typography, Skeleton } from "@mui/material";
import { fetcher } from "lib/GeneralUtils";
import useSWR from "swr";

export default function ScalarPanel({
  // Human-readable title of the panel.
  title,
  // Query lambda collection in Rockset.
  queryCollection = "metrics",
  // Query lambda name in Rockset.
  queryName,
  // Rockset query parameters
  queryParams,
  // Callback to render the scalar value in some nice way.
  valueRenderer,
  // The name of field to use when retrieving the value from the Rockset result.
  metricName,
  // Callback to decide whether the scalar value is "bad" and should be displayed red.
  badThreshold,
}: {
  title: string;
  queryCollection?: string;
  queryName: string;
  queryParams: RocksetParam[];
  valueRenderer: (value: any) => string;
  metricName: string;
  badThreshold: (value: any) => boolean;
}) {
  const url = `/api/query/${queryCollection}/${queryName}?parameters=${encodeURIComponent(
    JSON.stringify(queryParams)
  )}`;

  const { data } = useSWR(url, fetcher, {
    refreshInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });

  if (data === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const value = data.length > 0 ? data[0][metricName] : undefined;
  let fontColor = badThreshold(value) ? "#ee6666" : "black";

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
