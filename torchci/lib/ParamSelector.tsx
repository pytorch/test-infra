import styles from "components/hud.module.css";
import { useEffect, useState } from "react";

export function ParamSelector({
  value,
  handleSubmit,
}: {
  value: string;
  handleSubmit: (_submission: string) => void;
}) {
  const [val, setVal] = useState(value || "");
  useEffect(() => {
    setVal(value || "");
  }, [value]);
  return (
    <form
      className={styles.branchForm}
      onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget;
        const input = form.querySelector(
          'input[type="text"]'
        ) as HTMLInputElement;
        if (input) {
          handleSubmit(input.value);
        }
      }}
    >
      <input
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          setVal(e.target.value);
        }}
        onFocus={(e: React.FocusEvent<HTMLInputElement>) => {
          e.target.select();
        }}
        onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
          if (e.target.value !== value && e.target.value.length > 0) {
            e.preventDefault();
            handleSubmit(e.target.value);
          }
        }}
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Escape") {
            e.preventDefault();
            const input = e.currentTarget;
            input.value = value;
            setVal(value);
            input.blur();
          }
        }}
        size={val.length || 0}
        className={styles.branchFormInput}
        type="text"
        value={val}
      ></input>
    </form>
  );
}
