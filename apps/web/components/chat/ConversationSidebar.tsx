'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { ThemedErrorState } from '@/components/ui/ThemedErrorState';
import { api } from '@/lib/api/client';
import { idbGet, idbSet } from '@/lib/storage/localDb';
import { checkLocalSecret, hashLocalSecret } from '@/lib/localauth/localSecret';
import { searchLocalMessages, SearchResult } from '@/lib/crypto/messageCache';

export interface ConversationSummary {
  id: string;
  userAId: string;
  userBId: string;
  status: string;
  createdAt: string;
}

interface ConversationSidebarProps {
  activeConversationId?: string;
  onSelect?: (id: string) => void;
  className?: string;
}

export function ConversationSidebar({
  activeConversationId,
  onSelect,
  className = '',
}: ConversationSidebarProps) {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [revealedHiddenId, setRevealedHiddenId] = useState<string | null>(null);
  const [messageResults, setMessageResults] = useState<SearchResult[]>([]);

  function loadConversations() {
    setLoadError(false);
    api<ConversationSummary[]>('/api/conversations')
      .then(setConversations)
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    loadConversations();
  }, []);

  useEffect(() => {
    return () => setRevealedHiddenId(null);
  }, []);

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

    const searchableIds = conversations.filter((c) => c.id !== hiddenId).map((c) => c.id);
    const results = await searchLocalMessages(searchableIds, value);
    setMessageResults(results);

    const unlocked = await checkLocalSecret(value, verifier ?? null);
    if (unlocked && hiddenId) setRevealedHiddenId(hiddenId);
  }

  const visibleConversations = conversations.filter((c) => c.status !== 'DELETED');

  const handleSelect = (id: string) => {
    if (onSelect) {
      onSelect(id);
    } else {
      router.push(`/chat/${id}`);
    }
  };

  return (
    <div className={`flex flex-col h-full overflow-hidden bg-surface ${className}`}>
      {/* Search Input in Liquid Glass style */}
      <div className="p-3 shrink-0">
        <div className="glass flex items-center gap-2.5 rounded-lg px-3.5 py-2 text-ink-dim">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            className="h-4 w-4 flex-shrink-0"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search messages..."
            aria-label="Search messages"
            className="w-full bg-transparent text-xs sm:text-sm text-ink placeholder:text-ink-dim focus:outline-none"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              className="text-xs text-ink-dim hover:text-ink"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Message search results when query is active */}
      {query.length > 0 && messageResults.length > 0 && (
        <div className="px-3 pb-2 flex flex-col gap-1.5 shrink-0 max-h-48 overflow-y-auto">
          <div className="px-1 text-[10.5px] font-bold uppercase tracking-wider text-ink-dim">
            Message Results
          </div>
          {messageResults.map((r) => (
            <NeoSurface
              key={r.id}
              variant="pressed"
              className="cursor-pointer p-2.5 hover:opacity-90"
              onClick={() => handleSelect(r.conversationId)}
            >
              <div className="text-xs truncate font-medium">{r.snippet}</div>
              <div className="mt-0.5 text-[10px] text-ink-dim">
                {new Date(r.sentAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            </NeoSurface>
          ))}
        </div>
      )}

      {/* Conversations Scrollable List */}
      <div className="flex-1 overflow-y-auto px-3 space-y-2 pb-24 md:pb-4">
        <div className="flex items-center justify-between px-1 pt-1 pb-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">
            Conversations ({visibleConversations.length})
          </span>
          <button
            type="button"
            onClick={loadConversations}
            className="text-[11px] text-info hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-info rounded"
            title="Refresh list"
          >
            Refresh
          </button>
        </div>

        {visibleConversations.map((c) => (
          <ConversationItem
            key={c.id}
            conversation={c}
            isActive={c.id === activeConversationId}
            revealedHiddenId={revealedHiddenId}
            onOpen={() => handleSelect(c.id)}
          />
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
          <NeoSurface variant="pressed" className="p-5 text-center text-xs text-ink-dim my-2">
            <p>No conversations yet.</p>
            <p className="mt-1 text-[11px] opacity-80">Use Connect to pair with someone.</p>
          </NeoSurface>
        )}
      </div>
    </div>
  );
}

function ConversationItem({
  conversation,
  isActive,
  revealedHiddenId,
  onOpen,
}: {
  conversation: ConversationSummary;
  isActive: boolean;
  revealedHiddenId: string | null;
  onOpen: () => void;
}) {
  const [isHidden, setIsHidden] = useState<boolean | null>(null);

  useEffect(() => {
    idbGet<string>('hiddenChat:conversationId').then((hiddenId) =>
      setIsHidden(hiddenId === conversation.id)
    );
  }, [conversation.id]);

  async function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const phrase = window.prompt('Confirm:');
    if (!phrase || phrase.length < 6) return;
    if (phrase !== window.prompt('Confirm again:')) return;
    const verifier = await hashLocalSecret(phrase);
    await idbSet('hiddenChat:verifier', verifier);
    await idbSet('hiddenChat:conversationId', conversation.id);
    setIsHidden(true);
  }

  if (isHidden === null) return null;
  if (isHidden && revealedHiddenId !== conversation.id) return null;

  return (
    <NeoSurface
      variant={isActive ? 'pressed' : 'raised'}
      className={`cursor-pointer p-3 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-xl ${
        isActive
          ? 'ring-1 ring-info/60 bg-surface-2'
          : 'hover:opacity-95'
      }`}
      onClick={onOpen}
      onContextMenu={handleContextMenu}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={`h-2.5 w-2.5 rounded-full shrink-0 ${
              conversation.status === 'ACTIVE' ? 'bg-positive' : 'bg-ink-dim/40'
            }`}
          />
          <span className={`text-xs sm:text-sm truncate ${isActive ? 'font-bold text-ink' : 'font-semibold text-ink'}`}>
            {conversation.status.startsWith('BLOCKED') ? 'Blocked conversation' : 'Encrypted Chat'}
          </span>
        </div>
        <span className="text-[10.5px] text-ink-dim shrink-0">
          {new Date(conversation.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-dim pl-4.5">
        <span className="truncate">
          {isActive ? 'Active in view' : conversation.status === 'ACTIVE' ? 'Connected & encrypted' : 'Conversation closed'}
        </span>
      </div>
    </NeoSurface>
  );
}
