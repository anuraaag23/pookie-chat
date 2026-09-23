'use client';

import Link from 'next/link';
import { AppHeader } from '@/components/navigation/AppHeader';
import { ConversationSidebar } from '@/components/chat/ConversationSidebar';
import { TabBar } from '@/components/chat/TabBar';
import { Button } from '@/components/ui/Button';
import { PookieLogo } from '@/components/ui/PookieLogo';

export default function ChatListPage() {
  return (
    <div className="flex h-dvh max-h-dvh w-full flex-col overflow-hidden bg-surface">
      <AppHeader activeTab="Chat" />

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Left: Conversation List (Full width on mobile, w-80/w-96 on desktop) */}
        <aside className="w-full md:w-80 lg:w-96 shrink-0 h-full border-r border-glass-border/40 flex flex-col bg-surface">
          <ConversationSidebar />
        </aside>

        {/* Right: Desktop Main Chat Empty State */}
        <section
          aria-label="Main chat area"
          className="hidden md:flex flex-1 flex-col items-center justify-center p-8 bg-surface-2/20 text-center select-none"
        >
          <div className="mx-auto max-w-sm flex flex-col items-center gap-4">
            <div className="flex items-center justify-center mb-1">
              <PookieLogo size="lg" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-ink">Your Conversations</h2>
              <p className="mt-1 text-xs text-ink-dim leading-relaxed">
                Select a conversation from the sidebar to view encrypted messages, or pair with someone new.
              </p>
            </div>
            <Link href="/connect" className="mt-1">
              <Button variant="raised" accent="info" className="text-xs !py-2 !px-4">
                Pair a new device
              </Button>
            </Link>
          </div>
        </section>
      </div>

      <TabBar active="Chat" />
    </div>
  );
}

