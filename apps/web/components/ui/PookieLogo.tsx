'use client';

import React from 'react';
import Image from 'next/image';

export type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CONFIG: Record<LogoSize, { px: number; className: string; rounded: string }> = {
  xs: { px: 24, className: 'h-6 w-6', rounded: 'rounded-md' },
  sm: { px: 32, className: 'h-8 w-8', rounded: 'rounded-lg' },
  md: { px: 44, className: 'h-11 w-11', rounded: 'rounded-xl' },
  lg: { px: 64, className: 'h-16 w-16', rounded: 'rounded-2xl' },
  xl: { px: 88, className: 'h-[88px] w-[88px]', rounded: 'rounded-2xl' },
};

export interface PookieLogoProps {
  size?: LogoSize;
  alt?: string;
  className?: string;
  priority?: boolean;
  rounded?: boolean;
}

export function PookieLogo({
  size = 'md',
  alt = '',
  className = '',
  priority = false,
  rounded = true,
}: PookieLogoProps) {
  const config = SIZE_CONFIG[size] || SIZE_CONFIG.md;
  const isDecorative = !alt;

  return (
    <div
      className={`relative shrink-0 overflow-hidden select-none inline-flex items-center justify-center ${config.className} ${
        rounded ? config.rounded : ''
      } ${className}`}
    >
      <Image
        src="/logo.png"
        alt={alt}
        aria-hidden={isDecorative ? true : undefined}
        width={config.px}
        height={config.px}
        priority={priority}
        className={`h-full w-full object-cover ${rounded ? config.rounded : ''}`}
      />
    </div>
  );
}
