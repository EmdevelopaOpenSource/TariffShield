'use client';

import { useEffect, useMemo, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_STORAGE_KEY = 'tariffshield.theme';

function resolveTheme(preference: ThemePreference) {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return preference;
}

function readStoredPreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
}

export function useThemePreference() {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    const next = readStoredPreference();
    applyTheme(next);
    setPreferenceState(next);
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (readStoredPreference() === 'system') applyTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setPreference = useMemo(
    () => (next: ThemePreference) => {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
      setPreferenceState(next);
    },
    []
  );

  return { preference, setPreference };
}