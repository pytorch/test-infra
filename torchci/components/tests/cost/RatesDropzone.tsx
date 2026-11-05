import ExpandLessRoundedIcon from "@mui/icons-material/ExpandLessRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import { Box, Button, Collapse, Typography, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import RatesFormat from "components/tests/cost/RatesFormat";
import TextButton from "components/tests/TextButton";
import { headerBandColor } from "lib/tests/headerColors";
import { type ReactNode, useEffect, useState } from "react";

// A text action in the rates lines: underlined, so it reads as one.
export function RatesAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <TextButton label={label} onClick={onClick}>
      <Box component="span" sx={{ textDecoration: "underline" }}>
        {children}
      </Box>
    </TextButton>
  );
}

export interface RatesDropzoneProps {
  // A file is being dragged over the page.
  dragging: boolean;
  error: string | null;
  // The window's largest runners, for the format's examples, and how many
  // ran.
  exampleLabels: string[];
  runners: number;
  onChoose: () => void;
  onDismissError: () => void;
}

// The cost panel's body until a rates file is added: a dashed area that asks
// for one where its chart will be, as file drops do elsewhere. A file dropped
// anywhere on the page lands here (CostPanel), and the area lights up while
// one is dragged; the button is the way in without a mouse. A file that
// can't be read says why here, the format open under the buttons.
export default function RatesDropzone({
  dragging,
  error,
  exampleLabels,
  runners,
  onChoose,
  onDismissError,
}: RatesDropzoneProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const [formatOpen, setFormatOpen] = useState(false);
  // A file that can't be read opens the format, which can still be closed.
  useEffect(() => {
    if (error !== null) setFormatOpen(true);
  }, [error]);
  const warning = dark ? theme.palette.error.light : theme.palette.error.dark;
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.75,
        px: 3,
        py: 3,
        textAlign: "center",
        borderRadius: `${Number(theme.shape.borderRadius)}px`,
        border: dragging
          ? `2px solid ${theme.palette.primary.main}`
          : `1.5px dashed ${theme.palette.divider}`,
        // The same box either way, so the border's change doesn't shift it.
        m: dragging ? 0 : "0.5px",
        backgroundColor: dragging
          ? alpha(theme.palette.primary.main, dark ? 0.16 : 0.06)
          : "transparent",
        transition: "background-color 120ms, border-color 120ms",
      }}
    >
      <UploadFileOutlinedIcon
        sx={{
          fontSize: 32,
          color: dragging ? "primary.main" : "text.secondary",
        }}
      />
      <Typography variant="subtitle1" component="p" sx={{ fontWeight: 600 }}>
        {dragging
          ? "Drop to apply your rates"
          : "Apply your runner rates to see cost by owner"}
      </Typography>
      <Typography
        variant="body2"
        sx={{ color: "text.secondary", maxWidth: "62ch" }}
      >
        Drop a JSON of $ per runner-hour here, or choose one. It stays in this
        tab; HUD never receives or stores it.
      </Typography>
      <Box role="alert" sx={{ maxWidth: "80ch" }}>
        {error !== null && (
          <Typography variant="body2" sx={{ color: warning, mt: 0.5 }}>
            <b>Couldn&apos;t read the rates file.</b> {error}{" "}
            <RatesAction label="Dismiss the error" onClick={onDismissError}>
              Dismiss
            </RatesAction>
          </Typography>
        )}
      </Box>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          columnGap: 1.5,
          rowGap: 1,
          mt: 0.75,
          typography: "body2",
          color: "text.secondary",
        }}
      >
        <Button
          variant="contained"
          size="small"
          disableElevation
          onClick={onChoose}
          sx={{ textTransform: "none", whiteSpace: "nowrap" }}
        >
          {error === null ? "Choose rates file…" : "Choose another file…"}
        </Button>
        {/* The secondary action: the band's grey, as the examples it opens. */}
        <Button
          size="small"
          disableElevation
          aria-expanded={formatOpen}
          onClick={() => setFormatOpen(!formatOpen)}
          endIcon={
            formatOpen ? <ExpandLessRoundedIcon /> : <ExpandMoreRoundedIcon />
          }
          sx={{
            textTransform: "none",
            whiteSpace: "nowrap",
            color: "text.primary",
            backgroundColor: headerBandColor(theme),
            "&:hover": {
              backgroundColor: alpha(
                theme.palette.text.primary,
                dark ? 0.16 : 0.1
              ),
            },
          }}
        >
          File format
        </Button>
      </Box>
      {/* The format opens in the area, centered with the rest, its text
          left-aligned as code and lists read. */}
      <Collapse in={formatOpen} sx={{ alignSelf: "stretch" }}>
        <Box sx={{ display: "flex", justifyContent: "center", pt: 2 }}>
          <RatesFormat exampleLabels={exampleLabels} runners={runners} />
        </Box>
      </Collapse>
    </Box>
  );
}
