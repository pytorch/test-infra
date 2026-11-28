import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DownloadRoundedIcon from "@mui/icons-material/DownloadRounded";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import KeyboardArrowDownRoundedIcon from "@mui/icons-material/KeyboardArrowDownRounded";
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
import TextButton from "components/tests/TextButton";
import type { RatesControlProps, RatesSet } from "lib/api/tests/cost/contracts";
import { daySpanLabel, ratesChip } from "lib/tests/cost/ratePeriods";
import { RATES_FILE_URL } from "lib/tests/cost/rates";
import {
  headerBandColor,
  headerBandHoverColor,
  headerKeyFocusRing,
  headerRuleColor,
} from "lib/tests/headerColors";
import { PILL_HEIGHT } from "lib/tests/layout";
import { type ReactNode, useRef, useState } from "react";

const PRIVACY =
  "They stay in this tab; HUD never receives or stores them, and reloading drops them.";

// A text action in the error line: underlined, so it reads as one.
function RatesAction({
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

// The hub row's rates control: one grey pill joining a link to download
// the internal rates file and "Add rates…", which turns into a chip naming
// the loaded rates.json (and its rates.meta.json) with ✕, and into "Drop
// rates files to load" while files are dragged over the page (the page owns
// the drop); then a Format text button for the popover, and one inline
// error line under them. No edits.
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
  // A part of the pill, the pill's height; one pressed on its own darkens
  // under the pointer.
  const part = {
    display: "inline-flex",
    alignItems: "center",
    gap: 0.75,
    height: "100%",
    minWidth: 0,
    typography: "body2",
    whiteSpace: "nowrap",
    color: "text.primary",
    "&.Mui-focusVisible": headerKeyFocusRing(theme),
  } as const;
  const pressable = {
    ...part,
    "&:hover": { backgroundColor: headerBandHoverColor(theme) },
  } as const;
  const icon = { fontSize: 18, color: "text.secondary", flex: "none" };

  // A plain link: the browser downloads the file, which then comes in as
  // any other does. HUD never fetches it; it opens only for Meta employees.
  const download = (
    <Tooltip
      describeChild
      enterDelay={500}
      title="Needs access to the internal rates file. Opens in a new tab."
    >
      <ButtonBase
        href={RATES_FILE_URL}
        target="_blank"
        rel="noopener noreferrer"
        sx={{
          ...pressable,
          flex: "none",
          pl: 1.25,
          pr: 1,
          borderRadius: "999px 0 0 999px",
        }}
      >
        <DownloadRoundedIcon sx={icon} />
        Download rates
      </ButtonBase>
    </Tooltip>
  );

  const end = { pl: 1, pr: 1.25, borderRadius: "0 999px 999px 0" } as const;
  let main;
  if (dragging) {
    main = (
      <Box
        sx={{
          ...part,
          ...end,
          color: "primary.main",
          fontWeight: 500,
          backgroundColor: alpha(theme.palette.primary.main, dark ? 0.24 : 0.1),
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
        <ButtonBase onClick={choose} sx={{ ...pressable, ...end }}>
          <UploadFileOutlinedIcon sx={icon} />
          Add rates…
        </ButtonBase>
      </Tooltip>
    );
  } else {
    main = (
      <Box
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.25,
          minWidth: 0,
          maxWidth: 360,
          pl: 1,
          pr: 0.25,
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
            sx={{ ...part, borderRadius: "4px" }}
          >
            <InsertDriveFileOutlinedIcon sx={{ ...icon, fontSize: 17 }} />
            <Box
              component="span"
              sx={{ overflow: "hidden", textOverflow: "ellipsis" }}
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
          flexWrap: "wrap",
          justifyContent: "flex-end",
          alignItems: "center",
          gap: 0.5,
          minWidth: 0,
          maxWidth: "100%",
        }}
      >
        <Box
          role="group"
          aria-label="Rates file"
          sx={{
            display: "inline-flex",
            alignItems: "stretch",
            height: PILL_HEIGHT,
            minWidth: 0,
            borderRadius: "999px",
            backgroundColor: headerBandColor(theme),
            ...(dragging
              ? {
                  outline: `1.5px dashed ${theme.palette.primary.main}`,
                  outlineOffset: "-1.5px",
                }
              : {}),
          }}
        >
          {download}
          <Box
            aria-hidden
            sx={{
              flex: "none",
              width: "1px",
              my: 0.75,
              backgroundColor: headerRuleColor(theme),
            }}
          />
          {main}
        </Box>
        <ButtonBase
          aria-haspopup="dialog"
          aria-expanded={formatAnchor !== null}
          aria-label="Rates file format"
          onClick={(e) =>
            setFormatAnchor(formatAnchor === null ? e.currentTarget : null)
          }
          sx={{
            ...part,
            flex: "none",
            gap: 0.25,
            height: PILL_HEIGHT,
            pl: 1,
            pr: 0.5,
            borderRadius: "999px",
            color: formatAnchor === null ? "text.secondary" : "text.primary",
            backgroundColor:
              formatAnchor === null ? "transparent" : headerBandColor(theme),
            "&:hover": {
              color: "text.primary",
              backgroundColor: headerBandColor(theme),
            },
          }}
        >
          Format
          <KeyboardArrowDownRoundedIcon
            aria-hidden
            sx={{
              fontSize: 18,
              opacity: 0.7,
              transform: formatAnchor === null ? "none" : "rotate(180deg)",
              transition: theme.transitions.create("transform", {
                duration: theme.transitions.duration.shorter,
              }),
            }}
          />
        </ButtonBase>
      </Box>
      {/* As wide as the controls above, never wider: a long error wraps
          rather than pushing the keys under the title. */}
      <Box role="alert" sx={{ width: 0, minWidth: "100%", textAlign: "right" }}>
        {error !== null && (
          <Typography variant="body2" sx={{ mt: 0.5, color: warning }}>
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
