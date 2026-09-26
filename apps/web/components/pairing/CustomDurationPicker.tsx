'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import { NeoSurface } from '@/components/ui/NeoSurface';

interface CustomDurationPickerProps {
  valueSeconds: number;
  onChange: (totalSeconds: number) => void;
  className?: string;
}

const ITEM_HEIGHT = 40; // px
const VISIBLE_COUNT = 5; // visible rows

interface WheelColumnProps {
  label: string;
  max: number;
  min?: number;
  value: number;
  onChange: (val: number) => void;
  step?: number;
}

function WheelColumn({ label, max, min = 0, value, onChange, step = 1 }: WheelColumnProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);

  // Generate options array
  const options = useMemo(() => {
    const list: number[] = [];
    for (let i = min; i <= max; i += step) {
      list.push(i);
    }
    return list;
  }, [min, max, step]);

  const selectedIndex = options.indexOf(value) !== -1 ? options.indexOf(value) : 0;

  // Sync scroll position when value changes from outside
  useEffect(() => {
    if (isScrollingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    const targetScroll = selectedIndex * ITEM_HEIGHT;
    if (Math.abs(container.scrollTop - targetScroll) > 2) {
      container.scrollTo({ top: targetScroll, behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Handle scroll events with debounced snap
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    isScrollingRef.current = true;
    const scrollTop = e.currentTarget.scrollTop;
    const index = Math.round(scrollTop / ITEM_HEIGHT);
    const clampedIndex = Math.max(0, Math.min(index, options.length - 1));
    const newVal = options[clampedIndex];
    if (newVal !== undefined && newVal !== value) {
      onChange(newVal);
    }
  };

  const handleScrollEnd = () => {
    isScrollingRef.current = false;
    const container = containerRef.current;
    if (!container) return;
    const index = Math.round(container.scrollTop / ITEM_HEIGHT);
    const clampedIndex = Math.max(0, Math.min(index, options.length - 1));
    container.scrollTo({ top: clampedIndex * ITEM_HEIGHT, behavior: 'smooth' });
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY > 0) {
      const nextIndex = Math.min(selectedIndex + 1, options.length - 1);
      onChange(options[nextIndex]!);
    } else if (e.deltaY < 0) {
      const prevIndex = Math.max(selectedIndex - 1, 0);
      onChange(options[prevIndex]!);
    }
  };

  const increment = () => {
    const nextIndex = Math.min(selectedIndex + 1, options.length - 1);
    onChange(options[nextIndex]!);
  };

  const decrement = () => {
    const prevIndex = Math.max(selectedIndex - 1, 0);
    onChange(options[prevIndex]!);
  };

  const paddingY = ((VISIBLE_COUNT - 1) / 2) * ITEM_HEIGHT;

  return (
    <div className="flex flex-col items-center flex-1 min-w-0 select-none">
      <span className="text-[11px] font-bold text-ink-dim uppercase tracking-wider mb-1.5">
        {label}
      </span>

      {/* Up Arrow Button */}
      <button
        type="button"
        onClick={decrement}
        className="w-full py-1 text-ink-dim/60 hover:text-ink hover:bg-surface-2/40 rounded transition-colors flex items-center justify-center"
        aria-label={`Decrease ${label}`}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15" /></svg>
      </button>

      {/* Wheel Container */}
      <div className="relative w-full h-[200px] overflow-hidden rounded-xl border border-glass-border/40 neo-pressed bg-surface-2/30">
        {/* Center Selection Lens */}
        <div
          className="absolute left-0 right-0 pointer-events-none border-y border-info/50 bg-info/10 z-10 transition-colors"
          style={{
            top: `${paddingY}px`,
            height: `${ITEM_HEIGHT}px`,
          }}
        />

        {/* Scrollable barrel */}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          onTouchEnd={handleScrollEnd}
          onMouseUp={handleScrollEnd}
          onWheel={handleWheel}
          className="h-full w-full overflow-y-auto overflow-x-hidden snap-y snap-mandatory scrollbar-none py-0"
          style={{
            paddingTop: `${paddingY}px`,
            paddingBottom: `${paddingY}px`,
          }}
        >
          {options.map((opt, idx) => {
            const isSelected = idx === selectedIndex;
            const distance = Math.abs(idx - selectedIndex);
            const opacity = distance === 0 ? 'opacity-100' : distance === 1 ? 'opacity-60' : 'opacity-25';
            const scale = distance === 0 ? 'scale-105 font-bold text-info' : 'scale-95 text-ink';

            return (
              <div
                key={opt}
                onClick={() => {
                  onChange(opt);
                }}
                className={`snap-center flex items-center justify-center cursor-pointer transition-all duration-150 ${opacity} ${scale}`}
                style={{ height: `${ITEM_HEIGHT}px` }}
              >
                <span className="font-mono text-base sm:text-lg">
                  {opt.toString().padStart(label === 'Hours' ? 1 : 2, '0')}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Down Arrow Button */}
      <button
        type="button"
        onClick={increment}
        className="w-full py-1 text-ink-dim/60 hover:text-ink hover:bg-surface-2/40 rounded transition-colors flex items-center justify-center mt-0.5"
        aria-label={`Increase ${label}`}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </div>
  );
}

export function CustomDurationPicker({
  valueSeconds,
  onChange,
  className = '',
}: CustomDurationPickerProps) {
  // Break value into Hours, Minutes, Seconds
  const hours = Math.floor(valueSeconds / 3600);
  const minutes = Math.floor((valueSeconds % 3600) / 60);
  const seconds = valueSeconds % 60;

  const updateHours = (h: number) => {
    const total = Math.max(60, h * 3600 + minutes * 60 + seconds);
    onChange(Math.min(total, 90 * 24 * 3600));
  };

  const updateMinutes = (m: number) => {
    const total = Math.max(60, hours * 3600 + m * 60 + seconds);
    onChange(Math.min(total, 90 * 24 * 3600));
  };

  const updateSeconds = (s: number) => {
    const total = Math.max(60, hours * 3600 + minutes * 60 + s);
    onChange(Math.min(total, 90 * 24 * 3600));
  };

  // Formatted duration string
  const formattedSummary = useMemo(() => {
    const parts: string[] = [];
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;

    if (days > 0) parts.push(`${days}d`);
    if (remHours > 0 || (days > 0 && (minutes > 0 || seconds > 0))) parts.push(`${remHours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

    return parts.join(' ');
  }, [hours, minutes, seconds]);

  const expirationDate = useMemo(() => {
    return new Date(Date.now() + valueSeconds * 1000).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }, [valueSeconds]);

  return (
    <div className={`flex flex-col gap-3 w-full ${className}`}>
      {/* 3 Number Wheels */}
      <div className="flex items-center gap-2 sm:gap-3 p-3 rounded-2xl bg-surface-2/40 border border-glass-border/40">
        <WheelColumn
          label="Hours"
          min={0}
          max={2160} // 90 days = 2160 hours
          value={hours}
          onChange={updateHours}
        />
        <div className="pt-6 font-mono text-ink-dim/50 font-bold">:</div>
        <WheelColumn
          label="Minutes"
          min={0}
          max={59}
          value={minutes}
          onChange={updateMinutes}
        />
        <div className="pt-6 font-mono text-ink-dim/50 font-bold">:</div>
        <WheelColumn
          label="Seconds"
          min={0}
          max={59}
          value={seconds}
          onChange={updateSeconds}
        />
      </div>

      {/* Summary card */}
      <div className="p-3 bg-surface-2/60 rounded-xl border border-glass-border/40 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-ink-dim">Total Duration:</span>
          <span className="font-bold text-info">{formattedSummary}</span>
        </div>
        <div className="text-[11px] text-ink-dim">
          Expires: <span className="text-ink font-medium">{expirationDate}</span>
        </div>
      </div>
    </div>
  );
}
