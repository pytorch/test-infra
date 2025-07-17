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
    <div style={{ margin: 0 }}>
      <span
        onClick={() => {
          setValue(!value);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <input
          type="checkbox"
          name={checkBoxName}
          checked={value}
          onChange={() => {}}
          style={{ margin: 0 }}
        />
        <label htmlFor={checkBoxName} style={{ margin: 0, cursor: "pointer" }}>
          {labelText}
        </label>
      </span>
    </div>
  );
}
