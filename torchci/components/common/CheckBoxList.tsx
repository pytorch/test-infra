import {
  Button as _Button,
  Stack as _Stack,
  Checkbox,
  FormControlLabel,
  List,
  ListItem,
  TextField,
} from "@mui/material";
import { useState } from "react";

const Button = (props: any) => <_Button variant="contained" {...props} />;
const Stack = (props: any) => <_Stack spacing={2} {...props} />;

export default function CheckBoxList({
  items,
  onChange,
  onClick,
}: {
  items: { [key: string]: boolean };
  onChange: (value: { [key: string]: boolean }) => void;
  onClick: (value: string) => void;
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
        onChange={(e) => {
          setFilter(e.target.value);
        }}
      />
      <Stack direction="row">
        <Button
          onClick={() => {
            toggleAllfilteredItems(true);
          }}
        >
          Select All
        </Button>
        <Button
          onClick={() => {
            toggleAllfilteredItems(false);
          }}
        >
          Unselect All
        </Button>
      </Stack>
      <List dense>
        {filteredItems.map((item) => (
          <ListItem key={item}>
            <FormControlLabel
              control={<Checkbox checked={items[item]} />}
              label={item}
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
