import { createTheme } from "@mui/material/styles";
import { useEffect, useState } from "react";
import { useDarkMode } from "../lib/DarkModeContext";

// Create a theme instance for light and dark mode
export function useAppTheme() {
  const { darkMode } = useDarkMode();
  const [theme, setTheme] = useState(
    createTheme({
      palette: {
        mode: "light",
      },
    })
  );

  useEffect(() => {
    // Update theme when darkMode changes
    setTheme(
      createTheme({
        palette: {
          mode: darkMode ? "dark" : "light",
          ...(darkMode
            ? {
                // Dark mode specific colors
                background: {
                  default: "#1E1E1E",
                  paper: "#2A2A2A",
                },
                text: {
                  primary: "#E0E0E0",
                  secondary: "#AAAAAA",
                },
                primary: {
                  main: "#4A90E2",
                },
                divider: "#3A3A3A",
              }
            : {
                // Light mode colors - default theme
              }),
        },
        components: {
          MuiPaper: {
            styleOverrides: {
              root: {
                backgroundColor: darkMode ? "#2A2A2A" : "#ffffff",
                color: darkMode ? "#E0E0E0" : "inherit",
              },
            },
          },
          MuiInputBase: {
            styleOverrides: {
              root: {
                backgroundColor: darkMode ? "#2A2A2A" : "inherit",
                color: darkMode ? "#E0E0E0" : "inherit",
              },
            },
          },
          MuiSelect: {
            styleOverrides: {
              root: {
                backgroundColor: darkMode ? "#2A2A2A" : "inherit",
                color: darkMode ? "#E0E0E0" : "inherit",
                "& .MuiOutlinedInput-notchedOutline": {
                  borderColor: darkMode ? "#3A3A3A" : "inherit",
                },
                "&:hover .MuiOutlinedInput-notchedOutline": {
                  borderColor: darkMode ? "#4A90E2" : "inherit",
                },
              },
            },
          },
          MuiTooltip: {
            styleOverrides: {
              tooltip: {
                backgroundColor: darkMode ? "#3A3A3A" : "#E0E0E0",
                color: darkMode ? "#E0E0E0" : "#212529",
                border: darkMode ? "1px solid #3A3A3A" : "1px solid #E1E1E1",
              },
              arrow: {
                color: darkMode ? "#3A3A3A" : "#E0E0E0",
              },
            },
          },
        },
      })
    );
  }, [darkMode]);

  return theme;
}
