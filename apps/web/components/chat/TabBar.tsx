'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api/client';

const TABS = [
  { label: 'Chat', href: '/chat' },
  { label: 'Connect', href: '/connect' },
  { label: 'Settings', href: '/settings' },
] as const;

// Width reserved by the sidebar variant at lg+. Pages that render TabBar
// add a matching lg:pl-[SIDEBAR_WIDTH_CLASS] to their own <main> so
// content never sits underneath it — see e.g. app/chat/page.tsx.
export const SIDEBAR_WIDTH_CLASS = 'lg:w-56';

export function TabBar({ active }: { active?: string }) {
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    // Initial fetch of unread count from /api/conversations
    api<{ unreadCount?: number }[]>('/api/conversations')
      .then((convs) => {
        if (Array.isArray(convs)) {
          const total = convs.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
          setUnreadCount(total);
        }
      })
      .catch(() => {});

    const handleUnreadChanged = (e: Event) => {
      const customEvent = e as CustomEvent<{ count?: number }>;
      if (customEvent.detail?.count !== undefined) {
        setUnreadCount(customEvent.detail.count);
      } else {
        api<{ unreadCount?: number }[]>('/api/conversations')
          .then((convs) => {
            if (Array.isArray(convs)) {
              const total = convs.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
              setUnreadCount(total);
            }
          })
          .catch(() => {});
      }
    };

    window.addEventListener('unread-count-changed', handleUnreadChanged);
    return () => {
      window.removeEventListener('unread-count-changed', handleUnreadChanged);
    };
  }, []);

  return (
    // Below lg: fixed bottom pill bar with active-state & unread indicators.
    // At lg and up: hidden on desktop since desktop has header tabs.
    <nav
      className="neo-raised fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] mx-auto flex max-w-md justify-around rounded-lg px-2 py-2.5 z-30 md:hidden"
    >
      {TABS.map((tab) => {
        const isActive = active ? tab.label === active : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.label}
            href={tab.href}
            className={`relative inline-flex items-center justify-center rounded-md px-2.5 py-1 text-[11.5px] font-semibold lg:w-full lg:px-3 lg:py-2.5 lg:text-left lg:text-[13.5px] ${isActive ? 'neo-pressed text-ink' : 'text-ink-dim'}`}
          >
            <span>{tab.label}</span>
            {tab.label === 'Chat' && unreadCount > 0 && (
              <span
                className="ml-1.5 px-1.5 py-0.2 rounded-full bg-info text-white font-black text-[9px] min-w-[16px] text-center shadow-sm"
                title={`${unreadCount} unread message${unreadCount > 1 ? 's' : ''}`}
              >
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
