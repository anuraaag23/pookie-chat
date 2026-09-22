import type { InputHTMLAttributes } from 'react';

export function NeoInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`neo-pressed w-full rounded-lg px-4 py-3 text-sm text-ink placeholder:text-ink-dim focus:outline-none ${props.className ?? ''}`}
    />
  );
}
