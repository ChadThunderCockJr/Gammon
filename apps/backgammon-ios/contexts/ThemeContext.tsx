import React, { createContext, useContext, useState, useCallback } from "react";
import {
  Theme,
  ThemeName,
  darkTheme,
  lightTheme,
  luxTheme,
} from "../constants/themes";

interface ThemeContextValue {
  colors: Theme;
  themeName: ThemeName;
  setTheme: (name: ThemeName) => void;
}

const themes: Record<ThemeName, Theme> = {
  dark: darkTheme,
  light: lightTheme,
  lux: luxTheme,
};

const ThemeContext = createContext<ThemeContextValue>({
  colors: darkTheme,
  themeName: "dark",
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeName, setThemeName] = useState<ThemeName>("dark");

  const setTheme = useCallback((name: ThemeName) => {
    setThemeName(name);
  }, []);

  const value: ThemeContextValue = {
    colors: themes[themeName],
    themeName,
    setTheme,
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
