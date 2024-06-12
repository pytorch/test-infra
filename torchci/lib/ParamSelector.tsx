import { useEffect, useState } from "react";
import styles from "components/hud.module.css";

export function ParamSelector({
  value,
  handleSubmit,
}: {
  value: string;
  handleSubmit: (submission: string) => void;
}) {
  const [val, setVal] = useState(value || "");
  useEffect(() => {
    setVal(value || "");
  }, [value]);
  return (
    <form
      className={styles.branchForm}
      onSubmit={(e) => {
        e.preventDefault();
        // @ts-ignore
        handleSubmit(e.target[0].value);
      }}
    >
      <input
        onChange={(e) => {
          // @ts-ignore
          setVal(e.target.value);
        }}
        onFocus={(e) => {
          e.target.select();
          console.log(e.target.value);
        }}
        onBlur={(e) => {
          if (e.target.value !== value && e.target.value.length > 0) {
            e.preventDefault();
            handleSubmit(e.target.value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            // @ts-ignore
            e.target.value = value;
            setVal(value);
            // @ts-ignore
            e.target.blur();
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
