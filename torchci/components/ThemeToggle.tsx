import { useState, useEffect } from "react";

const ThemeToggle = () => {
  const [theme, setTheme] = useState(() => {
    if (typeof window !== "undefined") {
      const savedTheme = localStorage.getItem("theme");
      return savedTheme ? savedTheme : "system";
    }
    return "system";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      const root = document.documentElement;
      if (theme === "dark") {
        root.classList.add("dark");
        root.classList.remove("light");
      } else if (theme === "light") {
        root.classList.add("light");
        root.classList.remove("dark");
      } else {
        const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
          .matches
          ? "dark"
          : "light";
        root.classList.add(systemTheme);
        root.classList.remove(systemTheme === "dark" ? "light" : "dark");
      }
      localStorage.setItem("theme", theme);
    }
  }, [theme]);

  return (
    <div>
      <label>
        <input
          type="radio"
          name="theme"
          value="light"
          checked={theme === "light"}
          onChange={() => setTheme("light")}
        />
        Light
      </label>
      <label>
        <input
          type="radio"
          name="theme"
          value="dark"
          checked={theme === "dark"}
          onChange={() => setTheme("dark")}
        />
        Dark
      </label>
      <label>
        <input
          type="radio"
          name="theme"
          value="system"
          checked={theme === "system"}
          onChange={() => setTheme("system")}
        />
        System
      </label>
    </div>
  );
};

export default ThemeToggle;
