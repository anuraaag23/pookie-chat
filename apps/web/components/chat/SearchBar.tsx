'use client';

import type { InputHTMLAttributes } from 'react';

/**
 * The one search bar in the app. Visually Liquid Glass, per
 * docs/04-DESIGN-SYSTEM.md §3. Functionally, this is still just a text
 * input in Phase 1 — normal search and the hidden-chat unlock path both
 * get built on top of it in Phase 7, deliberately not before then.
 */
export function SearchBar(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="glass mb-3.5 flex items-center gap-2.5 rounded-lg px-4 py-2.5 text-ink-dim">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="h-[17px] w-[17px] flex-shrink-0"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        placeholder="Search"
        aria-label="Search"
        className="w-full bg-transparent text-sm text-ink placeholder:text-ink-dim focus:outline-none"
        {...props}
      />
    </div>
  );
}
