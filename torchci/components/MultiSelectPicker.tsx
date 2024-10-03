// a component that has a list of options and allows the user to select multiple options, with a 'select all' and 'clear' button.

import {
  Button,
  Checkbox,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
} from "@mui/material";
import { useState } from "react";

export default function MultiSelectPicker({
  selected,
  setSelected,
  options,
  label,
}: {
  selected: string[];
  setSelected: any;
  options: string[];
  label: string;
}) {
  var [selectedItems, setSelectedItems] = useState(selected);

  function handleChange(e: SelectChangeEvent<string[]>) {
    const newList = e.target.value;

    console.log(`newList: ${newList}`);

    // if the last item is empty, a button was pressed and we skip the update
    if (newList.length > 0 && !newList[newList.length - 1]) {
      return;
    }
    // if newList is a string, skip the update
    if (typeof newList === "string") {
      console.log("newList is a string - skipping update");
      return;
    }
    setSelectedItems(newList);
    setSelected(newList);
    // }
  }

  function selectAll() {
    setSelectedItems(options);
    setSelected(options);
  }

  function clear() {
    setSelectedItems([]);
    setSelected([]);
  }

  function generateOptions() {
    var entries = options.map((option) => (
      <MenuItem key={option} value={option}>
        <Checkbox checked={selectedItems.indexOf(option) > -1} />
        {option}
      </MenuItem>
    ));

    // Add the select all and clear buttons to the top
    entries.unshift(
      <MenuItem key="select-all" onClick={selectAll}>
        <Button>Select All</Button>
      </MenuItem>
    );
    entries.unshift(
      <MenuItem key="clear" onClick={clear}>
        <Button>Clear</Button>
      </MenuItem>
    );

    return entries;
  }

  return (
    <>
      <FormControl>
        <InputLabel id="multi-select-picker-input-label">{label}</InputLabel>
        <Select
          multiple={true}
          value={selectedItems}
          label={label}
          labelId={`multi-select-picker-select-label-${label}`}
          onChange={handleChange}
          id={`multi-select-picker-select-${label}`}
          renderValue={() => {
            if (selectedItems.length == options.length) return "All";
            if (selectedItems.length == 0) return "None";

            var selected_str = selectedItems
              .map((item: string) => item?.split("/")[1])
              .join(",");
            if (selected_str.length > 20)
              return selected_str.substring(0, 20) + "...";
            return selected_str;
          }}
        >
          {generateOptions()}
        </Select>
      </FormControl>
    </>
  );
}
