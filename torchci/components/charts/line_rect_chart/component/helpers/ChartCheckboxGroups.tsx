import CheckboxGroup, { CheckboxItem } from "./CheckboxGroup";

export default function ChartCheckboxGroups({
  groups,
  onChange,
}: {
  groups: {
    parentName: string;
    childGroup: CheckboxItem[];
  }[];
  onChange: (checked: CheckboxItem[]) => void;
}) {
  return (
    <div>
      {groups &&
        groups.map((item, index) => (
          <CheckboxGroup
            key={index}
            parentName={item.parentName}
            childGroup={item.childGroup}
            onChange={onChange}
          />
        ))}
    </div>
  );
}
