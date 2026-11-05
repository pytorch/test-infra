import { ButtonBase, InputBase, Tooltip, useTheme } from "@mui/material";
import { rateLabel } from "lib/tests/cost/query";
import { MAX_RATE } from "lib/tests/cost/rates";
import { useRef, useState } from "react";

export interface RateCellProps {
  // The runner's price key, for assistive technology.
  runner: string;
  rate: number | null;
  // The file's rate before the page's edits, when an edit changed it.
  was?: number | null;
  edited: boolean;
  onChange: (_rate: number | null) => void;
}

// A number the reader typed as a rate: "0.65", "$0.65" or blank for none;
// undefined when it is not one.
function typedRate(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, "").replace(/\/h$/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= MAX_RATE ? n : undefined;
}

// A runner's $/h in the machine key, editable in place: a click (or Enter)
// turns it into a field, Enter or leaving it applies, Escape cancels, and a
// blank field leaves the runner without a rate. An edited rate is in the
// accent, the file's in the tooltip. The field is no form's and has no name,
// so the browser neither submits nor remembers what is typed; the edit lives
// in the page's memory with the rest of the rates (rates.ts).
export default function RateCell({
  runner,
  rate,
  was,
  edited,
  onChange,
}: RateCellProps) {
  const theme = useTheme();
  const [text, setText] = useState<string | null>(null);
  // Set once the field is applied or cancelled, so the blur of its leaving
  // does neither again.
  const done = useRef(false);
  // Enter or Escape gives the focus back to the rate, as a dialog does.
  const refocus = useRef(false);
  const shown = rate === null ? "—" : rateLabel(rate);
  if (text === null) {
    return (
      <ButtonBase
        component="span"
        disableRipple
        ref={(el: HTMLElement | null) => {
          if (el !== null && refocus.current) {
            refocus.current = false;
            el.focus();
          }
        }}
        aria-label={`Edit ${runner}'s $ per runner-hour: ${
          rate === null ? "no rate" : rateLabel(rate)
        }`}
        title={
          edited
            ? `Edited (file: ${
                was === null || was === undefined ? "no rate" : rateLabel(was)
              }). Click to edit.`
            : "Click to edit"
        }
        onClick={(event) => {
          event.stopPropagation();
          done.current = false;
          setText(rate === null ? "" : String(rate));
        }}
        sx={{
          justifyContent: "flex-end",
          width: "100%",
          font: "inherit",
          fontVariantNumeric: "tabular-nums",
          color: edited ? "primary.main" : "inherit",
          fontWeight: edited ? 600 : "inherit",
          borderRadius: "2px",
          "&:hover, &.Mui-focusVisible": {
            textDecoration: "underline dotted",
            textUnderlineOffset: "3px",
            color: "text.primary",
          },
          "&.Mui-focusVisible": {
            outline: `2px solid ${theme.palette.primary.main}`,
          },
        }}
      >
        {shown}
      </ButtonBase>
    );
  }
  const typed = typedRate(text);
  const close = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit && typed !== undefined && typed !== rate) onChange(typed);
    setText(null);
  };
  // While what is typed is no rate, a hint above the field says what is.
  return (
    <Tooltip
      open={typed === undefined}
      title="A number from 0 to 100,000, or blank for no rate"
      placement="top"
      arrow
      describeChild
    >
      <InputBase
        autoFocus
        value={text}
        placeholder="$/h"
        error={typed === undefined}
        onChange={(event) => setText(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onBlur={() => close(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (typed !== undefined) {
              refocus.current = true;
              close(true);
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            refocus.current = true;
            close(false);
          }
        }}
        inputProps={{
          "aria-label": `${runner}'s $ per runner-hour; blank for no rate`,
          autoComplete: "off",
          spellCheck: false,
          inputMode: "decimal",
        }}
        sx={{
          width: "100%",
          font: "inherit",
          "& input": {
            p: "0 3px",
            height: 18,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            borderRadius: "3px",
            backgroundColor: "background.paper",
            boxShadow: `inset 0 0 0 1px ${
              typed === undefined
                ? theme.palette.error.main
                : theme.palette.primary.main
            }`,
          },
        }}
      />
    </Tooltip>
  );
}
