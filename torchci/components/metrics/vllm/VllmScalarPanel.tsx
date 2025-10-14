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
  delta,
}: {
  title: string;
  value: any;
  valueRenderer: (_value: any) => string;
  badThreshold: (_value: any) => boolean;
  tooltip?: string;
  delta?: number | null;
}) {
  if (value === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const fontColor = badThreshold(value) ? "#ee6666" : "inherit";

  // Determine delta color: green if positive, red if negative
  let deltaColor = "#999";
  if (delta !== null && delta !== undefined) {
    deltaColor = delta > 0 ? "#00ff00" : delta < 0 ? "#ee6666" : "#999";
  }

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
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 0.5,
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
          {delta !== null && delta !== undefined && (
            <Typography
              sx={{
                fontSize: "0.9rem",
                color: deltaColor,
                fontWeight: "bold",
              }}
            >
              ({delta > 0 ? "+" : ""}
              {delta.toFixed(1)}%)
            </Typography>
          )}
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
  delta1,
  delta2,
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
  delta1?: number | null;
  delta2?: number | null;
}) {
  if (value1 === undefined || value2 === undefined) {
    return <Skeleton variant={"rectangular"} height={"100%"} />;
  }

  const color1 = badThreshold1(value1) ? "#ee6666" : "inherit";
  const color2 = badThreshold2(value2) ? "#ee6666" : "inherit";

  // Delta colors: green if positive, red if negative
  const getDeltaColor = (delta: number | null | undefined) => {
    if (delta === null || delta === undefined) return "#999";
    return delta > 0 ? "#00ff00" : delta < 0 ? "#ee6666" : "#999";
  };

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
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
            }}
          >
            <Box sx={{ textAlign: "right" }}>
              <Typography sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
                {label1}
              </Typography>
              <Typography
                sx={{ fontSize: "2rem", fontWeight: "bold", color: color1 }}
              >
                {valueRenderer(value1)}
              </Typography>
            </Box>
            {delta1 !== null && delta1 !== undefined && (
              <Typography
                sx={{
                  fontSize: "0.8rem",
                  color: getDeltaColor(delta1),
                  fontWeight: "bold",
                  alignSelf: "flex-end",
                  mb: 0.5,
                }}
              >
                ({delta1 > 0 ? "+" : ""}
                {delta1.toFixed(1)}%)
              </Typography>
            )}
          </Box>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
            }}
          >
            <Box sx={{ textAlign: "right" }}>
              <Typography sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
                {label2}
              </Typography>
              <Typography
                sx={{ fontSize: "2rem", fontWeight: "bold", color: color2 }}
              >
                {valueRenderer(value2)}
              </Typography>
            </Box>
            {delta2 !== null && delta2 !== undefined && (
              <Typography
                sx={{
                  fontSize: "0.8rem",
                  color: getDeltaColor(delta2),
                  fontWeight: "bold",
                  alignSelf: "flex-end",
                  mb: 0.5,
                }}
              >
                ({delta2 > 0 ? "+" : ""}
                {delta2.toFixed(1)}%)
              </Typography>
            )}
          </Box>
        </Box>
      </Box>
    </Paper>
  );
}
