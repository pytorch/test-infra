import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import RemoveIcon from "@mui/icons-material/Remove";
import {
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  useTheme,
} from "@mui/material";
import { TriState } from "lib/types";

// Shared column widths so the header lines up with each row.
const TOGGLE_COL_WIDTH = 116;
const PERSIST_COL_WIDTH = 48;

/**
 * Header row for the "Options" panel, labeling the three columns: the tri-state
 * toggle (the value used for the current page), the option name, and the persist
 * switch (the saved default). Column widths match OptionRow so they align.
 */
export function OptionRowHeader() {
  const theme = useTheme();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: "0.5rem",
        fontSize: "0.7rem",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.03em",
        color: theme.palette.text.secondary,
        borderBottom: `1px solid ${theme.palette.divider}`,
        paddingBottom: "0.25rem",
        marginBottom: "0.25rem",
      }}
    >
      <span style={{ width: TOGGLE_COL_WIDTH, textAlign: "center" }}>
        This page
      </span>
      <span style={{ flex: 1 }}>Option</span>
      <span style={{ width: PERSIST_COL_WIDTH, textAlign: "center" }}>
        Default
      </span>
    </div>
  );
}

/**
 * A single row in the HUD "Options" panel. It combines:
 *  - a tri-state toggle (Off / Default / On) whose value lives in the URL
 *    ("default" means "not in the URL", so it falls back to the persisted value)
 *  - a "persist" switch that writes the localStorage default used whenever the
 *    toggle is in the "default" state.
 *
 * Uses off-the-shelf MUI ToggleButtonGroup + Switch so it inherits theming.
 */
export default function OptionRow({
  label,
  urlState,
  setUrlState,
  persist,
  setPersist,
  disabled = false,
  title,
}: {
  label: string;
  urlState: TriState;
  setUrlState: (_value: TriState) => void;
  persist: boolean;
  setPersist: (_value: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  const theme = useTheme();
  const success = theme.palette.success.main;
  const error = theme.palette.error.main;

  const row = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "default",
      }}
    >
      <ToggleButtonGroup
        exclusive
        size="small"
        value={urlState}
        disabled={disabled}
        onChange={(_e, value) => {
          // MUI passes null when the already-selected button is clicked again;
          // ignore that so a button can't be deselected into an invalid state.
          if (value !== null) {
            setUrlState(value as TriState);
          }
        }}
        aria-label={label}
        sx={{ width: TOGGLE_COL_WIDTH }}
      >
        <ToggleButton
          value="off"
          aria-label="off"
          sx={{
            flex: 1,
            padding: "2px",
            "&.Mui-selected": { color: error },
          }}
        >
          <CloseIcon fontSize="small" />
        </ToggleButton>
        <ToggleButton
          value="default"
          aria-label="default"
          sx={{ flex: 1, padding: "2px" }}
        >
          <RemoveIcon fontSize="small" />
        </ToggleButton>
        <ToggleButton
          value="on"
          aria-label="on"
          sx={{
            flex: 1,
            padding: "2px",
            "&.Mui-selected": { color: success },
          }}
        >
          <CheckIcon fontSize="small" />
        </ToggleButton>
      </ToggleButtonGroup>
      <span style={{ flex: 1, whiteSpace: "nowrap" }}>{label}</span>
      <Tooltip title="Persist as your default (used when the toggle is in the middle/default state)">
        <span
          style={{
            width: PERSIST_COL_WIDTH,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <Switch
            size="small"
            checked={persist}
            disabled={disabled}
            onChange={(e) => setPersist(e.target.checked)}
            inputProps={{ "aria-label": `persist ${label}` }}
          />
        </span>
      </Tooltip>
    </div>
  );

  return title ? (
    <Tooltip title={title}>
      <span>{row}</span>
    </Tooltip>
  ) : (
    row
  );
}
