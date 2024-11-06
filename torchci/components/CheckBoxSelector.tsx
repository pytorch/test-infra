export default function CheckBoxSelector({
  value,
  setValue,
  checkBoxName,
  labelText,
}: {
  value: boolean;
  setValue: (_value: boolean) => void;
  checkBoxName: string;
  labelText: string;
}) {
  return (
    <div>
      <span
        onClick={() => {
          setValue(!value);
        }}
      >
        <input
          type="checkbox"
          name={checkBoxName}
          checked={value}
          onChange={() => {}}
        />
        <label htmlFor={checkBoxName}> {labelText}</label>
      </span>
    </div>
  );
}
