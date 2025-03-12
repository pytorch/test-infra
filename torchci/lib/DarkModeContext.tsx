import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type DarkModeContextType = {
  darkMode: boolean;
  toggleDarkMode: () => void;
};

const DarkModeContext = createContext<DarkModeContextType | undefined>(undefined);

export function DarkModeProvider({ children }: { children: ReactNode }) {
  // Initialize state with undefined to avoid hydration mismatch
  const [darkMode, setDarkMode] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    // On mount, read the preference from localStorage
    const savedDarkMode = localStorage.getItem('darkMode');
    setDarkMode(savedDarkMode === 'true');
  }, []);

  useEffect(() => {
    // Only run after initial mount when darkMode is defined
    if (darkMode === undefined) return;
    
    // Apply or remove the dark class based on the darkMode state
    if (darkMode) {
      document.documentElement.classList.add('dark-mode');
    } else {
      document.documentElement.classList.remove('dark-mode');
    }
    
    // Save the preference to localStorage
    localStorage.setItem('darkMode', darkMode.toString());
    
    // Dispatch event for chart theme changes
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('dark-mode-changed', { 
        detail: { darkMode } 
      });
      window.dispatchEvent(event);
    }
  }, [darkMode]);

  const toggleDarkMode = () => {
    setDarkMode(prevMode => !prevMode);
  };

  return (
    <DarkModeContext.Provider value={{ darkMode: !!darkMode, toggleDarkMode }}>
      {children}
    </DarkModeContext.Provider>
  );
}

export function useDarkMode() {
  const context = useContext(DarkModeContext);
  if (context === undefined) {
    throw new Error('useDarkMode must be used within a DarkModeProvider');
  }
  return context;
}