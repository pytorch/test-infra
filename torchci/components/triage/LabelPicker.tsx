import { Autocomplete, TextField } from "@mui/material";

// Picks the labels the page focuses on. Its URL (one `label` parameter per
// label) is what a maintainer bookmarks for the modules they look after.
export default function LabelPicker({
  options,
  selected,
  onChange,
}: {
  // Labels with issues in the current range; undefined while loading.
  options: string[] | undefined;
  selected: string[];
  onChange: (_labels: string[]) => void;
}) {
  // Keep labels from the URL selectable even if they have no issues in range.
  const allOptions = Array.from(
    new Set([...(options ?? []), ...selected])
  ).sort();
  return (
    <Autocomplete
      multiple
      size="small"
      sx={{ minWidth: 360, maxWidth: 900, flexGrow: 1 }}
      options={allOptions}
      loading={options === undefined}
      value={selected}
      onChange={(_e, value) => onChange(value)}
      filterSelectedOptions
      renderInput={(params) => (
        <TextField
          {...params}
          label="Labels"
          placeholder={
            selected.length === 0
              ? "Pick one or more labels to focus on, e.g. module: nn"
              : "Add a label"
          }
        />
      )}
    />
  );
}
