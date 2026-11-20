import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import {
  Box,
  ButtonBase,
  IconButton,
  Popover,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import RatesFormatPeriods from "components/tests/cost/rates/RatesFormatPeriods";
import { RatesAction } from "components/tests/cost/RatesDropzone";
import { VIEW_CHIP_HEIGHT } from "components/tests/ViewChips";
import type { RatesControlProps, RatesSet } from "lib/api/tests/cost/contracts";
import { daySpanLabel, ratesChip } from "lib/tests/cost/ratePeriods";
import { RATES_FILE_URL } from "lib/tests/cost/rates";
import {
  headerBandColor,
  headerBandHoverColor,
  headerKeyFocusRing,
} from "lib/tests/headerColors";
import { useRef, useState } from "react";

const PRIVACY =
  "They stay in this tab; HUD never receives or stores them, and reloading drops them.";

// What the chip's tooltip adds to its words.
function chipLines(rates: RatesSet): string[] {
  const provisional = rates.periods.filter((p) => p.status === "provisional");
  return [
    ratesChip(rates),
    ...(rates.metaFile === null ? [] : [`With ${rates.metaFile}`]),
    ...(provisional.length === 0
      ? []
      : [
          `Provisional: ${provisional
            .map((p) => daySpanLabel(p.validFrom!, p.validThrough!))
            .join(", ")}`,
        ]),
    ...(rates.legacy && rates.periods[0].window !== null
      ? [
          `Averaged over ${daySpanLabel(
            rates.periods[0].window.start,
            rates.periods[0].window.end
          )}`,
        ]
      : []),
    ...(rates.basis === null ? [] : [rates.basis]),
    "In this tab only. Click to replace.",
  ];
}

// The title row's rates control: "Add rates…" until a
// rates.json (and its rates.meta.json) is loaded, then a chip naming it with
// ✕; a Format popover; one inline error line; "Drop rates files to load"
// while files are dragged over the page (the page owns the drop). No edits.
export default function RatesControl({
  rates,
  error,
  dragging,
  exampleLabels,
  onFiles,
  onClear,
  onDismissError,
}: RatesControlProps) {
  const theme = useTheme();
  const dark = theme.palette.mode === "dark";
  const picker = useRef<HTMLInputElement>(null);
  const [formatAnchor, setFormatAnchor] = useState<HTMLElement | null>(null);
  const choose = () => picker.current?.click();
  const warning = dark ? theme.palette.error.light : theme.palette.error.dark;
  const pill = {
    display: "inline-flex",
    alignItems: "center",
    gap: 0.75,
    height: VIEW_CHIP_HEIGHT,
    px: 1.25,
    borderRadius: "999px",
    typography: "body2",
    whiteSpace: "nowrap",
  } as const;
  const pressable = {
    ...pill,
    color: "text.primary",
    backgroundColor: headerBandColor(theme),
    "&:hover": { backgroundColor: headerBandHoverColor(theme) },
    "&.Mui-focusVisible": headerKeyFocusRing(theme),
  } as const;

  let main;
  if (dragging) {
    main = (
      <Box
        sx={{
          ...pill,
          color: "primary.main",
          fontWeight: 500,
          border: `1.5px dashed ${theme.palette.primary.main}`,
          backgroundColor: alpha(
            theme.palette.primary.main,
            dark ? 0.16 : 0.06
          ),
        }}
      >
        <UploadFileOutlinedIcon sx={{ fontSize: 18 }} />
        Drop rates files to load
      </Box>
    );
  } else if (rates === null) {
    main = (
      <Tooltip
        describeChild
        enterDelay={500}
        title={`Price runner-hours with your rates.json (and its rates.meta.json). ${PRIVACY}`}
      >
        <ButtonBase onClick={choose} sx={pressable}>
          <UploadFileOutlinedIcon
            sx={{ fontSize: 18, color: "text.secondary" }}
          />
          Add rates…
        </ButtonBase>
      </Tooltip>
    );
  } else {
    main = (
      <Box
        sx={{
          ...pill,
          pr: 0.25,
          gap: 0.25,
          maxWidth: 420,
          backgroundColor: headerBandColor(theme),
        }}
      >
        <Tooltip
          describeChild
          enterDelay={500}
          title={chipLines(rates).join("\n")}
          slotProps={{
            tooltip: { sx: { whiteSpace: "pre-line", maxWidth: 460 } },
          }}
        >
          <ButtonBase
            onClick={choose}
            aria-label={`Replace ${rates.file}`}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.75,
              minWidth: 0,
              height: "100%",
              borderRadius: "999px",
              typography: "body2",
              color: "text.primary",
              "&.Mui-focusVisible": headerKeyFocusRing(theme),
            }}
          >
            <InsertDriveFileOutlinedIcon
              sx={{ fontSize: 17, color: "text.secondary", flex: "none" }}
            />
            <Box
              component="span"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {ratesChip(rates, true)}
            </Box>
          </ButtonBase>
        </Tooltip>
        <IconButton
          size="small"
          aria-label="Clear the rates"
          onClick={onClear}
          sx={{ p: 0.25, color: "text.secondary" }}
        >
          <CloseRoundedIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        rowGap: 0.5,
        minWidth: 0,
      }}
    >
      <input
        ref={picker}
        type="file"
        accept="application/json,.json"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Cleared, so the same files can be picked again.
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          columnGap: 1.25,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        {main}
        <ButtonBase
          disableRipple
          aria-haspopup="dialog"
          aria-expanded={formatAnchor !== null}
          aria-label="Rates file format"
          onClick={(e) =>
            setFormatAnchor(formatAnchor === null ? e.currentTarget : null)
          }
          sx={{
            flex: "none",
            typography: "body2",
            color: "text.secondary",
            textDecoration: "underline",
            textUnderlineOffset: "3px",
            borderRadius: "2px",
            "&:hover": { color: "text.primary" },
            "&.Mui-focusVisible": headerKeyFocusRing(theme),
          }}
        >
          Format
        </ButtonBase>
      </Box>
      <Box role="alert" sx={{ maxWidth: "72ch", textAlign: "right" }}>
        {error !== null && (
          <Typography variant="body2" sx={{ color: warning }}>
            <b>
              {rates === null
                ? "Couldn't read the rates files."
                : `Kept ${rates.file}.`}
            </b>{" "}
            {error}{" "}
            <RatesAction label="Dismiss the error" onClick={onDismissError}>
              Dismiss
            </RatesAction>
          </Typography>
        )}
      </Box>
      <Popover
        open={formatAnchor !== null}
        anchorEl={formatAnchor}
        onClose={() => setFormatAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            // Flat on the page's paper, so the examples' band grey reads
            // as it does on the page in either mode.
            sx: {
              p: 1.5,
              maxWidth: "min(960px, calc(100vw - 32px))",
              backgroundImage: "none",
              border: `1px solid ${theme.palette.divider}`,
            },
          },
        }}
      >
        <RatesFormatPeriods exampleLabels={exampleLabels} />
        <Typography
          variant="body2"
          sx={{ mt: 1.25, color: "text.secondary", maxWidth: "88ch" }}
        >
          Drop rates.json (and its rates.meta.json) on the page, or choose them.{" "}
          {PRIVACY}{" "}
          <Box
            component="a"
            href={RATES_FILE_URL}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ color: "primary.main" }}
          >
            Download the internal rates file
          </Box>{" "}
          (Meta employees).
        </Typography>
      </Popover>
    </Box>
  );
}
