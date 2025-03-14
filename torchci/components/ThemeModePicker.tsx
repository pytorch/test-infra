import { ThemeMode, useDarkMode } from "lib/DarkModeContext";
import { useEffect, useState } from "react";
import { BsMoon, BsSun } from "react-icons/bs";
import styles from "./ThemeModePicker.module.css";

export default function ThemeModePicker(): JSX.Element {
  const { themeMode, setThemeMode, darkMode } = useDarkMode();
  const [isMounted, setIsMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  // This ensures hydration mismatch is avoided
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Don't render anything until client-side
  if (!isMounted) return <div className={styles.togglePlaceholder} />;

  // Get the icon component based on active theme
  const getIconComponent = () => {
    if (themeMode === ThemeMode.System) {
      const iconColor = darkMode ? "#E0E0E0" : "#212529";
      return (
        <div className={styles.iconGroup} style={{ width: 18, height: 18 }}>
          <BsSun size={14} color={iconColor} className={styles.sunIcon} />
          <BsMoon size={14} color={iconColor} className={styles.moonIcon} />
        </div>
      );
    }
    const Icon = darkMode ? BsMoon : BsSun;
    return <Icon size={18} color={darkMode ? "#E0E0E0" : "#212529"} />;
  };

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
    setIsOpen(false);
  };

  return (
    <div className={styles.container}>
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
              themeMode === ThemeMode.Light ? styles.active : ""
            }`}
            onClick={() => handleThemeChange(ThemeMode.Light)}
          >
            <BsSun size={16} /> <span>Light</span>
          </button>
          <button
            className={`${styles.option} ${
              themeMode === ThemeMode.Dark ? styles.active : ""
            }`}
            onClick={() => handleThemeChange(ThemeMode.Dark)}
          >
            <BsMoon size={16} /> <span>Dark</span>
          </button>
          <button
            className={`${styles.option} ${
              themeMode === ThemeMode.System ? styles.active : ""
            }`}
            onClick={() => handleThemeChange(ThemeMode.System)}
          >
            <div className={styles.iconGroup}>
              <BsSun size={12} className={styles.sunIcon} />
              <BsMoon size={12} className={styles.moonIcon} />
            </div>
            <span>System</span>
          </button>
        </div>
      )}
    </div>
  );
}
