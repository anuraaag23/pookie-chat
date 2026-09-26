'use client';

import { useEffect, useState, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { isProtectedRoute } from '@/lib/auth/routeGuards';
import { NeoSurface } from '@/components/ui/NeoSurface';

interface CaptureProtectionProps {
  children: ReactNode;
}

export function CaptureProtection({ children }: CaptureProtectionProps) {
  const pathname = usePathname();
  const isProtected = isProtectedRoute(pathname);

  const [isDevToolsOpen, setIsDevToolsOpen] = useState(false);
  const [isPageHidden, setIsPageHidden] = useState(false);

  // 1. Electron Content Protection check
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const electron = (window as any).require?.('electron');
      const currentWin = electron?.remote?.getCurrentWindow?.();
      if (currentWin && typeof currentWin.setContentProtection === 'function') {
        currentWin.setContentProtection(true);
      }
    } catch {
      // Graceful fallback for web browsers
    }
  }, []);

  // 2. Event listeners for keyboard shortcuts & context menu on protected routes
  useEffect(() => {
    if (!isProtected || typeof window === 'undefined') return;

    // Disable default browser context menu inside protected areas
    function handleContextMenu(e: MouseEvent) {
      // Allow custom app elements that explicitly handle context menus
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-allow-context-menu="true"]')) {
        return;
      }
      e.preventDefault();
    }

    // Intercept common screenshot and DevTools opening shortcuts
    function handleKeyDown(e: KeyboardEvent) {
      const key = e.key;
      const code = e.code;
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;
      const isAlt = e.altKey;

      // PrintScreen (Windows / Linux)
      if (key === 'PrintScreen' || code === 'PrintScreen' || e.keyCode === 44) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // DevTools: F12
      if (key === 'F12' || code === 'F12') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // DevTools: Ctrl+Shift+I / J / C or Cmd+Opt+I / J / C
      if ((isCtrlOrMeta && isShift && (key === 'I' || key === 'i' || key === 'J' || key === 'j' || key === 'C' || key === 'c')) ||
          (e.metaKey && isAlt && (key === 'I' || key === 'i' || key === 'J' || key === 'j' || key === 'C' || key === 'c'))) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Mac screenshot shortcuts: Cmd+Shift+3, Cmd+Shift+4, Cmd+Shift+5
      if (e.metaKey && isShift && (key === '3' || key === '4' || key === '5')) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Windows Snipping Tool shortcut: Win+Shift+S (where browser can observe it)
      if (isCtrlOrMeta && isShift && (key === 'S' || key === 's')) {
        // Obscure momentarily
        setIsPageHidden(true);
        setTimeout(() => setIsPageHidden(false), 2000);
      }
    }

    // 3. Page Visibility listener
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        setIsPageHidden(true);
      } else {
        setIsPageHidden(false);
      }
    }

    window.addEventListener('contextmenu', handleContextMenu);
    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('contextmenu', handleContextMenu);
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isProtected]);

  // 4. Lightweight DevTools detection for protected routes
  useEffect(() => {
    if (!isProtected || typeof window === 'undefined') {
      setIsDevToolsOpen(false);
      return;
    }

    const checkDevTools = () => {
      const widthThreshold = window.outerWidth - window.innerWidth > 160;
      const heightThreshold = window.outerHeight - window.innerHeight > 160;
      const isOpen = widthThreshold || heightThreshold;
      setIsDevToolsOpen((prev) => (prev !== isOpen ? isOpen : prev));
    };

    const interval = setInterval(checkDevTools, 1500);
    window.addEventListener('resize', checkDevTools);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', checkDevTools);
    };
  }, [isProtected]);

  // If not on a protected route, render normally without overlays
  if (!isProtected) {
    return <>{children}</>;
  }

  return (
    <div className="relative min-h-screen w-full">
      {/* Main Content with dynamic blur if concealed */}
      <div
        className={`transition-all duration-200 ${
          isDevToolsOpen || isPageHidden ? 'filter blur-xl select-none pointer-events-none' : ''
        }`}
        aria-hidden={isDevToolsOpen || isPageHidden}
      >
        {children}
      </div>

      {/* Concealment Overlay when DevTools is opened */}
      {isDevToolsOpen && (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-surface/90 backdrop-blur-2xl animate-in fade-in duration-200"
        >
          <NeoSurface
            variant="raised"
            className="max-w-md w-full p-6 text-center flex flex-col items-center gap-3 border border-glass-border/60 shadow-2xl"
          >
            <div className="w-12 h-12 rounded-full bg-info/15 text-info flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">Protected Content Concealed</h2>
              <p className="mt-1 text-xs text-ink-dim leading-relaxed">
                Developer tools or inspection window detected. Message content is concealed for privacy. Close developer tools to resume.
              </p>
            </div>
          </NeoSurface>
        </div>
      )}

      {/* Concealment Overlay when page/tab is backgrounded */}
      {isPageHidden && !isDevToolsOpen && (
        <div className="fixed inset-0 z-40 bg-surface/90 backdrop-blur-2xl flex items-center justify-center">
          <div className="text-xs text-ink-dim font-medium">Content protected</div>
        </div>
      )}
    </div>
  );
}
