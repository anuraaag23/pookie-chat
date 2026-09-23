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
  otherUser?: {
    id: string;
    username: string;
    displayName?: string | null;
  };
}

export interface RoomSummary {
  id: string;
  name: string;
  maxMembers: number;
  memberCount: number;
  joinPolicy: 'OPEN' | 'APPROVAL_REQUIRED';
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  owner: { id: string; username: string; displayName?: string | null };
  lastMessage?: { id: string; sentAt: string; messageType: string } | null;
  createdAt: string;
  updatedAt: string;
}

interface ConversationSidebarProps {
  activeConversationId?: string;
  activeRoomId?: string;
  onSelect?: (id: string, isRoom?: boolean) => void;
  className?: string;
}

export function ConversationSidebar({
  activeConversationId,
  activeRoomId,
  onSelect,
  className = '',
}: ConversationSidebarProps) {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [revealedHiddenId, setRevealedHiddenId] = useState<string | null>(null);
  const [messageResults, setMessageResults] = useState<SearchResult[]>([]);

  function loadAll() {
    setLoadError(false);
    Promise.all([
      api<ConversationSummary[]>('/api/conversations').catch(() => []),
      api<RoomSummary[]>('/api/rooms').catch(() => []),
    ])
      .then(([convs, rms]) => {
        setConversations(convs);
        setRooms(rms);
      })
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    loadAll();
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

  const normalizedQuery = query.trim().toLowerCase();
  const visibleConversations = conversations.filter(
    (c) =>
      c.status !== 'DELETED' &&
      (normalizedQuery
        ? c.otherUser?.username.toLowerCase().includes(normalizedQuery) ||
          c.otherUser?.displayName?.toLowerCase().includes(normalizedQuery)
        : true),
  );

  const visibleRooms = rooms.filter(
    (r) =>
      !normalizedQuery ||
      r.name.toLowerCase().includes(normalizedQuery) ||
      r.owner.username.toLowerCase().includes(normalizedQuery),
  );

  const handleSelectConv = (id: string) => {
    if (onSelect) {
      onSelect(id, false);
    } else {
      router.push(`/chat/${id}`);
    }
  };

  const handleSelectRoom = (id: string) => {
    if (onSelect) {
      onSelect(id, true);
    } else {
      router.push(`/chat/room/${id}`);
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
            placeholder="Search chats and rooms..."
            aria-label="Search chats and rooms"
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
              onClick={() => handleSelectConv(r.conversationId)}
            >
              <div className="text-xs truncate font-medium">{r.snippet}</div>
              <div className="mt-0.5 text-[10px] text-ink-dim">
                {new Date(r.sentAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
              </div>
            </NeoSurface>
          ))}
        </div>
      )}

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto px-3 space-y-3 pb-24 md:pb-4">
        <div className="flex items-center justify-between px-1 pt-1">
          <span className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">
            Conversations
          </span>
          <button
            type="button"
            onClick={loadAll}
            className="text-[11px] text-info hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-info rounded"
            title="Refresh list"
          >
            Refresh
          </button>
        </div>

        {/* Chat Rooms Section */}
        {visibleRooms.length > 0 && (
          <div className="space-y-1.5">
            <div className="px-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-ink-dim/80">
              <span>Chat Rooms ({visibleRooms.length})</span>
            </div>
            {visibleRooms.map((r) => (
              <RoomItem
                key={r.id}
                room={r}
                isActive={r.id === activeRoomId}
                onOpen={() => handleSelectRoom(r.id)}
              />
            ))}
          </div>
        )}

        {/* 1-on-1 Direct Messages Section */}
        <div className="space-y-1.5">
          {visibleRooms.length > 0 && (
            <div className="px-1 text-[10px] font-bold uppercase tracking-wider text-ink-dim/80 pt-1">
              <span>Direct Messages ({visibleConversations.length})</span>
            </div>
          )}

          {visibleConversations.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              isActive={c.id === activeConversationId}
              revealedHiddenId={revealedHiddenId}
              onOpen={() => handleSelectConv(c.id)}
            />
          ))}
        </div>

        {loadError && (
          <ThemedErrorState
            compact
            category="backend-unavailable"
            title="Couldn't load conversations"
            message="Check your connection and try again."
            onRetry={loadAll}
          />
        )}

        {!loadError && visibleConversations.length === 0 && visibleRooms.length === 0 && (
          <NeoSurface variant="pressed" className="p-5 text-center text-xs text-ink-dim my-2">
            <p>No conversations or rooms yet.</p>
            <p className="mt-1 text-[11px] opacity-80">Use Connect to pair or join a room.</p>
          </NeoSurface>
        )}
      </div>
    </div>
  );
}

function RoomItem({
  room,
  isActive,
  onOpen,
}: {
  room: RoomSummary;
  isActive: boolean;
  onOpen: () => void;
}) {
  return (
    <NeoSurface
      variant={isActive ? 'pressed' : 'raised'}
      className={`cursor-pointer p-3 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-xl ${
        isActive ? 'ring-1 ring-info/60 bg-surface-2' : 'hover:opacity-95'
      }`}
      onClick={onOpen}
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
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-info/10 text-info flex items-center justify-center shrink-0 border border-info/20">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-3.5 h-3.5"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`text-xs sm:text-sm truncate ${isActive ? 'font-bold text-ink' : 'font-semibold text-ink'}`}>
                {room.name}
              </span>
              {room.role === 'OWNER' && (
                <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-accent-info/10 text-accent-info border border-accent-info/30 uppercase tracking-wider">
                  Owner
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="text-[10px] text-ink-dim shrink-0 font-medium">
          {room.memberCount}/{room.maxMembers}
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-dim pl-9.5">
        <span className="truncate">
          {isActive
            ? 'Active room'
            : room.role === 'OWNER'
            ? 'Room administrator'
            : `Joined · Owner: @${room.owner.username}`}
        </span>
      </div>
    </NeoSurface>
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
      setIsHidden(hiddenId === conversation.id),
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
        isActive ? 'ring-1 ring-info/60 bg-surface-2' : 'hover:opacity-95'
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
            {conversation.status.startsWith('BLOCKED')
              ? 'Blocked conversation'
              : conversation.otherUser?.username
              ? `@${conversation.otherUser.username}`
              : 'Encrypted Chat'}
          </span>
        </div>
        <span className="text-[10.5px] text-ink-dim shrink-0">
          {new Date(conversation.createdAt).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
          })}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-dim pl-4.5">
        <span className="truncate">
          {conversation.otherUser?.displayName
            ? conversation.otherUser.displayName
            : isActive
            ? 'Active in view'
            : conversation.status === 'ACTIVE'
            ? 'Connected & encrypted'
            : 'Conversation closed'}
        </span>
      </div>
    </NeoSurface>
  );
}
