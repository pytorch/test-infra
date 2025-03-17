import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

// Theme mode options
export type ThemeMode = "light" | "dark" | "system";

type DarkModeContextType = {
  themeMode: ThemeMode;
  darkMode: boolean;
  setThemeMode: (mode: ThemeMode) => void;
};

const DarkModeContext = createContext<DarkModeContextType | undefined>(
  undefined
);

export function DarkModeProvider({ children }: { children: ReactNode }) {
  // Initialize with a function to prevent execution during SSR
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    // Only run in browser context
    if (typeof window !== "undefined") {
      const savedThemeMode = localStorage.getItem(
        "themeMode"
      ) as ThemeMode | null;
      if (
        savedThemeMode &&
        ["light", "dark", "system"].includes(savedThemeMode)
      ) {
        return savedThemeMode;
      }
    }
    return "system";
  });

  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [systemDarkMode, setSystemDarkMode] = useState<boolean>(false);

  // Check for system dark mode preference
  useEffect(() => {
    if (typeof window !== "undefined") {
      // Check if system prefers dark mode
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      setSystemDarkMode(mediaQuery.matches);

      // Listen for changes to the system dark mode preference
      const handler = (e: MediaQueryListEvent) => {
        setSystemDarkMode(e.matches);
      };
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, []);

  // Update darkMode based on themeMode and system preference
  useEffect(() => {
    if (themeMode === "system") {
      setDarkMode(systemDarkMode);
    } else {
      setDarkMode(themeMode === "dark");
    }
  }, [themeMode, systemDarkMode]);

  // Apply dark mode class and save preference
  useEffect(() => {
    // Apply or remove the dark class based on the darkMode state
    if (darkMode) {
      document.documentElement.classList.add("dark-mode");
    } else {
      document.documentElement.classList.remove("dark-mode");
    }

    // Save the preference to localStorage
    if (typeof window !== "undefined") {
      localStorage.setItem("themeMode", themeMode);
    }
  }, [darkMode, themeMode]);

  const handleSetThemeMode = (mode: ThemeMode) => {
    setThemeMode(mode);
  };

  return (
    <DarkModeContext.Provider
      value={{
        themeMode,
        darkMode,
        setThemeMode: handleSetThemeMode,
      }}
    >
      {children}
    </DarkModeContext.Provider>
  );
}

export function useDarkMode() {
  const context = useContext(DarkModeContext);
  if (context === undefined) {
    throw new Error("useDarkMode must be used within a DarkModeProvider");
  }
  return context;
}
