import { ListItemIcon, MenuItem } from "@mui/material";
import { ThemeMode, useDarkMode } from "lib/DarkModeContext";
import { useEffect, useState } from "react";
import { BsMoon, BsSun } from "react-icons/bs";
import styles from "./ThemeModePicker.module.css";
import { HoverDropDownMenu } from "./common/HoverDropDownMenu";

export default function ThemeModePicker(): JSX.Element {
  const { themeMode, setThemeMode, darkMode } = useDarkMode();
  const [isMounted, setIsMounted] = useState(false);

  // This ensures hydration mismatch is avoided
  useEffect(() => {
    setIsMounted(true);
  }, []);

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
  };

  return (
    <HoverDropDownMenu title={getIconComponent()}>
      <MenuItem
        className={`${styles.option} ${
          themeMode === "light" ? styles.active : ""
        }`}
        onClick={() => handleThemeChange("light")}
      >
        <ListItemIcon>
          <BsSun size={16} />
        </ListItemIcon>
        Light
      </MenuItem>
      <MenuItem
        className={`${styles.option} ${
          themeMode === "dark" ? styles.active : ""
        }`}
        onClick={() => handleThemeChange("dark")}
      >
        <ListItemIcon>
          <BsMoon size={16} />
        </ListItemIcon>
        Dark
      </MenuItem>
      <MenuItem
        className={`${styles.option} ${
          themeMode === "system" ? styles.active : ""
        }`}
        onClick={() => handleThemeChange("system")}
      >
        <ListItemIcon>
          <div className={styles.iconGroup}>
            <BsSun size={12} className={styles.sunIcon} />
            <BsMoon size={12} className={styles.moonIcon} />
          </div>
        </ListItemIcon>
        Use system setting
      </MenuItem>
    </HoverDropDownMenu>
  );
}
