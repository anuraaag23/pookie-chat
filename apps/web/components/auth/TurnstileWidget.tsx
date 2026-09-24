'use client';

import { useEffect, useRef, useState } from 'react';
import { useTheme } from '@/lib/theme/ThemeContext';
import { NeoSurface } from '@/components/ui/NeoSurface';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: string | HTMLElement,
        options: {
          sitekey: string;
          theme?: 'auto' | 'light' | 'dark';
          action?: string;
          callback?: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: (errorCode?: string) => void;
        }
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  action?: 'login' | 'register';
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (errorMessage?: string) => void;
  className?: string;
  resetTrigger?: number;
}

export function TurnstileWidget({
  action = 'login',
  onVerify,
  onExpire,
  onError,
  className = '',
  resetTrigger = 0,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const { theme } = useTheme();

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || '';
  const isDev = process.env.NODE_ENV !== 'production';

  // Load Turnstile script dynamically if not already loaded
  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (!siteKey) {
      if (isDev) {
        // Automatically provide bypass token in local development if no site key is configured
        onVerify('dev-bypass-token');
      }
      return;
    }

    if (window.turnstile) {
      setScriptLoaded(true);
      return;
    }

    const existingScript = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]');
    if (existingScript) {
      const handleLoad = () => setScriptLoaded(true);
      existingScript.addEventListener('load', handleLoad);
      return () => existingScript.removeEventListener('load', handleLoad);
    }

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => setScriptLoaded(true);
    script.onerror = () => {
      setLoadError(true);
      onError?.('Security verification unavailable. Please check your connection.');
    };
    document.head.appendChild(script);
  }, [siteKey, isDev, onVerify, onError]);

  // Render widget once script is loaded
  useEffect(() => {
    if (!scriptLoaded || !containerRef.current || !window.turnstile || !siteKey) return;

    // Clean up any existing widget before re-rendering
    if (widgetIdRef.current) {
      try {
        window.turnstile.remove(widgetIdRef.current);
      } catch {
        // ignore cleanup error
      }
      widgetIdRef.current = null;
    }

    containerRef.current.innerHTML = '';

    try {
      const id = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: theme === 'dark' ? 'dark' : 'light',
        action,
        callback: (token: string) => {
          onVerify(token);
        },
        'expired-callback': () => {
          onExpire?.();
        },
        'error-callback': () => {
          onError?.('Security verification failed. Please try again.');
        },
      });
      widgetIdRef.current = id;
    } catch {
      setLoadError(true);
      onError?.('Security verification failed to initialize.');
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore cleanup error
        }
        widgetIdRef.current = null;
      }
    };
  }, [scriptLoaded, siteKey, theme, action, resetTrigger, onVerify, onExpire, onError]);

  if (!siteKey) {
    if (isDev) {
      return (
        <NeoSurface
          variant="pressed"
          className={`p-3 flex items-center justify-center text-xs text-ink-dim border border-glass-border/40 ${className}`}
          role="status"
          aria-label="Security verification development bypass"
        >
          <span className="font-mono text-[11px] text-ink-dim">
            Development Mode: Turnstile verification bypassed
          </span>
        </NeoSurface>
      );
    }
    return (
      <NeoSurface
        variant="pressed"
        className={`p-3 flex items-center justify-center text-xs text-danger border border-danger/30 ${className}`}
        role="alert"
        aria-label="Security verification configuration error"
      >
        Security verification is currently unavailable.
      </NeoSurface>
    );
  }

  if (loadError) {
    return (
      <NeoSurface
        variant="pressed"
        className={`p-3 flex items-center justify-center text-xs text-danger border border-danger/30 ${className}`}
        role="alert"
      >
        Could not load security verification. Please check your connection.
      </NeoSurface>
    );
  }

  return (
    <NeoSurface
      variant="pressed"
      className={`p-3 flex flex-col items-center justify-center min-h-[75px] overflow-hidden border border-glass-border/40 transition-colors ${className}`}
      role="region"
      aria-label="Security verification challenge"
    >
      <div ref={containerRef} className="flex justify-center w-full min-h-[65px]" />
    </NeoSurface>
  );
}
