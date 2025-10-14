/**
 * vLLM-specific metric panels with tooltip support and consistent heights
 */

import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import { Box, Paper, Skeleton, Tooltip, Typography } from "@mui/material";
import { COLOR_HELP_ICON } from "./constants";

// Single-value panel for vLLM metrics
export function VllmScalarPanel({
  title,
  value,
  valueRenderer,
  badThreshold,
  tooltip,
}: {
  title: string;
  value: any;
  valueRenderer: (_value: any) => string;
  badThreshold: (_value: any) => boolean;
  tooltip?: string;
}) {
  if (value === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const fontColor = badThreshold(value) ? "#ee6666" : "inherit";

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 1 }}>
          <Typography
            sx={{
              fontSize: "1rem",
              fontWeight: "bold",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
            }}
            noWrap
            title={title}
          >
            {title}
          </Typography>
          {tooltip && (
            <Tooltip title={tooltip} arrow placement="top">
              <HelpOutlineIcon
                sx={{
                  fontSize: "1rem",
                  color: COLOR_HELP_ICON,
                  cursor: "help",
                }}
              />
            </Tooltip>
          )}
        </Box>
        <Box
          sx={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Typography
            sx={{
              fontSize: "3rem",
              color: fontColor,
              fontWeight: "bold",
            }}
          >
            {valueRenderer(value)}
          </Typography>
        </Box>
      </Box>
    </Paper>
  );
}

// Dual-value panel for showing P50/P90 or similar paired metrics
export function VllmDualScalarPanel({
  title,
  value1,
  value2,
  label1 = "P50",
  label2 = "P90",
  valueRenderer,
  badThreshold1,
  badThreshold2,
  tooltip,
}: {
  title: string;
  value1: any;
  value2: any;
  label1?: string;
  label2?: string;
  valueRenderer: (_value: any) => string;
  badThreshold1: (_value: any) => boolean;
  badThreshold2: (_value: any) => boolean;
  tooltip?: string;
}) {
  if (value1 === undefined || value2 === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const color1 = badThreshold1(value1) ? "#ee6666" : "inherit";
  const color2 = badThreshold2(value2) ? "#ee6666" : "inherit";

  return (
    <Paper sx={{ p: 2, height: "100%" }} elevation={3}>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 1 }}>
          <Typography
            sx={{
              fontSize: "1rem",
              fontWeight: "bold",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
            }}
            noWrap
            title={title}
          >
            {title}
          </Typography>
          {tooltip && (
            <Tooltip title={tooltip} arrow placement="top">
              <HelpOutlineIcon
                sx={{
                  fontSize: "1rem",
                  color: COLOR_HELP_ICON,
                  cursor: "help",
                }}
              />
            </Tooltip>
          )}
        </Box>
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            gap: 1,
          }}
        >
          <Box sx={{ textAlign: "center" }}>
            <Typography sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
              {label1}
            </Typography>
            <Typography
              sx={{ fontSize: "2rem", fontWeight: "bold", color: color1 }}
            >
              {valueRenderer(value1)}
            </Typography>
          </Box>
          <Box sx={{ textAlign: "center" }}>
            <Typography sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
              {label2}
            </Typography>
            <Typography
              sx={{ fontSize: "2rem", fontWeight: "bold", color: color2 }}
            >
              {valueRenderer(value2)}
            </Typography>
          </Box>
        </Box>
      </Box>
    </Paper>
  );
}
