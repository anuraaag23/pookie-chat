import type { InputHTMLAttributes } from 'react';

export function NeoInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`neo-pressed w-full rounded-lg px-4 py-2.5 sm:py-3 text-sm text-ink placeholder:text-ink-dim focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 transition-shadow ${props.className ?? ''}`}
    />
  );
}
