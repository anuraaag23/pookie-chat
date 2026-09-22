import type { Config } from 'tailwindcss';

// Maps docs/04-DESIGN-SYSTEM.md's tokens onto Tailwind's theme. Values live
// in app/globals.css as CSS variables (so light/dark just swaps the
// variables) — this file only wires Tailwind's utility classes to them.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'var(--text)',
        'ink-dim': 'var(--text-dim)',
        danger: 'var(--red)',
        positive: 'var(--green)',
        info: 'var(--blue)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
      },
    },
  },
  plugins: [],
};

export default config;
