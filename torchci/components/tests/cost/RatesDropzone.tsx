import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import {
  Box,
  Button,
  CircularProgress,
  Collapse,
  Link,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import RatesFormat from "components/tests/cost/RatesFormat";
import TextButton from "components/tests/TextButton";
import { RATES_FILE_URL } from "lib/tests/cost/rates";
import type { RatesHandoff } from "lib/tests/cost/useRatesHandoff";
import { headerBandColor } from "lib/tests/headerColors";
import { type ReactNode, useEffect, useState } from "react";

// A text action in the rates lines: underlined, so it reads as one. One that
// opens and closes something in place says which it is (TextButton).
export function RatesAction({
  label,
  onClick,
  expanded,
  children,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <TextButton label={label} onClick={onClick} expanded={expanded}>
      <Box component="span" sx={{ textDecoration: "underline" }}>
        {children}
      </Box>
    </TextButton>
  );
}

// The internal rates file as a link in a sentence: the way in when the Meta
// window is not one. It opens in a new tab, where the browser downloads it.
function RatesFileLink({ children }: { children: ReactNode }) {
  return (
    <Link
      href={RATES_FILE_URL}
      target="_blank"
      rel="noopener noreferrer"
      color="inherit"
      underline="always"
    >
      {children}
    </Link>
  );
}

export interface RatesDropzoneProps {
  // A file is being dragged over the page.
  dragging: boolean;
  error: string | null;
  // The one-click way to the internal rates, on the origins they can be
  // handed to (useRatesHandoff); elsewhere, the file's download.
  handoff?: RatesHandoff | null;
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
// one is dragged. Under the words are two buttons, and one of them is
// filled: the most direct way to rates the page has. Where the rates can be
// handed to the origin that is "Load Meta rates", which opens Meta's sign-in in a
// small window that hands the rates to the page (handoff.ts), with the
// reader's own file beside it in grey; elsewhere it is the reader's own
// file, with a link to download the internal one beside it. What a file
// holds is not a button: "See the format" in the words opens it under the
// buttons, which stay where they were. While the page waits for the window,
// a ring turns where that button's arrow was and a line under the buttons
// says so, with the download as the way round a blocked window. Rates that
// can't be loaded say why here, the format open.
export default function RatesDropzone({
  dragging,
  error,
  handoff = null,
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
  const waiting = handoff !== null && handoff.waiting;
  // Both buttons: one size, the words as written.
  const button = {
    textTransform: "none",
    whiteSpace: "nowrap",
    px: 1.5,
  } as const;
  // The one that is not filled: the band's grey, as the format's examples.
  const quiet = {
    ...button,
    color: "text.primary",
    backgroundColor: headerBandColor(theme),
    "&:hover": {
      backgroundColor: alpha(theme.palette.text.primary, dark ? 0.16 : 0.1),
    },
  } as const;
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        px: 3,
        py: 4,
        textAlign: "center",
        borderRadius: `${Number(theme.shape.borderRadius)}px`,
        // While a file is dragged the dashes give way to a solid ring. The
        // ring is a shadow drawn inside the same box, not a wider border, so
        // nothing in the area moves, on any screen.
        border: `1.5px dashed ${
          dragging ? "transparent" : theme.palette.divider
        }`,
        boxShadow: dragging
          ? `inset 0 0 0 2px ${theme.palette.primary.main}`
          : "none",
        m: "0.5px",
        backgroundColor: dragging
          ? alpha(theme.palette.primary.main, dark ? 0.16 : 0.06)
          : "transparent",
        transition:
          "background-color 120ms, border-color 120ms, box-shadow 120ms",
      }}
    >
      <UploadFileOutlinedIcon
        sx={{
          fontSize: 32,
          color: dragging ? "primary.main" : "text.secondary",
          transition: "color 120ms",
        }}
      />
      <Typography
        variant="subtitle1"
        component="p"
        sx={{ fontWeight: 600, mt: 1, textWrap: "balance" }}
      >
        {dragging
          ? "Drop to apply your rates"
          : "Apply your runner rates to see cost by owner"}
      </Typography>
      {/* Two lines, each one thought: what to bring, then what becomes of
          it. The way to the file's format ends them, named for what it
          opens; its words stay the same open or closed, so the centered
          line does not shift, and its chevron turns instead. */}
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mt: 0.5,
          maxWidth: "72ch",
          textWrap: "balance",
        }}
      >
        Drop a JSON of $ per runner-hour here, or choose one.
        <br />
        HUD never receives or stores it.{" "}
        <RatesAction
          label="See the format of a rates file"
          expanded={formatOpen}
          onClick={() => setFormatOpen(!formatOpen)}
        >
          See the format
        </RatesAction>
      </Typography>
      <Box role="alert" sx={{ maxWidth: "80ch" }}>
        {error !== null && (
          <Typography
            variant="body2"
            sx={{ color: warning, mt: 1.5, textWrap: "balance" }}
          >
            <b>Couldn&apos;t load the rates.</b> {error}{" "}
            <RatesAction label="Dismiss the error" onClick={onDismissError}>
              Dismiss
            </RatesAction>
            {handoff !== null && (
              <>
                {" · "}
                <RatesFileLink>Download rates file</RatesFileLink>
              </>
            )}
          </Typography>
        )}
      </Box>
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "center",
          gap: 1,
          mt: 2.5,
        }}
      >
        {handoff !== null ? (
          // Public readers see it too, but the window it opens goes on only
          // for Meta employees, as its tooltip says. The arrow after the
          // words says a window opens; while the page waits for that window
          // a turning ring takes the arrow's place, in the arrow's space, so
          // the buttons do not move.
          <Tooltip
            describeChild
            title="Needs access to the internal rates. Opens a Meta sign-in window."
          >
            <Button
              variant="contained"
              size="small"
              disableElevation
              onClick={handoff.load}
              endIcon={
                waiting ? (
                  <CircularProgress
                    size={12}
                    thickness={5.5}
                    color="inherit"
                    sx={{ m: "2px" }}
                  />
                ) : (
                  <OpenInNewRoundedIcon sx={{ fontSize: "16px !important" }} />
                )
              }
              sx={button}
            >
              Load Meta rates
            </Button>
          </Tooltip>
        ) : (
          // A plain link: the browser downloads the file, which then comes
          // in as any other does. Public readers see it too, but it opens
          // only for Meta employees, as its tooltip says.
          <Tooltip
            describeChild
            title="Needs access to the internal rates file. Opens in a new tab."
          >
            <Button
              component="a"
              href={RATES_FILE_URL}
              target="_blank"
              rel="noopener noreferrer"
              size="small"
              disableElevation
              startIcon={
                <DownloadRoundedIcon sx={{ fontSize: "16px !important" }} />
              }
              sx={quiet}
            >
              Download rates file
            </Button>
          </Tooltip>
        )}
        <Button
          variant={handoff === null ? "contained" : "text"}
          size="small"
          disableElevation
          onClick={onChoose}
          sx={handoff === null ? button : quiet}
        >
          {error === null ? "Choose rates file…" : "Choose another file…"}
        </Button>
      </Box>
      {/* Under the buttons, so the one just pressed stays where it was; it
          opens and closes as the format does, not all at once. */}
      <Box role="status" sx={{ maxWidth: "80ch" }}>
        <Collapse in={waiting} mountOnEnter unmountOnExit>
          <Typography
            variant="body2"
            sx={{ color: "text.secondary", pt: 1.5, textWrap: "balance" }}
          >
            Waiting for the rates from the Meta window…{" "}
            <RatesAction label="Stop waiting" onClick={() => handoff?.cancel()}>
              Cancel
            </RatesAction>
            <br />
            If no window opened, allow pop-ups for this site, or{" "}
            <RatesFileLink>download the rates file</RatesFileLink> and drop it
            here.
          </Typography>
        </Collapse>
      </Box>
      {/* The format opens in the area, centered with the rest, its text
          left-aligned as code and lists read. */}
      <Collapse in={formatOpen} sx={{ alignSelf: "stretch" }}>
        <Box sx={{ display: "flex", justifyContent: "center", pt: 3 }}>
          <RatesFormat exampleLabels={exampleLabels} runners={runners} />
        </Box>
      </Collapse>
    </Box>
  );
}
