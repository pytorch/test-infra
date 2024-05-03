import { useEffect, useState } from "react";
import styles from "components/hud.module.css";

export function ParamSelector({
  value,
  handleSubmit,
}: {
  value: string;
  handleSubmit: (submission: string) => void;
}) {
  const [size, setSize] = useState(value?.length || 0);
  useEffect(() => {
    setSize(value?.length || 0);
  }, [value]);
  return (
    <form
      className={styles.branchForm}
      onSubmit={(e) => {
        e.preventDefault();
        // @ts-ignore
        handleSubmit(e.target[0].value);
      }}
      onChange={(e) => {
        // @ts-ignore
        setSize(e.target.value.length);
      }}
      onFocus={(e) => {
        e.target.select();
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
          setSize(value.length);
          // @ts-ignore
          e.target.blur();
        }
      }}
    >
      <input
        size={size}
        className={styles.branchFormInput}
        type="text"
        defaultValue={value}
      ></input>
    </form>
  );
}
