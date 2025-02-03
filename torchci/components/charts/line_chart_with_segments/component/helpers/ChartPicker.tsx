import Paper from "@mui/material/Paper";
import { styled } from "@mui/material/styles";
import CheckboxGroup, { CheckboxItem } from "./CheckboxGroup";

const Item = styled(Paper)(({ theme }) => ({
  backgroundColor: "#fff",
  ...theme.typography.body2,
  padding: theme.spacing(1),
  color: theme.palette.text.secondary,
  ...theme.applyStyles("dark", {
    backgroundColor: "#1A2027",
  }),
}));

export default function ChartPicker({
  nestCheckboxes,
  onChange,
}: {
  nestCheckboxes: {
    parentName: string;
    childGroup: CheckboxItem[];
  }[];
  onChange: (checked: CheckboxItem[]) => void;
}) {
  return (
    <Item>
      {nestCheckboxes &&
        nestCheckboxes.map((item, index) => (
          <CheckboxGroup
            key={index}
            parentName={item.parentName}
            childGroup={item.childGroup}
            onChange={onChange}
          />
        ))}
    </Item>
  );
}
