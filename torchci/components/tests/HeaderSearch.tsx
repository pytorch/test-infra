import ClearRoundedIcon from "@mui/icons-material/ClearRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import {
  Box,
  IconButton,
  InputBase,
  Paper,
  Popper,
  Tooltip,
  useTheme,
} from "@mui/material";
import { HEADER_FILTER_SIZE } from "components/tests/HeaderFilter";
import { MONOSPACE_FONT_FAMILY } from "lib/tests/header";
import { headerKeyColors, headerKeySx } from "lib/tests/headerColors";
import { KeyboardEvent, useEffect, useId, useRef, useState } from "react";

// How long typing may pause before the text goes out: the page replaces
// the URL with the text, and a replace per keystroke is a render of the
// whole grid per keystroke. Shorter than the list page's pause before its
// URL follows the search (SEARCH_PAUSE_MS there), since this text is found
// among the commits the page already has and asks the database for nothing.
// Clearing goes out at once.
export const SEARCH_PAUSE_MS = 250;

export interface HeaderSearchMessage {
  text: string;
  // An error, in the error color with the key's edge red ("No commit
  // starting with ..."), or a note in the muted text ("3 commits start
  // with ...").
  tone: "error" | "note";
}

export interface HeaderSearchProps {
  // What the field finds, for assistive technology and the tooltip: "Find a
  // commit by its hash".
  label: string;
  // Shown in the empty field: "Commit hash".
  placeholder: string;
  value: string;
  onChange: (_value: string) => void;
  // What the field says about its value under itself while it is focused
  // or hovered; null when the value is empty or found.
  message: HeaderSearchMessage | null;
}

// A text field set in a table's header band beside the HeaderSelect keys: a
// key of the same height, background and ruled edge, holding a search glyph,
// the text in the monospace, and a clear button while there is text. Escape
// clears it too. The key is edged in the accent while focused (the edge is
// its focus mark: a field is focused by every click into it, so the keys'
// ring would sit on it through all typing), in the error color while its
// message is an error, and the message stands on a small sheet under the
// key while the key is focused or hovered. The field keeps its own text so
// typing never waits on the URL round trip: the text goes out once typing
// has paused, and since the page echoes each text back through the URL a
// render late, which would reset a controlled input to the old text in
// between, the field remembers what it has sent, takes a value that comes
// back as the echo it is, and follows only a value set elsewhere (as the
// list page's NameSearch does). Every color follows the theme's mode.
export default function HeaderSearch({
  label,
  placeholder,
  value,
  onChange,
  message,
}: HeaderSearchProps) {
  const theme = useTheme();
  const messageId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState(value);
  // The texts sent and not yet echoed back, oldest first, and the pause
  // before the next one goes out.
  const sent = useRef<string[]>([]);
  const pause = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const echo = sent.current.indexOf(value);
    if (echo >= 0) {
      sent.current = sent.current.slice(echo + 1);
      return;
    }
    sent.current = [];
    clearTimeout(pause.current);
    setDraft(value);
  }, [value]);
  useEffect(() => () => clearTimeout(pause.current), []);
  const send = (text: string) => {
    sent.current.push(text);
    onChange(text);
  };
  const erring = message !== null && message.tone === "error";
  // The keys' frame, edged in the accent while focused, as a key with its
  // menu open is; in the error color, hovered or not, while the message is
  // an error.
  const key = headerKeyColors(theme, { open: focused });
  const frame = erring
    ? {
        ...key,
        edge: theme.palette.error.main,
        hoverEdge: theme.palette.error.main,
      }
    : key;
  const open = message !== null && (focused || hovered) && anchor !== null;
  const set = (next: string) => {
    setDraft(next);
    clearTimeout(pause.current);
    if (next === "") {
      send(next);
      return;
    }
    pause.current = setTimeout(() => send(next), SEARCH_PAUSE_MS);
  };
  return (
    <>
      {/* The tooltip on hover alone, and not while the message sheet is
          out: the label is the field's accessible name either way. */}
      <Tooltip
        title={label}
        enterDelay={400}
        disableFocusListener
        disableHoverListener={open}
      >
        <Box
          ref={setAnchor}
          component="span"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            height: HEADER_FILTER_SIZE,
            pl: 0.75,
            pr: 0.25,
            gap: 0.5,
            ...headerKeySx(theme, frame),
            // The text is read as text whatever the edge says.
            color: theme.palette.text.primary,
          }}
        >
          <SearchRoundedIcon
            sx={{
              fontSize: 16,
              color: erring ? "error.main" : "text.secondary",
            }}
          />
          <InputBase
            value={draft}
            onChange={(event) => set(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Escape" && draft !== "") {
                event.preventDefault();
                set("");
              }
            }}
            placeholder={placeholder}
            inputProps={{
              "aria-label": label,
              "aria-invalid": erring,
              "aria-describedby": message === null ? undefined : messageId,
              spellCheck: false,
              autoComplete: "off",
            }}
            // The band around it sets its labels small, bold and uppercase;
            // the hash is read as code.
            sx={{
              width: 112,
              fontFamily: MONOSPACE_FONT_FAMILY,
              fontSize: 12,
              lineHeight: 1,
              "& input": {
                p: 0,
                height: "auto",
                fontWeight: 400,
                letterSpacing: "normal",
                textTransform: "none",
              },
            }}
          />
          <IconButton
            size="small"
            aria-label="Clear the commit hash"
            onClick={() => set("")}
            sx={{ p: 0.25, visibility: draft === "" ? "hidden" : "visible" }}
          >
            <ClearRoundedIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Box>
      </Tooltip>
      <Popper
        open={open}
        anchorEl={anchor}
        placement="bottom-end"
        sx={{ zIndex: theme.zIndex.tooltip }}
        modifiers={[{ name: "offset", options: { offset: [0, 6] } }]}
      >
        <Paper
          id={messageId}
          role={erring ? "alert" : "status"}
          elevation={6}
          sx={{
            px: 1.25,
            py: 0.75,
            maxWidth: 360,
            fontSize: theme.typography.caption.fontSize,
            lineHeight: 1.5,
            color: erring ? "error.main" : "text.secondary",
          }}
        >
          {message?.text}
        </Paper>
      </Popper>
    </>
  );
}
