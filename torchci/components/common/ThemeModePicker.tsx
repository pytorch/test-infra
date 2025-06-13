import { ThemeMode, useDarkMode } from "lib/DarkModeContext";
import { useEffect, useRef, useState } from "react";
import { BsMoon, BsSun } from "react-icons/bs";
import styles from "./ThemeModePicker.module.css";

export default function ThemeModePicker(): JSX.Element {
  const { themeMode, setThemeMode, darkMode } = useDarkMode();
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // This ensures hydration mismatch is avoided
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Handle click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    // Add event listener when dropdown is open
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    // Clean up event listener
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Don't render anything until client-side
  if (!isMounted) return <div className={styles.togglePlaceholder} />;

  // Get the icon component based on active theme
  const getIconComponent = () => {
    if (themeMode === "system") {
      const iconColor = darkMode ? "#E0E0E0" : "#212529";
      const Icon = darkMode ? BsMoon : BsSun;
      return <Icon size={18} color={iconColor} />;
    }
    const Icon = darkMode ? BsMoon : BsSun;
    return <Icon size={18} color={darkMode ? "#E0E0E0" : "#212529"} />;
  };

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
    setIsOpen(false);
  };

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={styles.toggleButton}
        title="Change theme"
        aria-label="Change theme"
      >
        {getIconComponent()}
      </button>

      {isOpen && (
        <div className={styles.dropdown}>
          <button
            className={`${styles.option} ${
              themeMode === "light" ? styles.active : ""
            }`}
            onClick={() => handleThemeChange("light")}
          >
            <BsSun size={16} /> <span>Light</span>
          </button>
          <button
            className={`${styles.option} ${
              themeMode === "dark" ? styles.active : ""
            }`}
            onClick={() => handleThemeChange("dark")}
          >
            <BsMoon size={16} /> <span>Dark</span>
          </button>
          <button
            className={`${styles.option} ${
              themeMode === "system" ? styles.active : ""
            }`}
            onClick={() => handleThemeChange("system")}
          >
            <div className={styles.iconGroup}>
              <BsSun size={12} className={styles.sunIcon} />
              <BsMoon size={12} className={styles.moonIcon} />
            </div>
            <span>Use system setting</span>
          </button>
        </div>
      )}
    </div>
  );
}
