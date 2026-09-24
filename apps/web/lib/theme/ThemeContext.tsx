'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const DEFAULT_ACCENT_COLOR = '#3B82F6';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  accentColor: string | null;
  setAccentColor: (accent: string | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = 'pookie_theme';
const ACCENT_STORAGE_KEY = 'pookie_accent';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('light');
  const [accentColor, setAccentColorState] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
      if (stored === 'light' || stored === 'dark') {
        setThemeState(stored);
        document.documentElement.setAttribute('data-theme', stored);
      } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        setThemeState('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
      }

      const storedAccent = localStorage.getItem(ACCENT_STORAGE_KEY);
      if (storedAccent) {
        setAccentColorState(storedAccent);
        document.documentElement.style.setProperty('--blue', storedAccent);
      }
    } catch {
      // Graceful fallback if localStorage is blocked
    }
  }, []);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } catch {
      // localStorage may fail in restricted/private modes
    }
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const setAccentColor = (newAccent: string | null) => {
    setAccentColorState(newAccent);
    try {
      if (newAccent) {
        localStorage.setItem(ACCENT_STORAGE_KEY, newAccent);
        document.documentElement.style.setProperty('--blue', newAccent);
      } else {
        localStorage.removeItem(ACCENT_STORAGE_KEY);
        document.documentElement.style.removeProperty('--blue');
      }
    } catch {
      // localStorage may fail in restricted modes
    }
  };

  const toggleTheme = () => {
    const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
  };

  // Keep across tabs in sync
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        setThemeState(e.newValue);
        document.documentElement.setAttribute('data-theme', e.newValue);
      }
      if (e.key === ACCENT_STORAGE_KEY) {
        setAccentColorState(e.newValue || null);
        if (e.newValue) {
          document.documentElement.style.setProperty('--blue', e.newValue);
        } else {
          document.documentElement.style.removeProperty('--blue');
        }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, accentColor, setAccentColor }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: 'light',
      setTheme: () => {},
      toggleTheme: () => {},
      accentColor: null,
      setAccentColor: () => {},
    };
  }
  return context;
}
