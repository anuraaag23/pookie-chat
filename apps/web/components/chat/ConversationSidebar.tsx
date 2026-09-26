'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { ThemedErrorState } from '@/components/ui/ThemedErrorState';
import { Button } from '@/components/ui/Button';
import { NeoInput } from '@/components/ui/NeoInput';
import { api } from '@/lib/api/client';
import { useAuth } from '@/lib/auth/AuthContext';
import { searchLocalMessages, SearchResult, clearCachedMessages } from '@/lib/crypto/messageCache';
import { deleteSession } from '@/lib/crypto/sessionStore';
import {
  getHiddenChatIds,
  hideChat,
  unhideChat,
  getLockedChatIds,
  lockChat,
  unlockChatPermanently,
  isChatSessionUnlocked,
  setChatSessionUnlocked,
  verifyAccountPassword,
} from '@/lib/chatlock/chatLockState';

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
  const { userId } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [messageResults, setMessageResults] = useState<SearchResult[]>([]);

  // Hidden and locked chat ID states
  const [hiddenChatIds, setHiddenChatIds] = useState<string[]>([]);
  const [lockedChatIds, setLockedChatIds] = useState<string[]>([]);
  const [showHiddenSection, setShowHiddenSection] = useState(false);

  // Action Menu & Modal States
  const [actionConv, setActionConv] = useState<ConversationSummary | null>(null);
  const [actionModal, setActionModal] = useState<'sheet' | 'unlock' | 'remove-lock' | 'block' | 'burn' | null>(null);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [removeLockPassword, setRemoveLockPassword] = useState('');
  const [removeLockError, setRemoveLockError] = useState<string | null>(null);
  const [burnPassword, setBurnPassword] = useState('');
  const [burnError, setBurnError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function loadAll() {
    setLoadError(false);
    Promise.all([
      api<ConversationSummary[]>('/api/conversations').catch(() => []),
      api<RoomSummary[]>('/api/rooms').catch(() => []),
      getHiddenChatIds(userId).catch(() => []),
      getLockedChatIds(userId).catch(() => []),
    ])
      .then(([convs, rms, hidden, locked]) => {
        setConversations(convs);
        setRooms(rms);
        setHiddenChatIds(hidden);
        setLockedChatIds(locked);
      })
      .catch(() => setLoadError(true));
  }

  useEffect(() => {
    loadAll();
  }, [userId]);

  // Keyboard navigation for modal escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && actionModal && !actionLoading) {
        closeAllModals();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actionModal, actionLoading]);

  function closeAllModals() {
    setActionModal(null);
    setActionConv(null);
    setUnlockPassword('');
    setUnlockError(null);
    setRemoveLockPassword('');
    setRemoveLockError(null);
    setBurnPassword('');
    setBurnError(null);
    setActionError(null);
    setActionLoading(false);
  }

  async function onSearchChange(value: string) {
    setQuery(value);
    if (value.length === 0) {
      setMessageResults([]);
      return;
    }

    // Exclude both hidden and locked conversations from local search message results
    const excludedIds = new Set([...hiddenChatIds, ...lockedChatIds]);
    const searchableIds = conversations.filter((c) => !excludedIds.has(c.id)).map((c) => c.id);
    if (searchableIds.length > 0) {
      const results = await searchLocalMessages(searchableIds, value);
      setMessageResults(results);
    } else {
      setMessageResults([]);
    }
  }

  const normalizedQuery = query.trim().toLowerCase();

  // Visible (non-hidden) conversations
  const visibleConversations = conversations.filter(
    (c) =>
      c.status !== 'DELETED' &&
      !hiddenChatIds.includes(c.id) &&
      (normalizedQuery
        ? c.otherUser?.username.toLowerCase().includes(normalizedQuery) ||
          c.otherUser?.displayName?.toLowerCase().includes(normalizedQuery)
        : true),
  );

  // Dedicated Hidden conversations
  const hiddenConversations = conversations.filter(
    (c) =>
      c.status !== 'DELETED' &&
      hiddenChatIds.includes(c.id) &&
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
    // If conversation is locked and not yet unlocked in current tab session, prompt unlock modal
    if (lockedChatIds.includes(id) && !isChatSessionUnlocked(id)) {
      const conv = conversations.find((c) => c.id === id);
      if (conv) {
        setActionConv(conv);
        setActionModal('unlock');
        return;
      }
    }
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

  const handleOpenActionMenu = (conv: ConversationSummary) => {
    setActionConv(conv);
    setActionModal('sheet');
  };

  // Actions
  async function handleToggleHide() {
    if (!actionConv) return;
    try {
      setActionLoading(true);
      const isHidden = hiddenChatIds.includes(actionConv.id);
      if (isHidden) {
        await unhideChat(actionConv.id, userId);
        setHiddenChatIds((prev) => prev.filter((id) => id !== actionConv.id));
      } else {
        await hideChat(actionConv.id, userId);
        setHiddenChatIds((prev) => (prev.includes(actionConv.id) ? prev : [...prev, actionConv.id]));
      }
      closeAllModals();
    } catch (err: any) {
      setActionError(err.message || 'Failed to update hidden status.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleToggleLock() {
    if (!actionConv) return;
    const isLocked = lockedChatIds.includes(actionConv.id);
    if (isLocked) {
      // Removing permanent lock requires account password re-auth
      setActionModal('remove-lock');
    } else {
      try {
        setActionLoading(true);
        await lockChat(actionConv.id, userId);
        setLockedChatIds((prev) => (prev.includes(actionConv.id) ? prev : [...prev, actionConv.id]));
        closeAllModals();
      } catch (err: any) {
        setActionError(err.message || 'Failed to lock conversation.');
      } finally {
        setActionLoading(false);
      }
    }
  }

  async function handleConfirmUnlockSession(e: React.FormEvent) {
    e.preventDefault();
    if (!actionConv) return;
    if (!unlockPassword.trim()) {
      setUnlockError('Password is required.');
      return;
    }

    try {
      setActionLoading(true);
      setUnlockError(null);
      const valid = await verifyAccountPassword(unlockPassword);
      if (valid) {
        setChatSessionUnlocked(actionConv.id, true);
        const targetId = actionConv.id;
        closeAllModals();
        if (onSelect) {
          onSelect(targetId, false);
        } else {
          router.push(`/chat/${targetId}`);
        }
      } else {
        setUnlockError('Incorrect account password. If you signed in with Google, please set a password in Settings.');
      }
    } catch (err: any) {
      setUnlockError(err.message || 'Verification failed. Please try again.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmRemoveLock(e: React.FormEvent) {
    e.preventDefault();
    if (!actionConv) return;
    if (!removeLockPassword.trim()) {
      setRemoveLockError('Password is required.');
      return;
    }

    try {
      setActionLoading(true);
      setRemoveLockError(null);
      const valid = await verifyAccountPassword(removeLockPassword);
      if (valid) {
        await unlockChatPermanently(actionConv.id, userId);
        setLockedChatIds((prev) => prev.filter((id) => id !== actionConv.id));
        closeAllModals();
      } else {
        setRemoveLockError('Incorrect account password. If you signed in with Google, please set a password in Settings.');
      }
    } catch (err: any) {
      setRemoveLockError(err.message || 'Verification failed. Please try again.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmBlock() {
    if (!actionConv) return;
    try {
      setActionLoading(true);
      setActionError(null);
      const isBlocked = actionConv.status.startsWith('BLOCKED');
      const endpoint = isBlocked
        ? `/api/conversations/${actionConv.id}/unblock`
        : `/api/conversations/${actionConv.id}/block`;
      await api(endpoint, { method: 'POST' });
      loadAll();
      closeAllModals();
    } catch (err: any) {
      setActionError(err.message || 'Action failed.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmBurn(e: React.FormEvent) {
    e.preventDefault();
    if (!actionConv) return;
    if (!burnPassword) {
      setBurnError('Account password is required to burn a conversation.');
      return;
    }

    try {
      setActionLoading(true);
      setBurnError(null);
      await api(`/api/conversations/${actionConv.id}/burn`, {
        method: 'POST',
        body: JSON.stringify({ password: burnPassword }),
      });
      await deleteSession(actionConv.id);
      await clearCachedMessages(actionConv.id);

      const burnedId = actionConv.id;
      closeAllModals();
      loadAll();

      if (burnedId === activeConversationId) {
        router.push('/chat');
      }
    } catch (err: any) {
      setBurnError(err.message || 'Failed to burn conversation. Please verify your password.');
    } finally {
      setActionLoading(false);
    }
  }

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
              className="text-xs text-ink-dim hover:text-ink p-0.5 rounded"
              aria-label="Clear search"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
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

        {/* 1-on-1 Direct Messages Section (Normal Chats) */}
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
              isLocked={lockedChatIds.includes(c.id)}
              isHidden={false}
              onOpen={() => handleSelectConv(c.id)}
              onOpenActionMenu={handleOpenActionMenu}
            />
          ))}
        </div>

        {/* Dedicated Hidden Chats Section */}
        {hiddenConversations.length > 0 && (
          <div className="pt-2 border-t border-glass-border/30 space-y-1.5">
            <button
              type="button"
              onClick={() => setShowHiddenSection((prev) => !prev)}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-surface-2/60 text-ink-dim hover:text-ink transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
              aria-expanded={showHiddenSection}
            >
              <div className="flex items-center gap-2">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-warning">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <span className="text-[10px] font-bold uppercase tracking-wider">
                  Hidden Chats ({hiddenConversations.length})
                </span>
              </div>
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className={`transition-transform duration-200 text-ink-dim ${showHiddenSection ? 'rotate-180' : ''}`}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {showHiddenSection && (
              <div className="space-y-1.5">
                {hiddenConversations.map((c) => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    isActive={c.id === activeConversationId}
                    isLocked={lockedChatIds.includes(c.id)}
                    isHidden={true}
                    onOpen={() => handleSelectConv(c.id)}
                    onOpenActionMenu={handleOpenActionMenu}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {loadError && (
          <ThemedErrorState
            compact
            category="backend-unavailable"
            title="Couldn't load conversations"
            message="Check your connection and try again."
            onRetry={loadAll}
          />
        )}

        {!loadError && visibleConversations.length === 0 && hiddenConversations.length === 0 && visibleRooms.length === 0 && (
          <NeoSurface variant="pressed" className="p-5 text-center text-xs text-ink-dim my-2">
            <p>No conversations or rooms yet.</p>
            <p className="mt-1 text-[11px] opacity-80">Use Connect to pair or join a room.</p>
          </NeoSurface>
        )}
      </div>

      {/* Action Sheet (Mobile Bottom Sheet / Desktop Modal) */}
      {actionModal === 'sheet' && actionConv && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="action-sheet-title"
          className="fixed inset-0 z-50 flex sm:items-center items-end justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAllModals();
          }}
        >
          <NeoSurface
            variant="raised"
            className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-4 sm:p-5 flex flex-col gap-3 bg-surface border border-glass-border/60 shadow-2xl animate-in slide-in-from-bottom sm:slide-in-from-bottom-0 sm:zoom-in-95 duration-200"
          >
            {/* Grab handle for mobile */}
            <div className="w-10 h-1 rounded-full bg-ink-dim/30 mx-auto -mt-1 sm:hidden shrink-0" />

            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-full bg-surface-2 flex items-center justify-center font-bold text-xs text-ink shrink-0 border border-glass-border/40">
                  {actionConv.otherUser?.username?.[0]?.toUpperCase() || 'E'}
                </div>
                <div className="min-w-0">
                  <h3 id="action-sheet-title" className="text-sm font-bold text-ink truncate">
                    {actionConv.otherUser?.username ? `@${actionConv.otherUser.username}` : 'Encrypted Chat'}
                  </h3>
                  <p className="text-[10.5px] text-ink-dim truncate">
                    {actionConv.status.startsWith('BLOCKED')
                      ? 'Blocked Contact'
                      : lockedChatIds.includes(actionConv.id)
                      ? 'Locked with password'
                      : hiddenChatIds.includes(actionConv.id)
                      ? 'Hidden conversation'
                      : actionConv.status === 'ACTIVE'
                      ? 'End-to-end encrypted'
                      : 'Closed'}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close menu"
                className="!h-7 !w-7"
                onClick={closeAllModals}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </Button>
            </div>

            <div className="h-px bg-glass-border/40 my-1" />

            {/* Menu Options */}
            <div className="flex flex-col gap-2">
              {/* Open */}
              <button
                type="button"
                className="w-full flex items-center gap-3 p-2.5 rounded-xl text-left hover:bg-surface-2 active:bg-surface-2/80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                onClick={() => {
                  const targetId = actionConv.id;
                  closeAllModals();
                  handleSelectConv(targetId);
                }}
              >
                <div className="w-7 h-7 rounded-lg bg-info/10 text-info flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink">Open Conversation</div>
                  <div className="text-[10.5px] text-ink-dim">View messages and chat</div>
                </div>
              </button>

              {/* Hide / Unhide Chat */}
              <button
                type="button"
                className="w-full flex items-center gap-3 p-2.5 rounded-xl text-left hover:bg-surface-2 active:bg-surface-2/80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                onClick={handleToggleHide}
              >
                <div className="w-7 h-7 rounded-lg bg-accent-warning/10 text-accent-warning flex items-center justify-center shrink-0">
                  {hiddenChatIds.includes(actionConv.id) ? (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink">
                    {hiddenChatIds.includes(actionConv.id) ? 'Unhide Conversation' : 'Hide Conversation'}
                  </div>
                  <div className="text-[10.5px] text-ink-dim">
                    {hiddenChatIds.includes(actionConv.id)
                      ? 'Restore to main active chat list'
                      : 'Move out of view into Hidden Chats section'}
                  </div>
                </div>
              </button>

              {/* Lock / Unlock Chat */}
              <button
                type="button"
                className="w-full flex items-center gap-3 p-2.5 rounded-xl text-left hover:bg-surface-2 active:bg-surface-2/80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                onClick={handleToggleLock}
              >
                <div className="w-7 h-7 rounded-lg bg-accent-warning/10 text-accent-warning flex items-center justify-center shrink-0">
                  {lockedChatIds.includes(actionConv.id) ? (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink">
                    {lockedChatIds.includes(actionConv.id) ? 'Unlock Chat (Remove Lock)' : 'Lock Chat'}
                  </div>
                  <div className="text-[10.5px] text-ink-dim">
                    {lockedChatIds.includes(actionConv.id)
                      ? 'Remove password requirement from this chat'
                      : 'Require account password to open conversation'}
                  </div>
                </div>
              </button>

              {/* Block / Unblock Contact */}
              <button
                type="button"
                className="w-full flex items-center gap-3 p-2.5 rounded-xl text-left hover:bg-surface-2 active:bg-surface-2/80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                onClick={() => setActionModal('block')}
              >
                <div className="w-7 h-7 rounded-lg bg-ink-dim/10 text-ink-dim flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-ink">
                    {actionConv.status.startsWith('BLOCKED') ? 'Unblock Contact' : 'Block Contact'}
                  </div>
                  <div className="text-[10.5px] text-ink-dim">
                    {actionConv.status.startsWith('BLOCKED')
                      ? 'Allow messages from this contact'
                      : 'Stop receiving messages from this contact'}
                  </div>
                </div>
              </button>

              {/* Burn Conversation */}
              <button
                type="button"
                className="w-full flex items-center gap-3 p-2.5 rounded-xl text-left hover:bg-danger/10 active:bg-danger/20 transition-colors group focus-visible:outline focus-visible:outline-2 focus-visible:outline-danger"
                onClick={() => setActionModal('burn')}
              >
                <div className="w-7 h-7 rounded-lg bg-danger/15 text-danger flex items-center justify-center shrink-0">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2c1 3 4 5 4 9a6 6 0 0 1-12 0c0-4 3-6 4-9 1 2 2 3 4 0z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-danger">Burn Conversation</div>
                  <div className="text-[10.5px] text-danger/80">Permanent purge · Password required</div>
                </div>
              </button>
            </div>

            <Button
              variant="ghost"
              className="w-full text-xs mt-1"
              onClick={closeAllModals}
            >
              Cancel
            </Button>
          </NeoSurface>
        </div>
      )}

      {/* Unlock Chat Modal (Session Re-authentication) */}
      {actionModal === 'unlock' && actionConv && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="unlock-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget && !actionLoading) closeAllModals();
          }}
        >
          <NeoSurface
            variant="raised"
            className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-4 bg-surface border border-glass-border/60 shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-warning/10 text-accent-warning flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </div>
              <div>
                <h3 id="unlock-modal-title" className="text-sm font-bold text-ink">Locked Conversation</h3>
                <p className="text-[11px] text-ink-dim">
                  @{actionConv.otherUser?.username || 'conversation'}
                </p>
              </div>
            </div>

            <p className="text-xs text-ink-dim leading-relaxed">
              This conversation is protected. Enter your account password to unlock it for this session.
            </p>

            <form onSubmit={handleConfirmUnlockSession} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-ink-dim">Account Password</label>
                <NeoInput
                  type="password"
                  placeholder="Enter account password"
                  value={unlockPassword}
                  onChange={(e) => {
                    setUnlockPassword(e.target.value);
                    if (unlockError) setUnlockError(null);
                  }}
                  autoFocus
                  required
                />
              </div>

              {unlockError && (
                <div className="text-[11px] text-danger font-medium leading-tight">{unlockError}</div>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 text-xs"
                  disabled={actionLoading}
                  onClick={closeAllModals}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="raised"
                  accent="info"
                  className="flex-1 text-xs font-bold"
                  disabled={actionLoading || !unlockPassword.trim()}
                >
                  {actionLoading ? 'Verifying…' : 'Unlock Chat'}
                </Button>
              </div>
            </form>
          </NeoSurface>
        </div>
      )}

      {/* Remove Lock Modal (Permanent Removal) */}
      {actionModal === 'remove-lock' && actionConv && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-lock-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget && !actionLoading) closeAllModals();
          }}
        >
          <NeoSurface
            variant="raised"
            className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-4 bg-surface border border-glass-border/60 shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-accent-warning/10 text-accent-warning flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                </svg>
              </div>
              <div>
                <h3 id="remove-lock-modal-title" className="text-sm font-bold text-ink">Remove Chat Lock</h3>
                <p className="text-[11px] text-ink-dim">
                  @{actionConv.otherUser?.username || 'conversation'}
                </p>
              </div>
            </div>

            <p className="text-xs text-ink-dim leading-relaxed">
              Enter your account password to remove lock protection from this conversation permanently.
            </p>

            <form onSubmit={handleConfirmRemoveLock} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-ink-dim">Account Password</label>
                <NeoInput
                  type="password"
                  placeholder="Enter account password"
                  value={removeLockPassword}
                  onChange={(e) => {
                    setRemoveLockPassword(e.target.value);
                    if (removeLockError) setRemoveLockError(null);
                  }}
                  autoFocus
                  required
                />
              </div>

              {removeLockError && (
                <div className="text-[11px] text-danger font-medium leading-tight">{removeLockError}</div>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 text-xs"
                  disabled={actionLoading}
                  onClick={closeAllModals}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="raised"
                  className="flex-1 text-xs font-bold"
                  disabled={actionLoading || !removeLockPassword.trim()}
                >
                  {actionLoading ? 'Verifying…' : 'Remove Lock'}
                </Button>
              </div>
            </form>
          </NeoSurface>
        </div>
      )}

      {/* Block / Unblock Confirmation Modal */}
      {actionModal === 'block' && actionConv && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="block-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget && !actionLoading) closeAllModals();
          }}
        >
          <NeoSurface
            variant="raised"
            className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-4 bg-surface border border-glass-border/60 shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-danger/15 text-danger flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
              </div>
              <div>
                <h3 id="block-modal-title" className="text-sm font-bold text-ink">
                  {actionConv.status.startsWith('BLOCKED') ? 'Unblock Contact' : 'Block Contact'}
                </h3>
                <p className="text-[11px] text-ink-dim">
                  @{actionConv.otherUser?.username || 'this user'}
                </p>
              </div>
            </div>

            <p className="text-xs text-ink-dim leading-relaxed">
              {actionConv.status.startsWith('BLOCKED')
                ? 'Unblocking will allow this user to send you encrypted messages and see when you are online.'
                : 'Blocking will prevent this user from sending you messages or seeing your online status. Existing messages remain on your device.'}
            </p>

            {actionError && (
              <div className="text-[11px] text-danger font-medium">{actionError}</div>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                className="flex-1 text-xs"
                disabled={actionLoading}
                onClick={closeAllModals}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="raised"
                accent={actionConv.status.startsWith('BLOCKED') ? 'info' : 'danger'}
                className="flex-1 text-xs font-bold"
                disabled={actionLoading}
                onClick={handleConfirmBlock}
              >
                {actionLoading
                  ? 'Updating…'
                  : actionConv.status.startsWith('BLOCKED')
                  ? 'Confirm Unblock'
                  : 'Confirm Block'}
              </Button>
            </div>
          </NeoSurface>
        </div>
      )}

      {/* Burn Conversation Password Re-auth Modal */}
      {actionModal === 'burn' && actionConv && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="burn-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget && !actionLoading) closeAllModals();
          }}
        >
          <NeoSurface
            variant="raised"
            className="w-full max-w-sm rounded-2xl p-5 flex flex-col gap-4 bg-surface border border-danger/30 shadow-2xl"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-danger/15 text-danger flex items-center justify-center shrink-0">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2c1 3 4 5 4 9a6 6 0 0 1-12 0c0-4 3-6 4-9 1 2 2 3 4 0z" />
                </svg>
              </div>
              <div>
                <h3 id="burn-modal-title" className="text-sm font-bold text-danger">Burn Conversation</h3>
                <p className="text-[11px] text-ink-dim">
                  Permanently destroy chat & keys
                </p>
              </div>
            </div>

            <p className="text-xs text-ink-dim leading-relaxed">
              This will permanently delete the conversation and wipe all encryption keys on both your device and the other participant&apos;s device. This cannot be undone.
            </p>

            <form onSubmit={handleConfirmBurn} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-ink-dim">
                  Confirm with Account Password
                </label>
                <NeoInput
                  type="password"
                  placeholder="Enter your account password"
                  value={burnPassword}
                  onChange={(e) => {
                    setBurnPassword(e.target.value);
                    if (burnError) setBurnError(null);
                  }}
                  autoFocus
                  required
                />
              </div>

              {burnError && (
                <div className="text-[11px] text-danger font-medium">{burnError}</div>
              )}

              <div className="flex gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1 text-xs"
                  disabled={actionLoading}
                  onClick={closeAllModals}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="raised"
                  accent="danger"
                  className="flex-1 text-xs font-bold"
                  disabled={actionLoading || !burnPassword.trim()}
                >
                  {actionLoading ? 'Burning…' : 'Burn Conversation'}
                </Button>
              </div>
            </form>
          </NeoSurface>
        </div>
      )}
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
  isLocked,
  isHidden,
  onOpen,
  onOpenActionMenu,
}: {
  conversation: ConversationSummary;
  isActive: boolean;
  isLocked?: boolean;
  isHidden?: boolean;
  onOpen: () => void;
  onOpenActionMenu: (conv: ConversationSummary) => void;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const isLongPressRef = useRef(false);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function handleTouchStart(e: React.TouchEvent) {
    clearTimer();
    isLongPressRef.current = false;
    const touch = e.touches[0];
    if (!touch) return;
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      try {
        navigator.vibrate?.(40);
      } catch {}
      onOpenActionMenu(conversation);
    }, 500);
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!touchStartPos.current) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = Math.abs(touch.clientX - touchStartPos.current.x);
    const dy = Math.abs(touch.clientY - touchStartPos.current.y);
    if (dx > 10 || dy > 10) {
      clearTimer();
    }
  }

  function handleTouchEnd(e: React.TouchEvent) {
    clearTimer();
    if (isLongPressRef.current) {
      if (e.cancelable) e.preventDefault();
      setTimeout(() => {
        isLongPressRef.current = false;
      }, 300);
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    clearTimer();
    onOpenActionMenu(conversation);
  }

  function handleClick() {
    if (isLongPressRef.current) {
      isLongPressRef.current = false;
      return;
    }
    onOpen();
  }

  return (
    <NeoSurface
      variant={isActive ? 'pressed' : 'raised'}
      className={`cursor-pointer p-3 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-info focus-visible:outline-offset-1 rounded-xl select-none ${
        isActive ? 'ring-1 ring-info/60 bg-surface-2' : 'hover:opacity-95'
      }`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={clearTimer}
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
          {isLocked && (
            <span title="Locked conversation" className="text-accent-warning shrink-0" aria-label="Locked">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
          )}
        </div>
        <span className="text-[10.5px] text-ink-dim shrink-0">
          {new Date(conversation.createdAt).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
          })}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-ink-dim pl-4.5">
        <span className={`truncate ${isLocked ? 'italic text-ink-dim/80' : ''}`}>
          {isLocked
            ? 'Locked conversation'
            : conversation.otherUser?.displayName
            ? conversation.otherUser.displayName
            : isActive
            ? 'Active in view'
            : conversation.status === 'ACTIVE'
            ? 'Connected & encrypted'
            : 'Conversation closed'}
        </span>
        {isHidden && (
          <span className="text-[9px] uppercase tracking-wider font-semibold text-accent-warning bg-accent-warning/10 px-1 py-0.5 rounded ml-2 shrink-0">
            Hidden
          </span>
        )}
      </div>
    </NeoSurface>
  );
}
