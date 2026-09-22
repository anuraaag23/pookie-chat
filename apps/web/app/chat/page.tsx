'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { ThemedErrorState } from '@/components/ui/ThemedErrorState';
import { TabBar } from '@/components/chat/TabBar';
import { useAuth } from '@/lib/auth/AuthContext';
import { api } from '@/lib/api/client';
import { idbGet, idbSet } from '@/lib/storage/localDb';
import { checkLocalSecret, hashLocalSecret } from '@/lib/localauth/localSecret';
import { searchLocalMessages, SearchResult } from '@/lib/crypto/messageCache';

interface ConversationSummary {
  id: string;
  userAId: string;
  userBId: string;
  status: string;
  createdAt: string;
}

export default function ChatListPage() {
  const { userId, loading } = useAuth();
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [revealedHiddenId, setRevealedHiddenId] = useState<string | null>(null);
  const [messageResults, setMessageResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    if (!loading && !userId) router.push('/register');
  }, [loading, userId, router]);

  function loadConversations() {
    setLoadError(false);
    api<ConversationSummary[]>('/api/conversations')
      .then(setConversations)
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    if (userId) loadConversations();
  }, [userId]);

  // Re-hide whenever this screen is left — a revealed hidden chat should
  // not still be showing if the person comes back to this tab later.
  useEffect(() => {
    return () => setRevealedHiddenId(null);
  }, []);

  // Every keystroke does two independent things:
  //  1. A real local search over cached decrypted message text.
  //  2. A hidden-chat unlock check, at the SAME cost whether or not a
  //     hidden chat is configured (see checkLocalSecret) — so nothing
  //     about response timing reveals that the feature exists. A wrong
  //     guess looks exactly like a search with no matches.
  async function onSearchChange(value: string) {
    setQuery(value);
    if (value.length === 0) {
      setRevealedHiddenId(null);
      setMessageResults([]);
      return;
    }

    const [hiddenId, verifier] = await Promise.all([
      idbGet<string>('hiddenChat:conversationId'),
      idbGet<string>('hiddenChat:verifier'),
    ]);

    // The hidden conversation must never surface through this search box —
    // that would defeat the entire point of hiding it. Excluded from the
    // searched corpus outright, unconditionally, not filtered from results
    // after the fact and not contingent on whether this exact keystroke
    // also happens to be the unlock phrase.
    const searchableIds = conversations.filter((c) => c.id !== hiddenId).map((c) => c.id);
    const results = await searchLocalMessages(searchableIds, value);
    setMessageResults(results);

    const unlocked = await checkLocalSecret(value, verifier ?? null);
    if (unlocked && hiddenId) setRevealedHiddenId(hiddenId);
  }

  const visibleConversations = conversations.filter((c) => c.status !== 'DELETED');

  return (
    <main className="flex min-h-screen flex-col p-4 pb-24 lg:pb-8 lg:pl-56">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col md:max-w-xl lg:max-w-2xl">
      <header className="mb-1 px-1 py-2 text-[17px] font-bold">Pookie Chat</header>

      <div className="glass mb-3.5 flex items-center gap-2.5 rounded-lg px-4 py-2.5 text-ink-dim">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-[17px] w-[17px] flex-shrink-0" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={query}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search"
          aria-label="Search"
          className="w-full bg-transparent text-sm text-ink placeholder:text-ink-dim focus:outline-none"
        />
      </div>

      {query.length > 0 && messageResults.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-ink-dim">Messages</div>
          {messageResults.map((r) => (
            <NeoSurface key={r.id} variant="pressed" className="cursor-pointer p-3" onClick={() => router.push(`/chat/${r.conversationId}`)}>
              <div className="text-sm">{r.snippet}</div>
              <div className="mt-1 text-[11px] text-ink-dim">{new Date(r.sentAt).toLocaleString()}</div>
            </NeoSurface>
          ))}
        </div>
      )}

      <div className="flex flex-1 flex-col gap-2">
        {visibleConversations.map((c) => (
          <ConversationRow key={c.id} conversation={c} revealedHiddenId={revealedHiddenId} onOpen={() => router.push(`/chat/${c.id}`)} />
        ))}
        {loadError && (
          <ThemedErrorState
            compact
            category="backend-unavailable"
            title="Couldn't load conversations"
            message="Check your connection and try again."
            onRetry={loadConversations}
          />
        )}
        {!loadError && visibleConversations.length === 0 && (
          <NeoSurface variant="pressed" className="p-6 text-center text-sm text-ink-dim">
            No conversations yet. Use Connect to pair with someone.
          </NeoSurface>
        )}
      </div>

      </div>

      <TabBar active="Chat" />
    </main>
  );
}

function ConversationRow({
  conversation,
  revealedHiddenId,
  onOpen,
}: {
  conversation: ConversationSummary;
  revealedHiddenId: string | null;
  onOpen: () => void;
}) {
  const [isHidden, setIsHidden] = useState<boolean | null>(null);

  useEffect(() => {
    idbGet<string>('hiddenChat:conversationId').then((hiddenId) => setIsHidden(hiddenId === conversation.id));
  }, [conversation.id]);

  async function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    // Deliberately generic wording — this fires from an unlabeled gesture
    // nothing on screen points to, but if it's ever triggered by accident
    // (a stray long-press), the prompt itself shouldn't be the thing that
    // gives the feature away.
    const phrase = window.prompt('Confirm:');
    if (!phrase || phrase.length < 6) return;
    if (phrase !== window.prompt('Confirm again:')) return;
    const verifier = await hashLocalSecret(phrase);
    await idbSet('hiddenChat:verifier', verifier);
    await idbSet('hiddenChat:conversationId', conversation.id);
    setIsHidden(true);
  }

  if (isHidden === null) return null; // avoid a flash of the hidden row before the check resolves
  if (isHidden && revealedHiddenId !== conversation.id) return null;

  return (
    <NeoSurface variant="raised" className="cursor-pointer p-4" onClick={onOpen} onContextMenu={handleContextMenu}>
      <div className="text-sm font-semibold">{conversation.status.startsWith('BLOCKED') ? 'Blocked conversation' : 'Conversation'}</div>
      <div className="text-xs text-ink-dim">Started {new Date(conversation.createdAt).toLocaleDateString()}</div>
    </NeoSurface>
  );
}
