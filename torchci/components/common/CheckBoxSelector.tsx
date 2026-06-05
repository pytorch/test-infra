export default function CheckBoxSelector({
  value,
  setValue,
  checkBoxName,
  labelText,
  disabled = false,
  title,
}: {
  value: boolean;
  setValue: (_value: boolean) => void;
  checkBoxName: string;
  labelText: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div style={{ margin: 0 }}>
      <span
        onClick={() => {
          if (disabled) {
            return;
          }
          setValue(!value);
        }}
        title={title}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
          cursor: disabled ? "not-allowed" : "pointer",
          whiteSpace: "nowrap",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <input
          type="checkbox"
          name={checkBoxName}
          checked={value}
          disabled={disabled}
          onChange={() => {}}
          style={{ margin: 0, cursor: disabled ? "not-allowed" : "pointer" }}
        />
        <label
          htmlFor={checkBoxName}
          style={{
            margin: 0,
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          {labelText}
        </label>
      </span>
    </div>
  );
}
