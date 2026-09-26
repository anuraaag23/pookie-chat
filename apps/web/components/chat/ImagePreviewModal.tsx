'use client';

import { useEffect, useState } from 'react';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { Button } from '@/components/ui/Button';

interface ImagePreviewModalProps {
  file: File;
  onSend: (file: File, caption?: string) => Promise<void> | void;
  onCancel: () => void;
  isSending?: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ImagePreviewModal({
  file,
  onSend,
  onCancel,
  isSending = false,
}: ImagePreviewModalProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);

    const img = new Image();
    img.src = url;
    img.onload = () => {
      setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    };

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isSending) {
        onCancel();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, isSending]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSending) return;
    onSend(file, caption.trim() || undefined);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="image-preview-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-backdrop/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSending) onCancel();
      }}
    >
      <NeoSurface
        variant="raised"
        className="w-full max-w-lg rounded-2xl p-4 sm:p-6 flex flex-col gap-4 border border-glass-border/60 bg-surface shadow-2xl max-h-[92vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div>
            <h2 id="image-preview-title" className="text-sm sm:text-base font-bold text-ink">
              Send Image
            </h2>
            <p className="text-[11px] text-ink-dim">
              End-to-end encrypted · EXIF & location metadata stripped before sending
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Cancel"
            className="!h-8 !w-8"
            onClick={onCancel}
            disabled={isSending}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </Button>
        </div>

        {/* Image Preview Container */}
        <div className="relative flex-1 min-h-[180px] max-h-[46vh] sm:max-h-[52vh] flex items-center justify-center rounded-xl bg-surface-2/70 overflow-hidden border border-glass-border/40 neo-pressed p-2">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={file.name}
              className="max-h-full max-w-full object-contain rounded-lg shadow-sm"
            />
          ) : (
            <div className="flex items-center justify-center text-xs text-ink-dim">
              Loading preview…
            </div>
          )}
        </div>

        {/* Metadata Badges */}
        <div className="flex flex-wrap items-center justify-between text-[11px] text-ink-dim px-1 shrink-0 gap-2">
          <span className="truncate max-w-[200px] font-medium text-ink" title={file.name}>
            {file.name}
          </span>
          <div className="flex items-center gap-2 font-mono">
            <span>{formatFileSize(file.size)}</span>
            {imageDimensions && (
              <>
                <span>·</span>
                <span>{imageDimensions.width} × {imageDimensions.height}</span>
              </>
            )}
          </div>
        </div>

        {/* Optional Caption and Actions Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 shrink-0">
          <NeoSurface variant="pressed" className="px-1">
            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Add a caption (optional)..."
              disabled={isSending}
              className="w-full bg-transparent px-3 py-2 text-xs sm:text-sm text-ink placeholder:text-ink-dim focus:outline-none"
              autoFocus
            />
          </NeoSurface>

          <div className="flex gap-2.5 pt-1">
            <Button
              type="button"
              variant="raised"
              className="flex-1 text-xs font-semibold"
              onClick={onCancel}
              disabled={isSending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="raised"
              accent="info"
              className="flex-1 text-xs font-bold flex items-center justify-center gap-1.5"
              disabled={isSending}
            >
              {isSending ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  <span>Encrypting & Sending…</span>
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M3 11.5L21 3l-8.5 18-2.5-7.5L3 11.5z" />
                  </svg>
                  <span>Send Image</span>
                </>
              )}
            </Button>
          </div>
        </form>
      </NeoSurface>
    </div>
  );
}
