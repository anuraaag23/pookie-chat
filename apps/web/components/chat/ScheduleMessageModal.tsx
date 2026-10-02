'use client';

import { useState } from 'react';
import { Button } from '../ui/Button';
import { NeoSurface } from '../ui/NeoSurface';
import { playPopSound, triggerHaptic } from '@/lib/sound/soundEffects';

interface ScheduleMessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSchedule: (targetTimeMs: number) => void;
  draftText?: string;
  error?: string | null;
}

export function ScheduleMessageModal({
  isOpen,
  onClose,
  onSchedule,
  draftText,
  error,
}: ScheduleMessageModalProps) {
  const [customScheduleInput, setCustomScheduleInput] = useState('');

  if (!isOpen) return null;

  function handlePreset(ms: number) {
    playPopSound();
    triggerHaptic('light');
    onSchedule(Date.now() + ms);
  }

  function handleCustomSchedule() {
    if (!customScheduleInput) return;
    const ts = new Date(customScheduleInput).getTime();
    if (isNaN(ts) || ts <= Date.now()) {
      return;
    }
    playPopSound();
    triggerHaptic('light');
    onSchedule(ts);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
    >
      <NeoSurface variant="raised" className="w-full max-w-sm p-6 flex flex-col gap-4 bg-surface rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-info">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <h2 className="text-base font-bold text-ink">Schedule Message</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-ink-dim hover:text-ink active:scale-95 transition-transform"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-xs text-ink-dim">
          Pick a future time when this message should be automatically sent.
        </p>

        {draftText && (
          <div className="p-2.5 rounded-xl bg-surface-2/60 border border-glass-border/40 text-xs text-ink line-clamp-2 italic">
            &ldquo;{draftText}&rdquo;
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-bold text-ink-dim uppercase tracking-wider">Quick Presets</span>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="raised"
              className="!text-xs !py-2 font-medium active:scale-95 transition-transform"
              onClick={() => handlePreset(15 * 60 * 1000)}
            >
              In 15 minutes
            </Button>
            <Button
              variant="raised"
              className="!text-xs !py-2 font-medium active:scale-95 transition-transform"
              onClick={() => handlePreset(30 * 60 * 1000)}
            >
              In 30 minutes
            </Button>
            <Button
              variant="raised"
              className="!text-xs !py-2 font-medium active:scale-95 transition-transform"
              onClick={() => handlePreset(60 * 60 * 1000)}
            >
              In 1 hour
            </Button>
            <Button
              variant="raised"
              className="!text-xs !py-2 font-medium active:scale-95 transition-transform"
              onClick={() => handlePreset(3 * 3600 * 1000)}
            >
              In 3 hours
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-1 border-t border-glass-border/40">
          <span className="text-[11px] font-bold text-ink-dim uppercase tracking-wider">Custom Date & Time</span>
          <input
            type="datetime-local"
            value={customScheduleInput}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            onChange={(e) => setCustomScheduleInput(e.target.value)}
            className="w-full neo-pressed px-3 py-2 rounded-xl text-xs bg-transparent text-ink focus:outline-none"
          />
          {error && (
            <span className="text-[11px] text-danger font-medium">{error}</span>
          )}
          <Button
            variant="raised"
            accent="info"
            className="!text-xs !py-2 font-bold w-full mt-1 active:scale-95 transition-transform"
            disabled={!customScheduleInput}
            onClick={handleCustomSchedule}
          >
            Schedule
          </Button>
        </div>
      </NeoSurface>
    </div>
  );
}
