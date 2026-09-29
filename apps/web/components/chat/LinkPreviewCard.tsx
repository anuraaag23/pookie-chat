'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api/client';
import { NeoSurface } from '@/components/ui/NeoSurface';

interface LinkPreviewData {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
  hostname: string;
}

const previewCache = new Map<string, LinkPreviewData | null>();

interface LinkPreviewCardProps {
  url: string;
}

export function LinkPreviewCard({ url }: LinkPreviewCardProps) {
  const [data, setData] = useState<LinkPreviewData | null>(() => previewCache.get(url) ?? null);
  const [loading, setLoading] = useState(!previewCache.has(url));

  useEffect(() => {
    if (previewCache.has(url)) {
      setData(previewCache.get(url) ?? null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    api<LinkPreviewData>(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then((res) => {
        if (!active) return;
        previewCache.set(url, res);
        setData(res);
      })
      .catch(() => {
        if (!active) return;
        previewCache.set(url, null);
        setData(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [url]);

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-2.5 p-2 rounded-xl bg-surface-2/40 border border-glass-border/30 max-w-sm animate-pulse">
        <div className="w-10 h-10 rounded-lg bg-surface-3/60 shrink-0" />
        <div className="flex-1 space-y-1.5 min-w-0">
          <div className="h-3 bg-surface-3/60 rounded w-3/4" />
          <div className="h-2.5 bg-surface-3/40 rounded w-1/2" />
        </div>
      </div>
    );
  }

  // If failed or no usable title/description, don't clutter the chat
  if (!data || (!data.title && !data.description && !data.image)) {
    return null;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 block max-w-sm rounded-xl overflow-hidden text-left transition-transform active:scale-[0.99] group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info"
    >
      <NeoSurface variant="raised" className="overflow-hidden border border-glass-border/50 hover:border-info/40 transition-colors">
        {data.image && (
          <div className="relative w-full h-32 bg-surface-2/60 overflow-hidden">
            <img
              src={data.image}
              alt={data.title || 'Link preview'}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              onError={(e) => {
                // Hide image if broken/blocked
                (e.currentTarget as HTMLElement).style.display = 'none';
              }}
            />
          </div>
        )}
        <div className="p-3 space-y-1">
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold text-info/90 truncate">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            <span className="truncate">{data.siteName || data.hostname}</span>
          </div>
          {data.title && (
            <div className="text-xs font-bold text-ink line-clamp-2 leading-snug group-hover:text-info transition-colors">
              {data.title}
            </div>
          )}
          {data.description && (
            <div className="text-[11px] text-ink-dim line-clamp-2 leading-relaxed">
              {data.description}
            </div>
          )}
        </div>
      </NeoSurface>
    </a>
  );
}
