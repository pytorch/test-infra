import { useDarkMode } from "lib/DarkModeContext";
import { BsSun, BsMoon } from "react-icons/bs";
import styles from "./DarkModeToggle.module.css";
import { useEffect, useState } from "react";

export default function DarkModeToggle(): JSX.Element {
  const { darkMode, toggleDarkMode } = useDarkMode();
  const [isMounted, setIsMounted] = useState(false);
  
  // This ensures hydration mismatch is avoided
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Don't render anything until client-side
  if (!isMounted) return <div className={styles.togglePlaceholder} />;

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