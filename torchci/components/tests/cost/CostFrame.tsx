import {
  Box,
  ButtonBase,
  LinearProgress,
  Typography,
  useTheme,
} from "@mui/material";
import InfoTip from "components/tests/cost/InfoTip";
import { headerBandColor } from "lib/tests/headerColors";
import {
  COLUMN_HEADER_HEIGHT,
  HEADER_TITLE_STYLE,
  TABLE_BORDER,
} from "lib/tests/layout";
import type { ReactNode } from "react";

export interface CostFrameProps {
  // The band's title, set as the tables' column titles are, and what the
  // chart shows, behind an (i) after it.
  title: string;
  description?: string;
  // A few muted words after the title, on the band: what the figures are of.
  note?: ReactNode;
  // The band's keys, at its right end, as the run grid holds its choices.
  keys?: ReactNode;
  // Given, the title folds the frame: a chevron before it, and only the band
  // while folded.
  open?: boolean;
  onOpenChange?: (_open: boolean) => void;
  // A sentence under the band saying why the chart matters, for a reader
  // who reads nothing else.
  subtitle?: string;
  // A line under the band, on the page's background: a legend.
  legend?: ReactNode;
  // A new answer is on its way: the theme's progress bar runs under the band
  // while the answer shown last stays.
  loading?: boolean;
  children: ReactNode;
}

// A chart framed as the hub's tables are: HUD's shared table border around
// rounded corners, a header band in the grey of the title's pills with its
// title small, bold and uppercase in the secondary color, and the chart's
// choices as keys at the band's right end, so the chart and the tables read
// as one system. Every color follows the theme's mode.
export default function CostFrame({
  title,
  description,
  note,
  keys,
  open,
  onOpenChange,
  subtitle,
  legend,
  loading = false,
  children,
}: CostFrameProps) {
  const theme = useTheme();
  const radius = Number(theme.shape.borderRadius);
  return (
    <Box
      sx={{
        border: `${TABLE_BORDER}px solid var(--table-border-color)`,
        borderRadius: `${radius}px`,
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 1,
          minHeight: COLUMN_HEADER_HEIGHT,
          px: 2,
          py: 0.75,
          backgroundColor: headerBandColor(theme),
        }}
      >
        <Typography
          component="h2"
          sx={{
            ...HEADER_TITLE_STYLE,
            fontSize: "0.875rem",
            color: "text.secondary",
          }}
        >
          {onOpenChange === undefined ? (
            title
          ) : (
            <ButtonBase
              aria-expanded={open}
              onClick={() => onOpenChange(!open)}
              sx={{
                font: "inherit",
                letterSpacing: "inherit",
                textTransform: "inherit",
                color: "inherit",
                gap: 0.5,
                "&.Mui-focusVisible": {
                  outline: `2px solid ${theme.palette.primary.main}`,
                },
              }}
            >
              <Box
                component="span"
                sx={{ width: "1em", display: "inline-block" }}
              >
                {open ? "▾" : "▸"}
              </Box>
              {title}
            </ButtonBase>
          )}
        </Typography>
        {description !== undefined && (
          <InfoTip title={description} size="17px" placement="bottom-start" />
        )}
        {note !== undefined && (
          <Typography
            component="span"
            variant="body2"
            sx={{ color: "text.secondary", whiteSpace: "nowrap" }}
          >
            {note}
          </Typography>
        )}
        <Box sx={{ mr: "auto" }} />
        {keys}
      </Box>
      <Box sx={{ height: 2 }}>
        {loading && <LinearProgress sx={{ height: 2 }} />}
      </Box>
      {open === false ? null : (
        <>
          {subtitle !== undefined && (
            <Typography
              variant="body2"
              sx={{ px: 2, pt: 1, color: "text.secondary", maxWidth: "110ch" }}
            >
              {subtitle}
            </Typography>
          )}
          {legend !== undefined && <Box sx={{ px: 2, pt: 1 }}>{legend}</Box>}
          <Box sx={{ px: 2, py: 1.5 }}>{children}</Box>
        </>
      )}
    </Box>
  );
}
