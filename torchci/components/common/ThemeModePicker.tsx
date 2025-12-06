import { Box } from "@mui/material";
import { ThemeMode, useDarkMode } from "lib/DarkModeContext";
import { useEffect, useState } from "react";
import { BsMoon, BsSun } from "react-icons/bs";
import { NavBarGroupDropdown, NavItem } from "../layout/NavBarGroupDropdown";
import styles from "./ThemeModePicker.module.css";

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

  const onClick = (e: React.MouseEvent, mode: ThemeMode) => {
    e.preventDefault();
    e.stopPropagation();
    setThemeMode(mode);
  };

  const DropDownItem = ({
    mode,
    icon,
    label,
  }: {
    mode: ThemeMode;
    icon: React.ReactNode;
    label: string;
  }): NavItem => {
    return {
      label: (
        <Box
          component="span"
          onClick={(e) => onClick(e, mode)}
          sx={{
            fontWeight: themeMode === mode ? 600 : 400,
            backgroundColor:
              themeMode === mode ? "rgba(107, 151, 201, 0.23)" : "transparent",
            display: "flex",
            gap: 1,
            alignItems: "center",
            width: "100%",
            color: "text.primary",
            borderRadius: 1,
            margin: "-6px 0px -6px 0px",
            padding: "6px 16px 6px 8px",
          }}
        >
          {icon} <span>{label}</span>
        </Box>
      ),
      route: "#",
      type: "item" as const,
    };
  };

  const themeItems = [
    DropDownItem({ mode: "light", icon: <BsSun size={16} />, label: "Light" }),
    DropDownItem({ mode: "dark", icon: <BsMoon size={16} />, label: "Dark" }),
    DropDownItem({
      mode: "system",
      icon: (
        <div className={styles.iconGroup}>
          <BsSun size={12} className={styles.sunIcon} />
          <BsMoon size={12} className={styles.moonIcon} />
        </div>
      ),
      label: "Use system setting",
    }),
  ];

  return (
    <NavBarGroupDropdown
      title={getIconComponent()}
      items={themeItems}
      showCarrot={false}
    />
  );
}
