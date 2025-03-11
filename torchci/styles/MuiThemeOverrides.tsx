import { createTheme } from '@mui/material/styles';
import { useEffect, useState } from 'react';
import { useDarkMode } from '../lib/DarkModeContext';

// Create a theme instance for light and dark mode
export function useAppTheme() {
  const { darkMode } = useDarkMode();
  const [theme, setTheme] = useState(createTheme({
    palette: {
      mode: 'light',
    },
  }));

  useEffect(() => {
    // Update theme when darkMode changes
    setTheme(createTheme({
      palette: {
        mode: darkMode ? 'dark' : 'light',
        ...(darkMode ? {
          // Dark mode specific colors
          background: {
            default: '#1E1E1E',
            paper: '#2A2A2A',
          },
          text: {
            primary: '#E0E0E0',
            secondary: '#AAAAAA',
          },
          primary: {
            main: '#4A90E2',
          },
          divider: '#3A3A3A',
        } : {
          // Light mode colors - default theme
        }),
      },
      components: {
        MuiPaper: {
          styleOverrides: {
            root: {
              backgroundColor: darkMode ? '#2A2A2A' : '#ffffff',
              color: darkMode ? '#E0E0E0' : 'inherit',
            },
          },
        },
        MuiDataGrid: {
          styleOverrides: {
            root: {
              border: darkMode ? '1px solid #3A3A3A' : '1px solid rgba(224, 224, 224, 1)',
              '& .MuiDataGrid-cell': {
                borderBottom: darkMode ? '1px solid #3A3A3A' : '1px solid rgba(224, 224, 224, 1)',
                color: darkMode ? '#E0E0E0' : 'inherit',
              },
              '& .MuiDataGrid-columnHeader': {
                borderBottom: darkMode ? '1px solid #3A3A3A' : '1px solid rgba(224, 224, 224, 1)',
                color: darkMode ? '#E0E0E0' : 'inherit',
              },
              '& .MuiDataGrid-iconSeparator': {
                color: darkMode ? '#3A3A3A' : 'inherit',
              },
            },
          },
        },
        MuiInputBase: {
          styleOverrides: {
            root: {
              backgroundColor: darkMode ? '#2A2A2A' : 'inherit',
              color: darkMode ? '#E0E0E0' : 'inherit',
            },
          },
        },
        MuiSelect: {
          styleOverrides: {
            root: {
              backgroundColor: darkMode ? '#2A2A2A' : 'inherit',
              color: darkMode ? '#E0E0E0' : 'inherit',
              '& .MuiOutlinedInput-notchedOutline': {
                borderColor: darkMode ? '#3A3A3A' : 'inherit',
              },
              '&:hover .MuiOutlinedInput-notchedOutline': {
                borderColor: darkMode ? '#4A90E2' : 'inherit',
              },
            },
          },
        },
      },
    }));
  }, [darkMode]);

  return theme;
}