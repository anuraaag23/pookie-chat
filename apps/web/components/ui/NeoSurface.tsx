import type { ReactNode, HTMLAttributes } from 'react';

type NeoSurfaceProps = {
  variant?: 'raised' | 'pressed';
  className?: string;
  children?: ReactNode;
} & HTMLAttributes<HTMLDivElement>;

/**
 * Generic neomorphic surface — cards, bubbles, panels. Maps directly to the
 * shadow recipe in docs/04-DESIGN-SYSTEM.md §2. Accepts ordinary div
 * attributes (onClick, etc.) since several screens use this as a clickable
 * row/card, not just static decoration.
 */
export function NeoSurface({ variant = 'raised', className = '', children, ...rest }: NeoSurfaceProps) {
  return (
    <div className={`${variant === 'raised' ? 'neo-raised' : 'neo-pressed'} rounded-lg ${className}`} {...rest}>
      {children}
    </div>
  );
}
