import { ListItemText, Menu, MenuItem } from "@mui/material";
import CheckMenuItem from "components/tests/CheckMenuItem";
import InlinePill from "components/tests/InlinePill";
import { useId, useState } from "react";

export interface InlineSelectOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

interface InlineSelectCommonProps<Value extends string> {
  // What the control chooses, for assistive technology: "Window".
  label: string;
  // What the pill shows: the choice phrased for the sentence around it.
  display: string;
  options: readonly InlineSelectOption<Value>[];
}

export type InlineSelectProps<Value extends string> =
  InlineSelectCommonProps<Value> &
    (
      | { multiple?: false; value: Value; onChange: (_value: Value) => void }
      | {
          multiple: true;
          value: readonly Value[];
          onChange: (_value: Value[]) => void;
        }
    );

// A choice inside running text: a pill (InlinePill) that opens a menu of one
// list. A single choice closes the menu; several, set as the headers' menus
// set theirs (CheckMenuItem), keep it open until the reader is done.
export default function InlineSelect<Value extends string>(
  props: InlineSelectProps<Value>
) {
  const { label, display, options } = props;
  const menuId = useId();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const open = anchor !== null;

  const isChosen = (value: Value) =>
    props.multiple ? props.value.includes(value) : props.value === value;

  const choose = (value: Value) => {
    if (props.multiple) {
      props.onChange(
        props.value.includes(value)
          ? props.value.filter((chosen) => chosen !== value)
          : [...props.value, value]
      );
    } else {
      props.onChange(value);
      setAnchor(null);
    }
  };

  return (
    <>
      <InlinePill
        label={label}
        display={display}
        menuId={menuId}
        open={open}
        onOpen={setAnchor}
      />
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        slotProps={{ paper: { sx: { mt: 0.5, minWidth: 180 } } }}
      >
        {options.map((option) =>
          props.multiple ? (
            <CheckMenuItem
              key={option.value}
              checked={isChosen(option.value)}
              label={option.label}
              disabled={option.disabled}
              onClick={() => choose(option.value)}
            />
          ) : (
            <MenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={isChosen(option.value)}
              selected={isChosen(option.value)}
              disabled={option.disabled}
              onClick={() => choose(option.value)}
            >
              <ListItemText primary={option.label} />
            </MenuItem>
          )
        )}
      </Menu>
    </>
  );
}
