import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Box, IconButton, InputBase, useTheme } from "@mui/material";
import {
  HEADER_FILTER_INSET,
  HEADER_FILTER_SIZE,
} from "components/tests/HeaderFilter";
import { headerKeyColors, headerKeySx } from "lib/tests/headerColors";
import {
  ChangeEvent,
  KeyboardEvent,
  MouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";

// The gap the grid sets between the items of a header's title row, the
// label and the sort arrow, in pixels.
const TITLE_ROW_GAP = 2;
// As much text as the API accepts.
export const NAME_SEARCH_MAX_LENGTH = 200;

export interface NameSearchProps {
  // The text searched for, or still being typed; empty for none.
  value: string;
  // Every keystroke and the clear button, with the whole text.
  onChange: (_text: string) => void;
  // Enter: search for the field's text now, without waiting for the pause.
  onSubmit: (_text: string) => void;
}

// The Name column's filter, in its header: a search field in the key style
// of the other headers' filters, a rounded square on the page's background
// with a ruled edge, holding a magnifier, the text, and a clear button once
// there is text. It fills the header after the label and the sort arrow,
// HEADER_FILTER_INSET from the arrow and from the header's edge (the header
// in TestsTable keeps the arrow's slot and pads its right edge by the inset).
// The edge and the magnifier take the accent color while the
// field has focus or text. What happens in the field stays in it: the
// header around it sorts on click and on Space and moves on the arrow keys,
// and must see none of that. The field keeps its own text: the page echoes
// each keystroke back through the grid's columns a render late, and a
// controlled input would be reset to the old text in between. So the field
// remembers what it has sent, takes a value that comes back as the echo it
// is, and follows only a value set elsewhere, by a clicked token, the clear
// button or the URL.
export default function NameSearch({
  value,
  onChange,
  onSubmit,
}: NameSearchProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  // The texts sent and not yet echoed back, oldest first.
  const sent = useRef<string[]>([]);
  useEffect(() => {
    const echo = sent.current.indexOf(value);
    if (echo >= 0) {
      sent.current = sent.current.slice(echo + 1);
      return;
    }
    sent.current = [];
    setDraft(value);
  }, [value]);
  const send = (text: string) => {
    sent.current.push(text);
    setDraft(text);
    onChange(text);
  };
  const active = focused || draft !== "";
  const accent = theme.palette.primary.main;
  // The keys' frame, edged in the accent while the field has focus or text,
  // as a key with its menu open is; the text keeps its own color.
  const { color: _keyColor, ...frame } = headerKeySx(
    theme,
    headerKeyColors(theme, { open: active })
  );
  const keep = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();
  return (
    <Box
      component="span"
      onClick={keep}
      onMouseDown={keep}
      onKeyDown={keep}
      sx={{
        // An item of the header's title row, after the sort arrow, taking
        // the width the label and the arrow leave; the row's own gap counts
        // toward the inset.
        order: 1,
        flex: "1 1 auto",
        minWidth: 0,
        ml: `${HEADER_FILTER_INSET - TITLE_ROW_GAP}px`,
        display: "inline-flex",
        alignItems: "center",
        boxSizing: "border-box",
        height: HEADER_FILTER_SIZE,
        pl: "6px",
        pr: "2px",
        ...frame,
      }}
    >
      <SearchRoundedIcon
        aria-hidden
        sx={{
          fontSize: 16,
          flex: "none",
          mr: "4px",
          color: active ? accent : "text.secondary",
        }}
      />
      <InputBase
        value={draft}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          send(event.target.value)
        }
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key === "Enter") {
            // The field's own text, from the input the key was typed in:
            // the header may not have re-rendered with the last keystroke
            // yet, and the handler's own element is the field, not the
            // input.
            onSubmit((event.target as HTMLInputElement).value);
          } else if (event.key === "Escape" && draft !== "") {
            send("");
          }
        }}
        placeholder="Search names"
        inputProps={{
          "aria-label": "Search names",
          maxLength: NAME_SEARCH_MAX_LENGTH,
          spellCheck: false,
          autoComplete: "off",
          autoCorrect: "off",
          autoCapitalize: "off",
        }}
        sx={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          font: "inherit",
          fontSize: "0.8125rem",
          fontWeight: 400,
          letterSpacing: 0,
          textTransform: "none",
          color: "text.primary",
          "& input": {
            p: 0,
            height: "100%",
            "&::placeholder": {
              color: theme.palette.text.secondary,
              opacity: 1,
            },
          },
        }}
      />
      {draft !== "" && (
        <IconButton
          size="small"
          aria-label="Clear search"
          onClick={() => send("")}
          sx={{ p: "2px", flex: "none", color: "text.secondary" }}
        >
          <CloseRoundedIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
    </Box>
  );
}
