import {
  Button as _Button,
  Stack as _Stack,
  Checkbox,
  FormControlLabel,
  List,
  ListItem,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";

const Button = (props: any) => <_Button variant="contained" {...props} />;
const Stack = (props: any) => <_Stack spacing={2} {...props} />;

interface CheckBoxListSx {
  filter?: any;
  button?: any;
  list?: any;
  itemCheckbox?: any;
  itemLabel?: any;
}

export default function CheckBoxList({
  items,
  onChange,
  onClick,
  sxConfig = {},
}: {
  items: { [key: string]: boolean };
  onChange: (value: { [key: string]: boolean }) => void;
  onClick: (value: string) => void;
  sxConfig?: CheckBoxListSx;
}) {
  // Creates a filter search box, two buttons to select all and unselect all,
  // and a list of checkboxes. Good for manual legends for charts
  const [filter, setFilter] = useState("");
  const filteredItems = Object.keys(items).filter((item) =>
    item.toLocaleLowerCase().includes(filter.toLocaleLowerCase())
  );

  function toggleAllfilteredItems(checked: boolean) {
    onChange({
      ...items,
      ...filteredItems.reduce((acc, item) => {
        acc[item] = checked;
        return acc;
      }, {} as any),
    });
  }

  return (
    <Stack>
      <TextField
        label="Filter"
        sx={sxConfig?.filter}
        onChange={(e) => {
          setFilter(e.target.value);
        }}
      />
      <Stack direction="row">
        <Button
          onClick={() => {
            toggleAllfilteredItems(true);
          }}
          sx={sxConfig?.button}
        >
          Select All
        </Button>
        <Button
          onClick={() => {
            toggleAllfilteredItems(false);
          }}
          sx={sxConfig?.button}
        >
          Unselect All
        </Button>
      </Stack>
      <List dense sx={sxConfig?.list}>
        {filteredItems.map((item) => (
          <ListItem key={item}>
            <FormControlLabel
              sx={{
                alignItems: "flex-start", // Align checkbox to top
                display: "flex",
                gap: "8px", // Control space between checkbox and label
                width: "100%", // Ensure label can wrap fully
              }}
              control={
                <Checkbox sx={sxConfig?.itemCheckbox} checked={items[item]} />
              }
              label={<Typography sx={sxConfig?.itemLabel}>{item}</Typography>}
              onChange={(e) => {
                onClick(item);
                onChange({
                  ...items,
                  // @ts-ignore
                  [item]: e.target.checked,
                });
              }}
            />
          </ListItem>
        ))}
      </List>
    </Stack>
  );
}
