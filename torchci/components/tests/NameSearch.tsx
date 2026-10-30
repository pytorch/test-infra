import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import { Box, IconButton, InputBase, useTheme } from "@mui/material";
import {
  HEADER_FILTER_INSET,
  HEADER_FILTER_SIZE,
} from "components/tests/HeaderFilter";
import {
  NAME_FILTER_TITLES,
  NAME_FILTERS,
  NameFilter,
  NameFilterValues,
} from "lib/tests/facets";
import {
  headerBandColor,
  headerKeyColors,
  headerKeySx,
} from "lib/tests/headerColors";
import { NAME_FILTER_ROW_HEIGHT } from "lib/tests/layout";
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
// The key's edge, which its two rows sit inside.
const FRAME_EDGE = 1;
// A chip's height on its row and its line box, tall enough for the
// descenders and underscores of a name, in pixels; with the air under a row
// (CHIP_ROW_GAP) a row is NAME_FILTER_ROW_HEIGHT. A chip is as wide as its
// text and the chips wrap onto as many rows as they need; only a value wider
// than the whole field is cut with an ellipsis, whole in the chip's title.
const CHIP_HEIGHT = 18;
const CHIP_LINE_HEIGHT = "16px";
const CHIP_ROW_GAP = NAME_FILTER_ROW_HEIGHT - CHIP_HEIGHT;

export interface NameSearchProps {
  // The text searched for, or still being typed; empty for none.
  value: string;
  // Every keystroke and the clear button, with the whole text.
  onChange: (_text: string) => void;
  // Enter: search for the field's text now, without waiting for the pause.
  onSubmit: (_text: string) => void;
  // The exact filters on the test's name the URL carries, each shown as a
  // chip on the rows beneath the text; none when undefined.
  filters?: NameFilterValues;
  // A chip's remove button: the filter and the value to take out of the URL.
  onRemoveFilter?: (_name: NameFilter, _value: string) => void;
  // How much taller than a key (HEADER_FILTER_SIZE) the field is, holding
  // its rows of chips, each time that changes; 0 without chips. The table
  // grows its header band by it.
  onExtraHeightChange?: (_pixels: number) => void;
}

interface NameFilterChipProps {
  name: NameFilter;
  value: string;
  onRemove?: (_name: NameFilter, _value: string) => void;
}

// One exact filter on the test's name as the URL carries it (file=, suite=,
// case_name= or declared_case_name=), as a chip on the search field's rows
// beneath the text: the filter's title muted, the value, and a button that
// takes the filter out of the URL. No menu sets these; a link does, the
// API's hud_url for one, and the chip shows what the link asked for. The
// chip is a pill in the band's grey, the grey of the title's pills and the
// view chips.
function NameFilterChip({ name, value, onRemove }: NameFilterChipProps) {
  const theme = useTheme();
  const title = NAME_FILTER_TITLES[name];
  const word = title.toLowerCase();
  return (
    <Box
      component="span"
      title={`${title}: ${value}`}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        flex: "0 1 auto",
        minWidth: 0,
        maxWidth: "100%",
        height: CHIP_HEIGHT,
        pl: "7px",
        pr: onRemove === undefined ? "7px" : "1px",
        borderRadius: "999px",
        backgroundColor: headerBandColor(theme),
        font: "inherit",
        fontSize: "0.75rem",
        fontWeight: 400,
        letterSpacing: 0,
        textTransform: "none",
        lineHeight: CHIP_LINE_HEIGHT,
        whiteSpace: "nowrap",
        color: "text.primary",
      }}
    >
      <Box
        component="span"
        sx={{ color: "text.secondary", mr: "4px", flex: "none" }}
      >
        {word}
      </Box>
      <Box
        component="span"
        sx={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          lineHeight: CHIP_LINE_HEIGHT,
        }}
      >
        {value}
      </Box>
      {onRemove !== undefined && (
        <IconButton
          size="small"
          aria-label={`Remove ${word} filter ${value}`}
          onClick={() => onRemove(name, value)}
          sx={{ p: "1px", ml: "2px", flex: "none", color: "text.secondary" }}
        >
          <CloseRoundedIcon sx={{ fontSize: 12 }} />
        </IconButton>
      )}
    </Box>
  );
}

// The Name column's filter, in its header: a search field in the key style
// of the other headers' filters, a rounded square on the page's background
// with a ruled edge, holding a magnifier, the text, and a clear button once
// there is text. While the URL carries exact name filters the field has
// rows beneath the text, a chip for each, wrapping as they need; the field
// measures how much taller than a key that makes it (a ResizeObserver on
// its frame) and tells the table, whose header band grows by it
// (columnHeaderHeightFor in lib/tests/table.ts). The field fills the
// header after the label and the sort arrow, HEADER_FILTER_INSET from the
// arrow and from the header's edge
// (the header in TestsTable keeps the arrow's slot and pads its right edge
// by the inset). The edge and the magnifier take the accent color while the
// field has focus, text or a chip. What happens in the field stays in it:
// the header around it sorts on click and on Space and moves on the arrow
// keys, and must see none of that. The field keeps its own text: the page
// echoes each keystroke back through the grid's columns a render late, and
// a controlled input would be reset to the old text in between. So the
// field remembers what it has sent, takes a value that comes back as the
// echo it is, and follows only a value set elsewhere, by a clicked token,
// the clear button or the URL.
export default function NameSearch({
  value,
  onChange,
  onSubmit,
  filters,
  onRemoveFilter,
  onExtraHeightChange,
}: NameSearchProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState(value);
  const frame = useRef<HTMLSpanElement>(null);
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
  const chips =
    filters === undefined
      ? []
      : NAME_FILTERS.flatMap((name) =>
          filters[name].map((filterValue) => ({ name, value: filterValue }))
        );
  const active = focused || draft !== "" || chips.length > 0;
  // The field's height past a key's, as its rows of chips wrap: measured,
  // since how the chips wrap depends on their text and the column's width,
  // and reported whenever it changes; nothing to measure without chips.
  const hasChips = chips.length > 0;
  useEffect(() => {
    if (onExtraHeightChange === undefined) return;
    if (!hasChips || frame.current === null) {
      onExtraHeightChange(0);
      return;
    }
    const element = frame.current;
    const report = () =>
      onExtraHeightChange(
        Math.max(0, element.offsetHeight - HEADER_FILTER_SIZE)
      );
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasChips, onExtraHeightChange]);
  const accent = theme.palette.primary.main;
  // The keys' frame, edged in the accent while the field has focus, text or
  // a chip, as a key with its menu open is; the text keeps its own color.
  const { color: _keyColor, ...frameSx } = headerKeySx(
    theme,
    headerKeyColors(theme, { open: active })
  );
  const keep = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();
  return (
    <Box
      component="span"
      ref={frame}
      onClick={keep}
      onMouseDown={keep}
      onKeyDown={keep}
      sx={{
        // An item of the header's title row, after the sort arrow, taking
        // the width the label and the arrow leave; the row's own gap counts
        // toward the inset. As tall as a key, plus its rows of chips.
        order: 1,
        flex: "1 1 auto",
        minWidth: 0,
        ml: `${HEADER_FILTER_INSET - TITLE_ROW_GAP}px`,
        display: "inline-flex",
        flexDirection: "column",
        boxSizing: "border-box",
        minHeight: HEADER_FILTER_SIZE,
        overflow: "hidden",
        ...frameSx,
      }}
    >
      <Box
        component="span"
        sx={{
          display: "flex",
          alignItems: "center",
          height: HEADER_FILTER_SIZE - 2 * FRAME_EDGE,
          pl: "6px",
          pr: "2px",
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
      {hasChips && (
        <Box
          component="span"
          sx={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            gap: `${CHIP_ROW_GAP}px`,
            px: "4px",
            pb: `${CHIP_ROW_GAP}px`,
          }}
        >
          {chips.map((chip) => (
            <NameFilterChip
              key={`${chip.name}=${chip.value}`}
              name={chip.name}
              value={chip.value}
              onRemove={onRemoveFilter}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
