'use client';

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'raised' | 'pressed' | 'glass' | 'ghost';
type Size = 'md' | 'icon';
type Accent = 'info' | 'danger' | 'positive' | 'none';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  accent?: Accent;
}

const variantClass: Record<Variant, string> = {
  raised: 'neo-raised',
  pressed: 'neo-pressed',
  glass: 'glass',
  ghost: 'bg-transparent shadow-none',
};

const sizeClass: Record<Size, string> = {
  md: 'rounded-lg px-5 py-3',
  icon: 'flex h-[42px] w-[42px] items-center justify-center rounded-full',
};

const accentClass: Record<Accent, string> = {
  info: 'text-info',
  danger: 'text-danger',
  positive: 'text-positive',
  none: 'text-ink',
};

/**
 * Base interactive surface for the whole app. `variant` picks which of the
 * two design languages this control uses (docs/04-DESIGN-SYSTEM.md).
 * `variant="glass"` is reserved for a small, deliberate set of controls —
 * search, send, primary actions. Most buttons should use the default,
 * `raised`.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'raised', size = 'md', accent = 'none', className = '', children, ...props }, ref) => (
    <button
      ref={ref}
      className={[
        variantClass[variant],
        sizeClass[size],
        accentClass[accent],
        'text-sm font-semibold transition-shadow',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-2',
        className,
      ].join(' ')}
      {...props}
    >
      {children}
    </button>
  ),
);

Button.displayName = 'Button';
