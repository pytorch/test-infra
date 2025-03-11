import { useDarkMode } from "lib/DarkModeContext";
import { BsSun, BsMoon } from "react-icons/bs";
import styles from "./DarkModeToggle.module.css";

export default function DarkModeToggle(): JSX.Element {
  const { darkMode, toggleDarkMode } = useDarkMode();

  return (
    <button
      onClick={toggleDarkMode}
      className={styles.toggleButton}
      title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={darkMode ? "Switch to light mode" : "Switch to dark mode"}
    >
      {darkMode ? <BsSun /> : <BsMoon />}
    </button>
  );
}