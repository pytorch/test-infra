import { useEffect, useState } from "react";
import styles from "components/hud.module.css";

export function handleSubmitURL(
  e: React.FormEvent<HTMLFormElement>,
  getNewUrl: (submission: string) => string
) {
  e.preventDefault();
  // @ts-ignore
  const submission = e.target[0].value;
  window.location.href = getNewUrl(submission);
}

export function ParamSelector({
  value,
  handleSubmit,
}: {
  value: string;
  handleSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  const [size, setSize] = useState(value?.length || 0);
  useEffect(() => {
    setSize(value?.length || 0);
  }, [value]);
  return (
    <form
      className={styles.branchForm}
      onSubmit={handleSubmit}
      onChange={(e) => {
        // @ts-ignore
        setSize(e.target.value.length);
      }}
      onFocus={(e) => {
        e.target.select();
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
