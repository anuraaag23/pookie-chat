'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { MessageBubble, MessageStatusTicks } from '@/components/chat/MessageBubble';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { AppHeader } from '@/components/navigation/AppHeader';
import { ConversationSidebar } from '@/components/chat/ConversationSidebar';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { idbGet, idbSet } from '@/lib/storage/localDb';
import { getUserIdentity } from '@/lib/storage/userScope';
import { ratchetEncrypt, ratchetDecrypt, deriveNextChainKey, buildAad, completeHandshake, DeviceIdentity, HandshakeMessage } from '@/lib/crypto/engine';
import { loadSession, saveSession, initSession, deleteSession, StoredSession } from '@/lib/crypto/sessionStore';
import { isSessionStale } from '@/lib/crypto/sessionFreshness';
import { connectSocket } from '@/lib/realtime/socket';
import {
  getCachedMessages,
  appendCachedMessage,
  updateCachedMessage,
  removeCachedMessage,
  clearCachedMessages,
  CachedMessage,
} from '@/lib/crypto/messageCache';
import { enqueueOutboxItem, getOutboxItems, removeOutboxItem, OutboxItem } from '@/lib/storage/outboxStore';
import { encryptFile, decryptFile } from '@/lib/crypto/fileCrypto';
import { uploadAttachment, downloadAttachment } from '@/lib/api/client';
import { ImagePreviewModal } from '@/components/chat/ImagePreviewModal';
import {
  getScheduledMessages,
  saveScheduledMessage,
  removeScheduledMessage,
  getDueScheduledMessages,
  ScheduledMessageItem,
} from '@/lib/scheduled/scheduledMessages';
import { NeoInput } from '@/components/ui/NeoInput';
import {
  isChatLocked,
  isChatSessionUnlocked,
  setChatSessionUnlocked,
  verifyFeaturePassword,
  setFeaturePassword,
  lockChat,
  unlockChatPermanently,
  hideChat,
  unhideChat,
  isChatHidden,
} from '@/lib/chatlock/chatLockState';
import { formatCountdown, isTemporaryChatExpired } from '@/lib/pairing/temporaryChat';
import { TEMPORARY_DURATIONS } from '@/lib/pairing/durations';
import { CustomDurationPicker } from '@/components/pairing/CustomDurationPicker';

const DISAPPEARING_OPTIONS = [
  { label: 'Off', seconds: null as number | null },
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '1h', seconds: 3600 },
  { label: '1d', seconds: 86400 },
  { label: '7d', seconds: 604800 },
];

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface AttachmentPayload {
  kind: 'attachment';
  attachmentId: string;
  dek: string; // base64
  mimeTypeHint: 'image' | 'file';
  filename: string;
  caption?: string;
  viewOnce?: boolean;
  opened?: boolean;
}

function parseAttachmentPayload(text: string): AttachmentPayload | null {
  try {
    const parsed = JSON.parse(text);
    return parsed?.kind === 'attachment' ? (parsed as AttachmentPayload) : null;
  } catch {
    return null;
  }
}

function formatLastSeen(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (isNaN(d.getTime())) return 'recently';
    if (diffMs < 60 * 1000) return 'just now';
    if (diffMs < 60 * 60 * 1000) return `${Math.floor(diffMs / 60000)}m ago`;
    if (diffMs < 24 * 60 * 60 * 1000) return `${Math.floor(diffMs / 3600000)}h ago`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return 'recently';
  }
}

function DecryptedImageAttachment({
  payload,
  isMine,
  timestamp,
  status,
  replyTo,
  onReplyClick,
  onClick,
}: {
  payload: AttachmentPayload;
  isMine: boolean;
  timestamp?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed' | 'queued';
  replyTo?: { text: string; senderUsername?: string; messageId?: string } | null;
  onReplyClick?: (msgId: string) => void;
  onClick: () => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(!payload.viewOnce);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (payload.viewOnce) return;
    let cancelled = false;
    async function load() {
      try {
        const ciphertext = await downloadAttachment(payload.attachmentId);
        const dekBytes = Uint8Array.from(atob(payload.dek), (c) => c.charCodeAt(0));
        const mime = payload.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        const blob = await decryptFile(ciphertext, dekBytes, mime);
        if (!cancelled) {
          const url = URL.createObjectURL(blob);
          setImageUrl(url);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [payload.attachmentId, payload.dek, payload.viewOnce, payload.filename]);

  // View Once view (for both sender and recipient)
  if (payload.viewOnce) {
    if (payload.opened) {
      return (
        <NeoSurface
          variant="pressed"
          className={[
            'flex flex-col gap-1 p-2.5 rounded-xl opacity-80 text-left max-w-xs select-none',
            isMine ? 'self-end bg-surface-2' : 'self-start',
          ].join(' ')}
        >
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-full border border-ink-dim/40 text-ink-dim flex items-center justify-center text-[10px] font-bold shrink-0">
              1
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-semibold text-ink-dim">Opened Photo</span>
              <span className="text-[10px] text-ink-dim/70">View Once media expired</span>
            </div>
          </div>
          {(timestamp || status) && (
            <div className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-ink-dim shrink-0">
              {timestamp}
              {isMine && <MessageStatusTicks status={status} />}
            </div>
          )}
        </NeoSurface>
      );
    }

    if (isMine) {
      return (
        <NeoSurface
          variant="raised"
          className="flex flex-col gap-1 p-2.5 rounded-xl text-left max-w-xs select-none self-end bg-surface-2"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-full border-2 border-info bg-info/20 flex items-center justify-center text-xs font-black text-info shrink-0">
              1
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-bold leading-tight text-ink">Photo</span>
              <span className="text-[10px] text-ink-dim leading-tight">View once photo sent</span>
            </div>
          </div>
          {(timestamp || status) && (
            <div className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-ink-dim shrink-0">
              {timestamp}
              <MessageStatusTicks status={status} />
            </div>
          )}
        </NeoSurface>
      );
    }

    return (
      <NeoSurface
        variant="raised"
        onClick={onClick}
        role="button"
        tabIndex={0}
        className="flex flex-col gap-1 p-2.5 rounded-xl bg-info/10 border border-info/30 hover:bg-info/20 active:scale-[0.98] transition-all text-left max-w-xs cursor-pointer select-none self-start group shadow-sm"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-full border-2 border-info bg-info/20 flex items-center justify-center text-xs font-black text-info shrink-0">
            1
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-bold leading-tight text-info group-hover:underline">Photo</span>
            <span className="text-[10px] text-ink-dim leading-tight">Tap to view · Disappears after closing</span>
          </div>
        </div>
        {timestamp && (
          <div className="mt-0.5 flex items-center justify-end gap-1 text-[10.5px] text-ink-dim shrink-0">
            {timestamp}
          </div>
        )}
      </NeoSurface>
    );
  }

  return (
    <NeoSurface
      variant="raised"
      className={[
        'max-w-[85%] sm:max-w-[75%] min-w-0 p-2 text-sm leading-relaxed overflow-hidden transition-colors',
        isMine ? 'self-end rounded-br-md bg-surface-2' : 'self-start rounded-bl-md',
      ].join(' ')}
    >
      {replyTo && (
        <div
          onClick={(e) => {
            if (replyTo.messageId && onReplyClick) {
              e.stopPropagation();
              onReplyClick(replyTo.messageId);
            }
          }}
          className={`mb-2 p-2 rounded-lg border-l-2 border-info bg-surface-3/70 text-xs text-left min-w-0 transition-colors ${
            replyTo.messageId && onReplyClick ? 'cursor-pointer hover:bg-surface-3' : ''
          }`}
        >
          <div className="font-bold text-[11px] text-info truncate">
            {replyTo.senderUsername ? `@${replyTo.senderUsername}` : 'Replied message'}
          </div>
          <div className="text-[11px] text-ink-dim truncate mt-0.5 break-words [overflow-wrap:anywhere]">
            {replyTo.text}
          </div>
        </div>
      )}

      <div
        className="relative max-h-72 min-h-[120px] w-full rounded-xl overflow-hidden flex items-center justify-center bg-surface-3/40 neo-pressed cursor-pointer hover:opacity-95 transition-opacity"
        onClick={onClick}
        title="Click to view full image"
      >
        {payload.viewOnce && (
          <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-info/90 text-white text-[10px] font-bold shadow-md backdrop-blur-sm pointer-events-none">
            <span className="w-3.5 h-3.5 rounded-full bg-white text-info flex items-center justify-center text-[9px] font-black">1</span>
            <span>View Once</span>
          </div>
        )}
        {loading && (
          <div className="flex flex-col items-center gap-2 py-8 text-ink-dim text-xs">
            <div className="w-5 h-5 border-2 border-info border-t-transparent rounded-full animate-spin" />
            <span>Decrypting image…</span>
          </div>
        )}
        {failed && (
          <div className="flex items-center gap-2 p-4 text-xs text-danger">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
            <span>Failed to decrypt image</span>
          </div>
        )}
        {imageUrl && (
          <img
            src={imageUrl}
            alt={payload.filename || 'Encrypted image'}
            className="w-full h-auto max-h-72 object-contain rounded-lg"
          />
        )}
      </div>

      {payload.caption && (
        <div className="px-1.5 pt-2 pb-0.5 text-xs text-ink break-words [overflow-wrap:anywhere] whitespace-pre-wrap">
          {payload.caption}
        </div>
      )}

      {(timestamp || status) && (
        <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-ink-dim shrink-0 px-1">
          {timestamp}
          {isMine && <MessageStatusTicks status={status} />}
        </div>
      )}
    </NeoSurface>
  );
}

export default function ConversationPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { userId } = useAuth();
  const router = useRouter();
  const [messages, setMessages] = useState<CachedMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [peerTyping, setPeerTyping] = useState(false);
  const [replyTo, setReplyTo] = useState<CachedMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openActionsFor, setOpenActionsFor] = useState<string | null>(null);
  // Brief "Copied!" confirmation shown after the explicit Copy action (Issue #9).
  // Auto-clears after 1.5s — a toast-style signal that the clipboard write succeeded.
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [showDisappearing, setShowDisappearing] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'block' | 'burn' | 'remove-lock' | 'lock-setup' | 'hide-setup' | 'hide-confirm' | null>(null);
  const [convoStatus, setConvoStatus] = useState<string>('ACTIVE');
  const [hasChatLockPassword, setHasChatLockPassword] = useState(false);
  const [hasHideChatPassword, setHasHideChatPassword] = useState(false);
  const [isHidden, setIsHidden] = useState(false);
  const [lockSetupNewPassword, setLockSetupNewPassword] = useState('');
  const [lockSetupConfirmPassword, setLockSetupConfirmPassword] = useState('');
  const [lockSetupError, setLockSetupError] = useState<string | null>(null);
  const [removeLockPassword, setRemoveLockPassword] = useState('');
  const [removeLockError, setRemoveLockError] = useState<string | null>(null);
  const [hideConfirmPassword, setHideConfirmPassword] = useState('');
  const [hideConfirmError, setHideConfirmError] = useState<string | null>(null);
  const [hideSetupNewPassword, setHideSetupNewPassword] = useState('');
  const [hideSetupConfirmPassword, setHideSetupConfirmPassword] = useState('');
  const [hideSetupError, setHideSetupError] = useState<string | null>(null);
  // THE FIX (found during the final V1 feature-wiring audit): the
  // backend already exposes GET /api/conversations/disappearing-options
  // as the single source of truth for this list (domain/messageState.ts's
  // DISAPPEARING_OPTIONS), specifically so this picker never has to agree
  // with the backend by coincidence — but nothing ever called it. This
  // page kept its own separately-hardcoded copy instead, which happened
  // to still match value-for-value but had no mechanism keeping it that
  // way; a future change to either copy alone would have silently
  // desynced them. Falls back to the same values as before if the fetch
  // fails, so a slow/offline load doesn't block the picker from working
  // at all — this list changes rarely enough that a stale local fallback
  // is a perfectly fine degraded mode.
  const [disappearingOptions, setDisappearingOptions] = useState(DISAPPEARING_OPTIONS);
  const [initializing, setInitializing] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conversationBurned, setConversationBurned] = useState(false);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), 5000);
    return () => clearTimeout(timer);
  }, [actionError]);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  /** True when the scroll container is within 120px of the bottom — controls whether new incoming messages auto-scroll */
  const isAtBottomRef = useRef(true);
  const [keyboardOffset, setKeyboardOffset] = useState<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const isMobile =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      ('ontouchstart' in window && window.innerWidth < 1024);

    const updateViewport = () => {
      if (window.visualViewport && isMobile) {
        const offset = Math.max(0, window.innerHeight - window.visualViewport.height);
        setKeyboardOffset(offset > 100 ? offset : 0);
      } else {
        setKeyboardOffset(0);
      }
      if (isAtBottomRef.current && scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
      }
    };
    window.visualViewport.addEventListener('resize', updateViewport);
    updateViewport();
    return () => {
      window.visualViewport?.removeEventListener('resize', updateViewport);
    };
  }, []);

  // Container-only auto-scroll: never scrolls document or moves header
  const scrollToBottom = useCallback((smooth = true) => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom(true);
    }
  }, [messages, peerTyping, scrollToBottom]);

  const [otherUser, setOtherUser] = useState<{
    id: string;
    username: string;
    displayName?: string | null;
    isOnline?: boolean | null;
    lastSeenAt?: string | null;
  } | null>(null);
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  const [activeViewOnce, setActiveViewOnce] = useState<{ messageId: string; payload: AttachmentPayload; blobUrl: string } | null>(null);

  useEffect(() => {
    return () => {
      if (activeViewOnce?.blobUrl) {
        URL.revokeObjectURL(activeViewOnce.blobUrl);
      }
    };
  }, [activeViewOnce]);

  const [isSendingAttachment, setIsSendingAttachment] = useState(false);
  const [burnPassword, setBurnPassword] = useState('');
  const [burnLoading, setBurnLoading] = useState(false);
  const [burnError, setBurnError] = useState<string | null>(null);
  const [hasBurnPassword, setHasBurnPassword] = useState(false);
  const [burnSetupNewPassword, setBurnSetupNewPassword] = useState('');
  const [burnSetupConfirmPassword, setBurnSetupConfirmPassword] = useState('');
  const [burnSetupError, setBurnSetupError] = useState<string | null>(null);

  const [isLocked, setIsLocked] = useState(false);
  const [isSessionUnlocked, setIsSessionUnlocked] = useState(false);
  const [lockCheckDone, setLockCheckDone] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [isTemporary, setIsTemporary] = useState(false);
  const [isCreator, setIsCreator] = useState(false);
  const [isChatExpired, setIsChatExpired] = useState(false);
  const [countdownText, setCountdownText] = useState('');
  const [showExtendModal, setShowExtendModal] = useState(false);
  const [extendDuration, setExtendDuration] = useState<number>(15 * 60);
  const [extendDurationMode, setExtendDurationMode] = useState<'preset' | 'custom'>('preset');
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState<string | null>(null);

  // Scheduled Messages State & Listeners
  const [scheduledList, setScheduledList] = useState<ScheduledMessageItem[]>([]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showScheduledListModal, setShowScheduledListModal] = useState(false);
  const [customScheduleInput, setCustomScheduleInput] = useState('');
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const loadScheduled = useCallback(async () => {
    if (!userId) return;
    const items = await getScheduledMessages(userId, conversationId);
    setScheduledList(items);
  }, [userId, conversationId]);

  useEffect(() => {
    loadScheduled();
    const handler = () => loadScheduled();
    window.addEventListener('scheduled-messages-changed', handler);
    return () => window.removeEventListener('scheduled-messages-changed', handler);
  }, [loadScheduled]);

  useEffect(() => {
    if (!isTemporary || !expiresAt || isChatExpired) {
      return;
    }

    const updateTimer = () => {
      const now = Date.now();
      if (isTemporaryChatExpired(expiresAt, now)) {
        setIsChatExpired(true);
        setCountdownText('00:00 remaining');
        return;
      }
      setCountdownText(formatCountdown(expiresAt, now));
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [isTemporary, expiresAt, isChatExpired]);

  useEffect(() => {
    let cancelled = false;
    async function checkLock() {
      try {
        const locked = await isChatLocked(conversationId, userId);
        const hidden = await isChatHidden(conversationId, userId);
        const sessionUnlocked = isChatSessionUnlocked(conversationId);
        api<{ hasBurnPassword?: boolean; hasChatLockPassword?: boolean; hasHideChatPassword?: boolean }>('/api/settings')
          .then((s) => {
            if (!cancelled) {
              setHasBurnPassword(!!s.hasBurnPassword);
              setHasChatLockPassword(!!s.hasChatLockPassword);
              setHasHideChatPassword(!!s.hasHideChatPassword);
            }
          })
          .catch(() => {});
        if (!cancelled) {
          setIsLocked(locked);
          setIsHidden(hidden);
          setIsSessionUnlocked(sessionUnlocked);
          setLockCheckDone(true);
        }
      } catch {
        if (!cancelled) {
          setLockCheckDone(true);
        }
      }
    }
    checkLock();

    const onLockStateChange = (e: any) => {
      if (e.detail?.conversationId === conversationId && !cancelled) {
        setIsSessionUnlocked(!!e.detail.unlocked);
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('chat-lock-state-changed', onLockStateChange);
    }

    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('chat-lock-state-changed', onLockStateChange);
      }
    };
  }, [conversationId, userId]);

  async function handleUnlockConversation(e: React.FormEvent) {
    e.preventDefault();
    if (!unlockPassword.trim()) return;
    try {
      setUnlockLoading(true);
      setUnlockError(null);
      const feature = isLocked ? 'lock' : 'hide';
      let ok = await verifyFeaturePassword(feature, unlockPassword);
      if (!ok && isLocked && isHidden) {
        ok = await verifyFeaturePassword('hide', unlockPassword);
      }
      if (ok) {
        setChatSessionUnlocked(conversationId, true);
        setIsSessionUnlocked(true);
      } else {
        const label = isLocked ? 'Chat Lock' : 'Hide Chat';
        setUnlockError(`Incorrect password. Please enter your ${label} password.`);
      }
    } catch (err: any) {
      setUnlockError(err.message || 'Verification failed. Please try again.');
    } finally {
      setUnlockLoading(false);
    }
  }

  async function handleSetupChatLockAndUnlock(e: React.FormEvent) {
    e.preventDefault();
    setLockSetupError(null);
    if (lockSetupNewPassword.length < 4) {
      setLockSetupError('Password must be at least 4 characters.');
      return;
    }
    if (lockSetupNewPassword !== lockSetupConfirmPassword) {
      setLockSetupError('Passwords do not match.');
      return;
    }
    try {
      setUnlockLoading(true);
      const feature = isLocked ? 'lock' : 'hide';
      const label = isLocked ? 'Chat Lock' : 'Hide Chat';
      const res = await setFeaturePassword(feature, lockSetupNewPassword);
      if (!res.success) {
        setLockSetupError(res.error || `Failed to save ${label} password.`);
        return;
      }
      if (feature === 'lock') setHasChatLockPassword(true);
      else setHasHideChatPassword(true);
      setChatSessionUnlocked(conversationId, true);
      setIsSessionUnlocked(true);
    } catch (err: any) {
      setLockSetupError(err.message || 'Setup failed. Please try again.');
    } finally {
      setUnlockLoading(false);
    }
  }

  async function handleUnblock() {
    try {
      await api(`/api/conversations/${conversationId}/unblock`, { method: 'POST' });
      setConvoStatus('ACTIVE');
    } catch (err: any) {
      setActionError(err.message || 'Could not unblock this conversation.');
    }
  }

  async function handleConfirmRemoveLock() {
    setRemoveLockError(null);
    if (!removeLockPassword.trim()) {
      setRemoveLockError('Please enter your Chat Lock password.');
      return;
    }
    try {
      const ok = await verifyFeaturePassword('lock', removeLockPassword);
      if (!ok) {
        setRemoveLockError('Incorrect Chat Lock password.');
        return;
      }
      await unlockChatPermanently(conversationId, userId);
      setIsLocked(false);
      setConfirmAction(null);
      setRemoveLockPassword('');
    } catch (err: any) {
      setRemoveLockError(err.message || 'Failed to remove lock.');
    }
  }

  async function handleConfirmLockSetup() {
    setLockSetupError(null);
    if (lockSetupNewPassword.length < 4) {
      setLockSetupError('Password must be at least 4 characters.');
      return;
    }
    if (lockSetupNewPassword !== lockSetupConfirmPassword) {
      setLockSetupError('Passwords do not match.');
      return;
    }
    try {
      const res = await setFeaturePassword('lock', lockSetupNewPassword);
      if (!res.success) {
        setLockSetupError(res.error || 'Failed to set Chat Lock password.');
        return;
      }
      setHasChatLockPassword(true);
      await lockChat(conversationId, userId);
      setIsLocked(true);
      setConfirmAction(null);
      setLockSetupNewPassword('');
      setLockSetupConfirmPassword('');
      setShowProfileModal(false);
    } catch (err: any) {
      setLockSetupError(err.message || 'Failed to set Chat Lock password.');
    }
  }

  async function handleConfirmHideSetup() {
    setHideSetupError(null);
    if (hideSetupNewPassword.length < 4) {
      setHideSetupError('Password must be at least 4 characters.');
      return;
    }
    if (hideSetupNewPassword !== hideSetupConfirmPassword) {
      setHideSetupError('Passwords do not match.');
      return;
    }
    try {
      const res = await setFeaturePassword('hide', hideSetupNewPassword);
      if (!res.success) {
        setHideSetupError(res.error || 'Failed to set Hide Chat password.');
        return;
      }
      setHasHideChatPassword(true);
      await hideChat(conversationId, userId);
      setIsHidden(true);
      setConfirmAction(null);
      setHideSetupNewPassword('');
      setHideSetupConfirmPassword('');
      setShowProfileModal(false);
      router.push('/chat');
    } catch (err: any) {
      setHideSetupError(err.message || 'Failed to set Hide Chat password.');
    }
  }

  async function handleConfirmHide() {
    if (!hideConfirmPassword.trim()) {
      setHideConfirmError('Please enter your Hide Chat password.');
      return;
    }
    setBurnLoading(true);
    setHideConfirmError(null);
    try {
      const res = await api<{ valid: boolean }>('/api/settings/feature-passwords/verify', {
        method: 'POST',
        body: { feature: 'hide', password: hideConfirmPassword },
      });
      if (res.valid) {
        await hideChat(conversationId, userId);
        setIsHidden(true);
        setShowProfileModal(false);
        setConfirmAction(null);
        setHideConfirmPassword('');
        router.push('/chat');
      } else {
        setHideConfirmError('Incorrect Hide Chat password. Please try again.');
      }
    } catch (err: any) {
      setHideConfirmError(err.message || 'Verification failed. Please try again.');
    } finally {
      setBurnLoading(false);
    }
  }

  function scrollToMessage(msgId: string) {
    const el = document.getElementById(`msg-${msgId}`);
    if (el && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const targetTop = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      el.classList.add('ring-2', 'ring-info', 'transition-all');
      setTimeout(() => {
        el.classList.remove('ring-2', 'ring-info');
      }, 2000);
    }
  }

  const sessionRef = useRef<StoredSession | null>(null);
  const socketRef = useRef<Awaited<ReturnType<typeof connectSocket>> | null>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Bottom sentinel for auto-scroll */
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const isFlushingOutboxRef = useRef(false);
  const [isOnline, setIsOnline] = useState<boolean>(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  const flushOutbox = useCallback(async () => {
    if (!userId || !sessionRef.current || isFlushingOutboxRef.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    isFlushingOutboxRef.current = true;
    try {
      const items = await getOutboxItems(userId, conversationId);
      if (items.length === 0) return;

      for (const item of items) {
        if (typeof navigator !== 'undefined' && !navigator.onLine) break;

        let ciphertext = item.ciphertext;
        let iv = item.iv;
        let epoch = item.sessionEpoch ?? sessionRef.current.epoch;

        if (!ciphertext || !iv) {
          const aad = buildAad(conversationId, sessionRef.current.sendStep);
          const { envelope, nextChainKey } = await ratchetEncrypt(sessionRef.current.sendingChainKey, item.text, aad);
          sessionRef.current.sendingChainKey = nextChainKey;
          sessionRef.current.sendStep += 1;
          await saveSession(conversationId, sessionRef.current);
          ciphertext = envelope.ciphertext;
          iv = envelope.iv;
          epoch = sessionRef.current.epoch;
        }

        try {
          const result = await api<{ id: string; sentAt: string; delivered: boolean }>('/api/messages', {
            method: 'POST',
            body: {
              conversationId,
              clientMessageId: item.id,
              ciphertext,
              iv,
              messageType: 'TEXT',
              replyToMessageId: item.replyToMessageId,
              sessionEpoch: epoch,
            },
          });

          await removeOutboxItem(userId, item.id);
          const newStatus: 'sent' | 'delivered' = result.delivered ? 'delivered' : 'sent';
          await updateCachedMessage(conversationId, item.id, { status: newStatus });
          setMessages((prev) =>
            prev.map((m) => (m.id === item.id ? { ...m, status: newStatus, sentAt: result.sentAt } : m)),
          );
        } catch (err: any) {
          if (err instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine) || err?.status === 503 || err?.status === 502) {
            break;
          }
          await removeOutboxItem(userId, item.id);
          await updateCachedMessage(conversationId, item.id, { status: 'failed' });
          setMessages((prev) =>
            prev.map((m) => (m.id === item.id ? { ...m, status: 'failed' } : m)),
          );
        }
      }
    } finally {
      isFlushingOutboxRef.current = false;
    }
  }, [conversationId, userId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOnline = () => {
      setIsOnline(true);
      flushOutbox().catch(() => {});
    };
    const handleOffline = () => {
      setIsOnline(false);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [flushOutbox]);

  // Own settings, fetched once at bootstrap — gates whether this device
  // emits typing/read-receipt signals at all. The server enforces this
  // independently (the actual privacy boundary — never trust the client
  // for that part), but checking here too avoids emitting an event this
  // device's own owner has explicitly asked not to send.
  const settingsRef = useRef<{ readReceiptsEnabled: boolean; typingIndicatorEnabled: boolean; notificationContentVisible: boolean }>({
    readReceiptsEnabled: true,
    typingIndicatorEnabled: true,
    notificationContentVisible: false,
  });

  useEffect(() => {
    if (!lockCheckDone || ((isLocked || isHidden) && !isSessionUnlocked)) return;
    let cancelled = false;

    // Both syncGap (below) and the live 'message' handler mutate the same
    // sessionRef object — the receiving chain key, recvStep, and
    // lastSyncedSeq. Without serializing them, a message delivered live at
    // nearly the same moment a reconnect-triggered sync is processing the
    // same gap could interleave: two reads of the same pre-advance chain
    // key, two writes racing on the same counters. Routing every incoming
    // message through this queue makes each one's decrypt-advance-persist
    // sequence atomic relative to every other, regardless of which path
    // delivered it.
    let ratchetQueue: Promise<void> = Promise.resolve();
    function enqueueIncoming(m: { id: string; senderId: string; sequenceNumber: number; ciphertext: string; iv: string; sentAt: string; replyToMessageId?: string | null }): Promise<void> {
      const result = ratchetQueue.then(() => processIncoming(m));
      ratchetQueue = result.catch(() => {}); // one bad message must never wedge the queue for everything after it
      return result;
    }

    async function processIncoming(m: { id: string; senderId: string; sequenceNumber: number; ciphertext: string; iv: string; sentAt: string; replyToMessageId?: string | null }) {
      // ISSUE #5 FIX — Duplicate-delivery guard: check BEFORE advancing the
      // ratchet chain key. If this exact message ID is already in our local
      // cache it was already successfully decrypted (either by a previous
      // sync run or by the live socket event that arrived at the same time
      // as a reconnect-triggered sync). Processing it again would advance the
      // receivingChainKey a second time for this position, permanently
      // de-syncing it from the sender's sendingChainKey — every subsequent
      // message would then fail to decrypt with "[Could not decrypt this message]".
      //
      // Edits (message_edited events) re-use the same message ID but pass
      // fresh ciphertext — they must go through the ratchet because the
      // ciphertext changes. We detect edits by the socket-level event name;
      // here, a same-ID arrival in processIncoming is ALWAYS a pure duplicate
      // (content unchanged), never an edit (edits are also routed here via
      // enqueueIncoming but with the same ciphertext as a re-delivery, which
      // the already-cached path handles by updateCachedMessage with the
      // existing plaintext — no ratchet needed either way since the edit was
      // already applied on first delivery).
      const priorCache = await getCachedMessages(conversationId);
      const alreadyProcessed = priorCache.some((c) => c.id === m.id);
      if (alreadyProcessed) {
        // Update lastSyncedSeq watermark (monotonic) so this won't be
        // requested again on the next syncGap call, but do NOT touch the
        // chain key — it was already advanced when this message was first
        // processed.
        sessionRef.current!.lastSyncedSeq = Math.max(sessionRef.current!.lastSyncedSeq, m.sequenceNumber);
        await saveSession(conversationId, sessionRef.current!);
        return;
      }

      const aad = buildAad(conversationId, sessionRef.current!.recvStep);
      let text: string;
      try {
        const result = await ratchetDecrypt(sessionRef.current!.receivingChainKey, { ciphertext: m.ciphertext, iv: m.iv }, aad);
        sessionRef.current!.receivingChainKey = result.nextChainKey;
        sessionRef.current!.recvStep += 1;
        text = result.plaintext;
      } catch {
        // THE FIX: the chain still advances even though this message's
        // plaintext could not be recovered — see deriveNextChainKey's
        // own comment for why. Without this, a single corrupted or
        // tampered message would silently break decryption of every
        // message after it in this conversation, permanently, since
        // the next message would be decrypted with a chain key one
        // step behind what the sender actually used.
        sessionRef.current!.receivingChainKey = await deriveNextChainKey(sessionRef.current!.receivingChainKey);
        sessionRef.current!.recvStep += 1;
        text = '[Could not decrypt this message]';
      }
      // Monotonic, not a plain assignment: if this exact message was ALSO
      // delivered live while a sync was already fetching it (or vice
      // versa), the second arrival correctly fails to decrypt above (the
      // chain already advanced past it) — Math.max stops that duplicate
      // from dragging the high-water-mark backwards and re-opening a gap
      // that's already closed.
      sessionRef.current!.lastSyncedSeq = Math.max(sessionRef.current!.lastSyncedSeq, m.sequenceNumber);
      await saveSession(conversationId, sessionRef.current!);
      // An id already in the cache means this is an edit reaching us (live
      // push or sync catch-up) rather than a first delivery — update its
      // text in place instead of appending a duplicate. A fresh device
      // with an empty cache naturally treats an already-edited message as
      // new and just shows its current content, which is correct: it was
      // never shown the pre-edit version to begin with.
      const cachedList = await getCachedMessages(conversationId);
      const alreadyCached = cachedList.some((c) => c.id === m.id);
      if (alreadyCached) {
        await updateCachedMessage(conversationId, m.id, { text });
        if (!cancelled) setMessages((prev) => prev.map((p) => (p.id === m.id ? { ...p, text } : p)));
      } else {
        let replyToInfo: { messageId?: string; senderUsername?: string; text: string } | null = null;
        if (m.replyToMessageId) {
          const parent = cachedList.find((c) => c.id === m.replyToMessageId);
          if (parent) {
            replyToInfo = {
              messageId: parent.id,
              senderUsername: parent.mine ? 'You' : (otherUser?.username || 'Contact'),
              text: parseAttachmentPayload(parent.text)?.filename || parent.text.slice(0, 100),
            };
          } else {
            replyToInfo = {
              messageId: m.replyToMessageId,
              text: 'Original message',
            };
          }
        }
        const cachedMsg: CachedMessage = {
          id: m.id,
          conversationId,
          senderId: m.senderId,
          text,
          sentAt: m.sentAt,
          status: 'delivered',
          mine: false,
          replyToMessageId: m.replyToMessageId ?? null,
          replyTo: replyToInfo,
        };
        await appendCachedMessage(cachedMsg);
        if (!cancelled) setMessages((prev) => (prev.some((p) => p.id === m.id) ? prev : [...prev, cachedMsg]));
        notifyNewMessage(text);
      }
      if (settingsRef.current.readReceiptsEnabled) {
        api(`/api/messages/${m.id}/read`, { method: 'POST' }).catch(() => {});
      }
    }

    /**
     * The "Show message content in notifications" toggle in Settings
     * (notificationContentVisible) had a real, rendered UI control but
     * nothing anywhere in the app ever called the Notification API at
     * all — found while auditing every settings toggle for whether it's
     * actually wired to real behavior. Implemented here rather than
     * removed: the toggle is user-facing and the hook point (a message
     * just arrived) already exists.
     *
     * Deliberately scoped to messages in the conversation this page has
     * open, using the plaintext this page already decrypted for its own
     * UI — not a general "notify for any conversation in the
     * background" feature. That would need a conversation's ratchet
     * session loaded to decrypt with, which — correctly, per the
     * existing per-conversation session-loading design — only happens
     * while that conversation's own page is mounted. Building
     * cross-conversation global decryption just to support background
     * notification previews would be exactly the kind of architectural
     * expansion the "don't overengineer this pass" instruction is
     * about; this is the honest, contained version of the feature the
     * existing architecture actually supports.
     */
    function notifyNewMessage(text: string) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible' && document.hasFocus()) return; // already looking at it
      try {
        const body = isLocked || isHidden || !settingsRef.current.notificationContentVisible
          ? 'New encrypted message'
          : text;
        new Notification('Pookie Chat', {
          body,
          icon: '/icon-192.png',
          badge: '/badge.png',
        });
      } catch {
        // Notification construction can throw in some contexts (e.g. a
        // service-worker-only permission model) — never worth failing
        // message handling over.
      }
    }

    let syncInFlight = false;
    async function syncGap() {
      if (syncInFlight) return;
      syncInFlight = true;
      try {
        const gap = await api<{ id: string; senderId: string; sequenceNumber: number; deleted: boolean; ciphertext: string; iv: string; sentAt: string; replyToMessageId: string | null }[]>(
          `/api/messages/sync?conversationId=${conversationId}&after=${sessionRef.current!.lastSyncedSeq}`,
        );
        for (const m of gap) {
          if (m.deleted) {
            // A tombstone reaching us via sync rather than the live
            // 'message_deleted' push — the case where this device was
            // offline (or this conversation's page wasn't open) when the
            // deletion (explicit, or a disappearing timer expiring)
            // actually happened. Same removal as that live handler,
            // not a decrypt attempt — there's nothing to decrypt.
            setMessages((prev) => prev.filter((p) => p.id !== m.id));
            await removeCachedMessage(conversationId, m.id);
            sessionRef.current!.lastSyncedSeq = Math.max(sessionRef.current!.lastSyncedSeq, m.sequenceNumber);
            await saveSession(conversationId, sessionRef.current!);
            continue;
          }
          await enqueueIncoming(m);
        }
      } finally {
        syncInFlight = false;
      }
    }

    /**
     * Decides whether a locally cached session is still the one to
     * trust, and recovers if not. Two distinct situations collapse into
     * one check here, both driven by GET /api/conversations/:id
     * (ConversationsService.getStatus):
     *
     *  - No session at all (session === null): the historical case this
     *    already handled — a device (most commonly the pairing-code
     *    CREATOR's) that has never completed its side of a handshake
     *    yet. Falls through to the pending-handshake recovery below.
     *
     *  - A session exists but is stale (sessionStore's isSessionStale):
     *    the conversation was burned, or burned and re-paired, while
     *    this device wasn't watching — offline, or simply hadn't
     *    reconnected yet. Using it further would mean encrypting with a
     *    dead chain key (useless — the peer's new session can never
     *    decrypt it) or decrypting the peer's new messages with the
     *    wrong key (always fails). The cached session and its plaintext
     *    cache are cleared, then treated exactly like the "no session"
     *    case, so a fresh re-pair already waiting (rare, but possible if
     *    the other party burned-and-re-paired fast) is picked up
     *    immediately instead of forcing a manual reopen.
     *
     * A verification failure (network blip, server hiccup) fails open —
     * keeps trusting the cached session — rather than locking the user
     * out of a conversation that's probably still perfectly fine.
     * Actually writing stale-session ciphertext into a re-paired
     * conversation is prevented server-side regardless (messages.service.ts
     * rejects a mismatched sessionEpoch on send), so failing open here
     * costs at most a delayed self-heal on the next successful check,
     * never silent corruption of the new conversation.
     */
    async function ensureFreshSession(session: StoredSession | null): Promise<StoredSession | null> {
      try {
        const status = await api<{
          id: string;
          status: string;
          sessionEpoch: number;
          expiresAt?: string | null;
          isTemporary?: boolean;
          isCreator?: boolean;
          isExpired?: boolean;
          otherUser?: { id: string; username: string; displayName?: string | null; isOnline?: boolean | null; lastSeenAt?: string | null };
        }>(`/api/conversations/${conversationId}`);
        if (!cancelled) {
          if (status.status) setConvoStatus(status.status);
          if (status.otherUser) {
            setOtherUser(status.otherUser);
          }
          if (status.expiresAt) setExpiresAt(status.expiresAt);
          if (typeof status.isTemporary === 'boolean') setIsTemporary(status.isTemporary);
          if (typeof status.isCreator === 'boolean') setIsCreator(status.isCreator);
          if (status.isExpired || status.status === 'DELETED') {
            setIsChatExpired(true);
          } else if (status.expiresAt && isTemporaryChatExpired(status.expiresAt)) {
            setIsChatExpired(true);
          }
        }
        if (session && (isSessionStale(session, status) || status.isExpired || (status.expiresAt && isTemporaryChatExpired(status.expiresAt)))) {
          await deleteSession(conversationId);
          await clearCachedMessages(conversationId);
          if (!cancelled) setMessages([]);
          session = null;
        }
      } catch {
        return session;
      }
      if (session) return session;
      try {
        const identity = await getUserIdentity(userId);
        if (identity) {
          const pending = await api<{ handshakeMessage: HandshakeMessage; sessionEpoch: number }>(`/api/handshake?conversationId=${conversationId}`);
          const { session: completed } = await completeHandshake(identity, pending.handshakeMessage);
          session = await initSession(conversationId, completed, pending.sessionEpoch);
        }
      } catch {
        // No pending handshake either (404) — genuinely nothing to
        // recover right now; caller falls back to sending the user to
        // re-pair.
      }
      return session;
    }

    async function bootstrap() {
      // Best-effort — a failure here just leaves the safe defaults
      // (both enabled, notification content hidden) rather than
      // blocking the whole page.
      api<{ readReceiptsEnabled: boolean; typingIndicatorEnabled: boolean; notificationContentVisible: boolean }>('/api/settings')
        .then((s) => {
          settingsRef.current = {
            readReceiptsEnabled: s.readReceiptsEnabled,
            typingIndicatorEnabled: s.typingIndicatorEnabled,
            notificationContentVisible: s.notificationContentVisible,
          };
        })
        .catch(() => {});
      // Best-effort, never blocks anything: most browsers only honor
      // this when it's tied to a user gesture anyway, and a denial or
      // an unsupported context both just mean notifyNewMessage's own
      // permission check silently keeps notifications off.
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }

      const session = await ensureFreshSession(await loadSession(conversationId));
      if (!session) {
        // Real recovery is re-pairing (docs/03-ENCRYPTION-PROTOCOL.md §11),
        // not silently failing.
        router.push('/connect');
        return;
      }
      sessionRef.current = session;

      // Show cached history instantly — this is what survives a refresh,
      // since sync only ever returns the *other* party's messages (see
      // messages.service.ts's fix) and never re-delivers your own.
      const cached = await getCachedMessages(conversationId);
      if (!cancelled) {
        setMessages(cached);
        // Cached history (if any) is already showing at this point — the
        // rest of bootstrap (sync, socket connect) continues in the
        // background rather than holding up the loading state further.
        // Previously there was no loading state at all: an empty message
        // list during this entire async sequence was visually identical
        // to "you have no messages in this conversation," which is a
        // real, different situation the person has no way to tell apart
        // from "still loading" on a slow connection or first open.
        setInitializing(false);
      }

      await syncGap();
      flushOutbox().catch(() => {});

      const socket = await connectSocket();
      socketRef.current = socket;
      // Trigger outbox flush on socket connection
      socket.on('connect', () => {
        flushOutbox().catch(() => {});
      });
      // Re-run the same catch-up on every RECONNECT, not just the initial
      // mount. socket.io's own 'reconnect' (on the manager, not the socket)
      // fires only after a real disconnect+reconnect, never on first
      // connect — bootstrap already covers that case via the call above.
      // Without this, a same-tab network blip (not a full page reload)
      // would silently lose anything sent while the socket was down: the
      // client would just resume receiving live events forward from
      // whenever it reconnected, with nothing to backfill the gap.
      //
      // Also re-checks session freshness before that catch-up — a
      // reconnect is exactly when an offline-during-a-burn(+re-pair)
      // device gets its first chance to notice, and syncGap alone
      // wouldn't catch a re-paired-and-ACTIVE-again conversation (see
      // ensureFreshSession).
      socket.io.on('reconnect', async () => {
        const fresh = await ensureFreshSession(sessionRef.current);
        if (!fresh) {
          sessionRef.current = null;
          router.push('/connect');
          return;
        }
        sessionRef.current = fresh;
        syncGap();
        flushOutbox().catch(() => {});
      });
      socket.on('message', (evt: { id: string; senderId: string; sequenceNumber: number; ciphertext: string; iv: string; sentAt: string; replyToMessageId?: string | null }) => {
        enqueueIncoming(evt);
      });
      socket.on('typing', (evt: { conversationId: string; isTyping: boolean }) => {
        if (evt.conversationId === conversationId) setPeerTyping(evt.isTyping);
      });
      socket.on('read_receipt', (evt: { messageId: string }) => {
        setMessages((prev) => prev.map((m) => (m.id === evt.messageId ? { ...m, status: 'read' } : m)));
        updateCachedMessage(conversationId, evt.messageId, { status: 'read' });
      });
      socket.on('view_once_opened', (evt: { conversationId: string; messageId: string }) => {
        if (evt.conversationId !== conversationId) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id === evt.messageId) {
              try {
                const p = JSON.parse(m.text);
                if (p && p.viewOnce) {
                  const updated = JSON.stringify({ ...p, opened: true });
                  updateCachedMessage(conversationId, m.id, { text: updated, status: 'read' });
                  return { ...m, text: updated, status: 'read' };
                }
              } catch {}
              updateCachedMessage(conversationId, m.id, { status: 'read' });
              return { ...m, status: 'read' };
            }
            return m;
          })
        );
      });
      socket.on('message_deleted', (evt: { messageId: string }) => {
        setMessages((prev) => prev.filter((m) => m.id !== evt.messageId));
        removeCachedMessage(conversationId, evt.messageId);
      });
      socket.on('message_edited', (evt: { messageId: string; senderId: string; sequenceNumber: number; ciphertext: string; iv: string; sentAt: string }) => {
        enqueueIncoming({ id: evt.messageId, senderId: evt.senderId, sequenceNumber: evt.sequenceNumber, ciphertext: evt.ciphertext, iv: evt.iv, sentAt: evt.sentAt });
      });
      // The online-peer half of burn propagation (the offline half is
      // ensureFreshSession, above, run at bootstrap and reconnect). Fires
      // immediately when the other party burns this exact conversation
      // while this device is connected — no need to wait for a
      // reconnect or a manual reopen. Redirects to the conversation
      // list (not /connect): the other party burning doesn't imply
      // they've already created a new pairing code, so there is nothing
      // to re-pair with yet.
      socket.on('conversation_burned', (evt: { conversationId: string }) => {
        if (evt.conversationId !== conversationId) return;
        (async () => {
          await deleteSession(conversationId);
          await clearCachedMessages(conversationId);
          sessionRef.current = null;
          if (cancelled) return;
          setMessages([]);
          setConversationBurned(true);
        })();
      });

      socket.on('temporary_chat_expiry_updated', (evt: { conversationId: string; expiresAt: string }) => {
        if (evt.conversationId !== conversationId) return;
        if (!cancelled) {
          setExpiresAt(evt.expiresAt);
          setIsChatExpired(false);
        }
      });

      socket.on('temporary_chat_expired', (evt: { conversationId: string }) => {
        if (evt.conversationId !== conversationId) return;
        (async () => {
          await deleteSession(conversationId);
          await clearCachedMessages(conversationId);
          sessionRef.current = null;
          if (cancelled) return;
          setMessages([]);
          setIsChatExpired(true);
        })();
      });

      // Realtime presence: backend broadcasts these events to all of a user's
      // conversation partners when they connect/disconnect.
      // Use functional state updater so this listener never drops events due to stale closures!
      socket.on('user_online', (evt: { userId: string; timestamp?: number }) => {
        if (cancelled) return;
        setOtherUser((prev) => {
          if (!prev || prev.id !== evt.userId) return prev;
          return { ...prev, isOnline: true };
        });
      });
      socket.on('user_offline', (evt: { userId: string; lastSeenAt: string; timestamp?: number }) => {
        if (cancelled) return;
        setOtherUser((prev) => {
          if (!prev || prev.id !== evt.userId) return prev;
          return { ...prev, isOnline: false, lastSeenAt: evt.lastSeenAt };
        });
      });
    }

    const handleSyncStatus = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && !cancelled) {
        api<{
          status: string;
          expiresAt?: string | null;
          isExpired?: boolean;
          otherUser?: { id: string; username: string; displayName?: string | null; isOnline?: boolean | null; lastSeenAt?: string | null } | null;
        }>(`/api/conversations/${conversationId}`)
          .then((s) => {
            if (cancelled) return;
            if (s.status) setConvoStatus(s.status);
            if (s.otherUser) {
              setOtherUser((prev) => (prev ? { ...prev, isOnline: s.otherUser!.isOnline, lastSeenAt: s.otherUser!.lastSeenAt } : s.otherUser!));
            }
            if (s.isExpired || s.status === 'DELETED' || (s.expiresAt && isTemporaryChatExpired(s.expiresAt))) {
              setIsChatExpired(true);
            }
          })
          .catch(() => {});
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleSyncStatus);
      document.addEventListener('visibilitychange', handleSyncStatus);
    }

    // .catch here is a backstop, not the primary error handling (every
    // real failure path inside bootstrap already handles its own errors
    // — ensureFreshSession fails open, syncGap/socket errors are separate
    // concerns) — this exists only so a genuinely unexpected throw can't
    // leave `initializing` stuck true forever with no way for the page
    // to recover short of a manual reload.
    bootstrap().catch(() => {
      if (!cancelled) setInitializing(false);
    });
    return () => {
      cancelled = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleSyncStatus);
        document.removeEventListener('visibilitychange', handleSyncStatus);
      }
      const socket = socketRef.current;
      if (socket) {
        socket.off('message');
        socket.off('typing');
        socket.off('read_receipt');
        socket.off('view_once_opened');
        socket.off('message_deleted');
        socket.off('message_edited');
        socket.off('conversation_burned');
        socket.off('temporary_chat_expiry_updated');
        socket.off('temporary_chat_expired');
        socket.off('user_online');
        socket.off('user_offline');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, lockCheckDone, isLocked, isHidden, isSessionUnlocked]);

  async function sendDirectText(textToSend: string, explicitReplyTo?: CachedMessage | null) {
    const text = textToSend.trim();
    if (!text || !sessionRef.current || isChatExpired) return;
    const replySource = explicitReplyTo !== undefined ? explicitReplyTo : replyTo;
    const replyToMessageId = replySource?.id;
    const replyToPayload = replySource
      ? {
          messageId: replySource.id,
          senderUsername: replySource.mine ? 'You' : (otherUser?.username || 'Contact'),
          text: parseAttachmentPayload(replySource.text)?.filename || replySource.text.slice(0, 100),
        }
      : null;

    if (editingId) {
      const aad = buildAad(conversationId, sessionRef.current.sendStep);
      const { envelope, nextChainKey } = await ratchetEncrypt(sessionRef.current.sendingChainKey, text, aad);
      sessionRef.current.sendingChainKey = nextChainKey;
      sessionRef.current.sendStep += 1;
      await saveSession(conversationId, sessionRef.current);
      await api(`/api/messages/${editingId}`, { method: 'PATCH', body: { ciphertext: envelope.ciphertext, iv: envelope.iv } });
      setMessages((prev) => prev.map((m) => (m.id === editingId ? { ...m, text } : m)));
      await updateCachedMessage(conversationId, editingId, { text });
      setEditingId(null);
      textInputRef.current?.focus({ preventScroll: true });
      return;
    }

    const aad = buildAad(conversationId, sessionRef.current.sendStep);
    const { envelope, nextChainKey } = await ratchetEncrypt(sessionRef.current.sendingChainKey, text, aad);
    sessionRef.current.sendingChainKey = nextChainKey;
    sessionRef.current.sendStep += 1;
    await saveSession(conversationId, sessionRef.current);

    const clientMessageId = crypto.randomUUID();
    const sentAt = new Date().toISOString();

    // If currently offline, immediately queue to outbox and local cache with 'queued' status
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (userId) {
        const outboxItem: OutboxItem = {
          id: clientMessageId,
          conversationId,
          senderId: userId,
          text,
          ciphertext: envelope.ciphertext,
          iv: envelope.iv,
          sessionEpoch: sessionRef.current.epoch,
          sentAt,
          replyToMessageId: replyToMessageId || null,
          queuedAt: Date.now(),
          retryCount: 0,
        };
        await enqueueOutboxItem(userId, outboxItem);
      }
      const cachedMsg: CachedMessage = {
        id: clientMessageId,
        conversationId,
        senderId: userId!,
        text,
        sentAt,
        status: 'queued',
        mine: true,
        replyToMessageId: replyToMessageId || null,
        replyTo: replyToPayload,
      };
      await appendCachedMessage(cachedMsg);
      setMessages((prev) => [...prev, cachedMsg]);
      textInputRef.current?.focus({ preventScroll: true });
      return;
    }

    let result: { id: string; sentAt: string; delivered: boolean };
    try {
      result = await api<{ id: string; sentAt: string; delivered: boolean }>('/api/messages', {
        method: 'POST',
        body: {
          conversationId,
          clientMessageId,
          ciphertext: envelope.ciphertext,
          iv: envelope.iv,
          messageType: 'TEXT',
          replyToMessageId,
          sessionEpoch: sessionRef.current.epoch,
        },
      });
    } catch (err: any) {
      const isNetworkErr = (typeof navigator !== 'undefined' && !navigator.onLine) || err instanceof TypeError || err?.status === 503 || err?.status === 502;
      if (isNetworkErr && userId) {
        const outboxItem: OutboxItem = {
          id: clientMessageId,
          conversationId,
          senderId: userId,
          text,
          ciphertext: envelope.ciphertext,
          iv: envelope.iv,
          sessionEpoch: sessionRef.current.epoch,
          sentAt,
          replyToMessageId: replyToMessageId || null,
          queuedAt: Date.now(),
          retryCount: 0,
        };
        await enqueueOutboxItem(userId, outboxItem);
        const cachedMsg: CachedMessage = {
          id: clientMessageId,
          conversationId,
          senderId: userId,
          text,
          sentAt,
          status: 'queued',
          mine: true,
          replyToMessageId: replyToMessageId || null,
          replyTo: replyToPayload,
        };
        await appendCachedMessage(cachedMsg);
        setMessages((prev) => [...prev, cachedMsg]);
      } else {
        setMessages((prev) => [
          ...prev,
          { id: clientMessageId, conversationId, senderId: userId!, text, sentAt, status: 'failed', mine: true },
        ]);
      }
      textInputRef.current?.focus({ preventScroll: true });
      return;
    }
    const cachedMsg: CachedMessage = {
      id: result.id,
      conversationId,
      senderId: userId!,
      text,
      sentAt: result.sentAt,
      status: result.delivered ? 'delivered' : 'sent',
      mine: true,
      replyToMessageId: replyToMessageId || null,
      replyTo: replyToPayload,
    };
    await appendCachedMessage(cachedMsg);
    setMessages((prev) => [...prev, cachedMsg]);
    textInputRef.current?.focus({ preventScroll: true });
  }

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    const currentReply = replyTo;
    setReplyTo(null);
    await sendDirectText(text, currentReply);
  }

  // Automatic dispatcher for scheduled messages when their time arrives
  useEffect(() => {
    if (!userId || !sessionRef.current || isChatExpired) return;
    const sweep = async () => {
      const due = await getDueScheduledMessages(userId, conversationId);
      if (due.length === 0) return;
      for (const item of due) {
        await removeScheduledMessage(userId, item.id);
        if (item.text) {
          await sendDirectText(item.text, null);
        }
      }
    };
    const interval = setInterval(sweep, 2500);
    sweep();
    return () => clearInterval(interval);
  }, [userId, conversationId, isChatExpired]);

  async function handleScheduleMessage(targetTimeMs: number) {
    if (!userId || isChatExpired) return;
    const textToSchedule = draft.trim();
    if (!textToSchedule && !pendingImageFile) {
      setScheduleError('Please enter a message to schedule.');
      return;
    }

    const scheduledId = crypto.randomUUID();
    const item: ScheduledMessageItem = {
      id: scheduledId,
      conversationId,
      text: textToSchedule,
      scheduledFor: targetTimeMs,
      createdAt: Date.now(),
    };
    await saveScheduledMessage(userId, item);
    setDraft('');
    setShowScheduleModal(false);
    setScheduleError(null);
  }

  function onDraftChange(value: string) {
    setDraft(value);
    if (!settingsRef.current.typingIndicatorEnabled) return; // server enforces this too — this just avoids the wasted emit
    connectSocket().then((s) => {
      s.emit('typing', { conversationId, isTyping: value.length > 0 });
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(() => s.emit('typing', { conversationId, isTyping: false }), 2000);
    });
  }

  async function sendFile(file: File, caption?: string, viewOnce?: boolean) {
    if (!sessionRef.current) {
      const err = new Error('Encryption session not ready. Please wait a moment or reopen the chat.');
      setActionError(err.message);
      throw err;
    }
    if (isChatExpired) {
      const err = new Error('This temporary conversation has expired.');
      setActionError(err.message);
      throw err;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      const err = new Error('File is too large (25MB limit).');
      setActionError(err.message);
      throw err;
    }
    setIsSendingAttachment(true);
    try {
      const encrypted = await encryptFile(file);
      const { attachmentId } = await uploadAttachment(conversationId, encrypted.ciphertext, encrypted.mimeTypeHint, encrypted.originalSize);

      const payload: AttachmentPayload = {
        kind: 'attachment',
        attachmentId,
        dek: btoa(String.fromCharCode(...encrypted.dek)),
        mimeTypeHint: encrypted.mimeTypeHint,
        filename: file.name,
        caption: caption || undefined,
        viewOnce: viewOnce || undefined,
      };
      const content = JSON.stringify(payload);

      const aad = buildAad(conversationId, sessionRef.current.sendStep);
      const { envelope, nextChainKey } = await ratchetEncrypt(sessionRef.current.sendingChainKey, content, aad);
      sessionRef.current.sendingChainKey = nextChainKey;
      sessionRef.current.sendStep += 1;
      await saveSession(conversationId, sessionRef.current);

      const clientMessageId = crypto.randomUUID();
      const result = await api<{ id: string; sentAt: string; delivered: boolean }>('/api/messages', {
        method: 'POST',
        body: {
          conversationId,
          clientMessageId,
          ciphertext: envelope.ciphertext,
          iv: envelope.iv,
          messageType: encrypted.mimeTypeHint === 'image' ? 'IMAGE' : 'FILE',
          attachmentId,
          sessionEpoch: sessionRef.current.epoch,
        },
      });
      const cachedMsg: CachedMessage = {
        id: result.id,
        conversationId,
        senderId: userId!,
        text: content,
        sentAt: result.sentAt,
        status: result.delivered ? 'delivered' : 'sent',
        mine: true,
      };
      await appendCachedMessage(cachedMsg);
      setMessages((prev) => [...prev, cachedMsg]);
      setPendingImageFile(null);
    } catch (err: any) {
      const msg = err instanceof ApiError ? err.message : `Failed to send "${file.name}". Please try again.`;
      setActionError(msg);
      throw err;
    } finally {
      setIsSendingAttachment(false);
    }
  }

  async function openViewOnceMedia(messageId: string, payload: AttachmentPayload) {
    const targetMsg = messages.find((m) => m.id === messageId);
    if (targetMsg?.mine) return; // Senders cannot open or view their own view-once media
    try {
      const ciphertext = await downloadAttachment(payload.attachmentId);
      const dekBytes = Uint8Array.from(atob(payload.dek), (c) => c.charCodeAt(0));
      const mime = payload.filename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const blob = await decryptFile(ciphertext, dekBytes, mime);
      const url = URL.createObjectURL(blob);
      setActiveViewOnce({ messageId, payload, blobUrl: url });
    } catch {
      setActionError('This View Once photo could not be decrypted or was already deleted.');
    }
  }

  async function closeViewOnceModal() {
    if (!activeViewOnce) return;
    const { messageId, payload, blobUrl } = activeViewOnce;
    URL.revokeObjectURL(blobUrl);
    setActiveViewOnce(null);

    // Only recipient opening the View Once photo shreds it on the server and marks opened
    const targetMsg = messages.find((m) => m.id === messageId);
    if (targetMsg && !targetMsg.mine) {
      // Update message state & local cache to mark as opened
      const updatedPayload: AttachmentPayload = { ...payload, opened: true };
      const updatedJson = JSON.stringify(updatedPayload);
      await updateCachedMessage(conversationId, messageId, { text: updatedJson, status: 'read' });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, text: updatedJson, status: 'read' } : m)));

      // Shred ciphertext permanently on server storage
      api(`/api/attachments/${payload.attachmentId}`, { method: 'DELETE' }).catch(() => {});

      // Mark message as read on backend (records readAt in DB and triggers read_receipt)
      api(`/api/messages/${messageId}/read`, { method: 'POST' }).catch(() => {});

      // Notify sender in real time via socket that view-once photo was opened
      if (socketRef.current?.connected) {
        socketRef.current.emit('view_once_opened', { conversationId, messageId });
      }
    }
  }

  async function openAttachment(payload: AttachmentPayload) {
    try {
      const ciphertext = await downloadAttachment(payload.attachmentId);
      const dekBytes = Uint8Array.from(atob(payload.dek), (c) => c.charCodeAt(0));
      const ext = payload.filename.toLowerCase();
      const mime = ext.endsWith('.png')
        ? 'image/png'
        : ext.endsWith('.webp')
        ? 'image/webp'
        : ext.endsWith('.gif')
        ? 'image/gif'
        : ext.endsWith('.pdf')
        ? 'application/pdf'
        : ext.endsWith('.jpg') || ext.endsWith('.jpeg')
        ? 'image/jpeg'
        : 'application/octet-stream';
      const blob = await decryptFile(ciphertext, dekBytes, mime);
      const url = URL.createObjectURL(blob);
      const safeFilename = payload.filename.replace(/[/\\?%*:|"<>]/g, '_');
      const a = document.createElement('a');
      a.href = url;
      a.download = safeFilename;
      if (mime.startsWith('image/') || mime === 'application/pdf') {
        const newTab = window.open(url, '_blank', 'noopener,noreferrer');
        if (!newTab) {
          a.click();
        }
      } else {
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setActionError('Could not open this attachment. It may have expired or been deleted.');
    }
  }

  async function copyMessage(m: CachedMessage) {
    try {
      await navigator.clipboard.writeText(m.text);
    } catch {
      // Clipboard may be unavailable (e.g. HTTP context or user-denied permission).
      // The explicit Copy action is best-effort — fail silently rather than showing
      // an error that implies the full copy-restriction system failed.
    }
    setOpenActionsFor(null);
    // Brief "Copied!" confirmation — auto-clears after 1.5s (Issue #9 requirement:
    // explicit Copy action must provide success feedback).
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 1500);
  }

  async function deleteMessage(m: CachedMessage) {
    const isUndecryptable = m.text === '[Could not decrypt this message]' || m.text.startsWith('[Could not decrypt');
    if (!isUndecryptable && m.mine) {
      try {
        await api(`/api/messages/${m.id}`, { method: 'DELETE' });
      } catch {
        setActionError('Could not delete this message. Please try again.');
        return;
      }
    }
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
    await removeCachedMessage(conversationId, m.id);
    setOpenActionsFor(null);
  }

  async function clearUndecryptableMessages() {
    const undecryptables = messages.filter((m) => m.text === '[Could not decrypt this message]' || m.text.startsWith('[Could not decrypt'));
    if (undecryptables.length === 0) return;
    for (const m of undecryptables) {
      await removeCachedMessage(conversationId, m.id);
    }
    setMessages((prev) => prev.filter((m) => m.text !== '[Could not decrypt this message]' && !m.text.startsWith('[Could not decrypt')));
    setShowProfileModal(false);
  }

  function startEdit(m: CachedMessage) {
    setEditingId(m.id);
    setDraft(m.text);
    setReplyTo(null);
    setOpenActionsFor(null);
  }

  function startReply(m: CachedMessage) {
    setReplyTo(m);
    setEditingId(null);
    setOpenActionsFor(null);
  }

  async function handleBlock() {
    try {
      await api(`/api/conversations/${conversationId}/block`, { method: 'POST' });
    } catch {
      setActionError('Could not block this conversation. Please try again.');
      return;
    }
    router.push('/chat');
  }

  async function handleBurn() {
    setBurnLoading(true);
    setBurnError(null);
    setBurnSetupError(null);

    let passwordToSend = burnPassword.trim();

    if (!hasBurnPassword) {
      if (burnSetupNewPassword.length < 4) {
        setBurnLoading(false);
        setBurnSetupError('Burn Password must be at least 4 characters.');
        return;
      }
      if (burnSetupNewPassword !== burnSetupConfirmPassword) {
        setBurnLoading(false);
        setBurnSetupError('Passwords do not match.');
        return;
      }
      const setupRes = await setFeaturePassword('burn', burnSetupNewPassword);
      if (!setupRes.success) {
        setBurnLoading(false);
        setBurnSetupError(setupRes.error || 'Could not configure Burn Password.');
        return;
      }
      setHasBurnPassword(true);
      passwordToSend = burnSetupNewPassword;
    }

    try {
      await api(`/api/conversations/${conversationId}/burn`, {
        method: 'POST',
        body: { password: passwordToSend || undefined },
      });
    } catch (err: any) {
      setBurnLoading(false);
      const msg = err?.message || 'Could not burn this conversation. Invalid password or network error.';
      setBurnError(msg);
      return;
    }
    setBurnLoading(false);
    setConfirmAction(null);
    setShowProfileModal(false);
    await deleteSession(conversationId);
    await clearCachedMessages(conversationId);
    const hiddenId = await idbGet<string>('hiddenChat:conversationId');
    if (hiddenId === conversationId) await idbSet('hiddenChat:conversationId', null);
    router.push('/chat');
  }

  async function setDisappearing(seconds: number | null) {
    try {
      await api(`/api/conversations/${conversationId}/disappearing`, { method: 'POST', body: { timerSeconds: seconds, trigger: 'READ' } });
    } catch {
      setActionError('Could not update the disappearing-messages timer. Please try again.');
      return;
    }
    setShowDisappearing(false);
  }

  async function handleExtendSubmit() {
    setExtendError(null);
    setExtending(true);
    try {
      const res = await api<{ ok: boolean; expiresAt: string }>(
        `/api/conversations/${conversationId}/temporary/extend`,
        {
          method: 'POST',
          body: { durationSeconds: extendDuration },
        },
      );
      setExpiresAt(res.expiresAt);
      setIsChatExpired(false);
      setShowExtendModal(false);
    } catch (err: any) {
      setExtendError(err instanceof ApiError ? err.message : 'Failed to extend chat lifetime');
    } finally {
      setExtending(false);
    }
  }

  return (
    <div
      style={keyboardOffset > 0 ? { bottom: `${keyboardOffset}px` } : undefined}
      className="fixed inset-0 flex w-full flex-col overflow-hidden bg-surface"
    >
      <AppHeader activeTab="Chat" className="hidden md:flex" />

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Left: Persistent Conversations Sidebar on desktop (hidden on mobile) */}
        <aside className="hidden md:flex w-80 lg:w-96 shrink-0 h-full border-r border-glass-border/40 flex-col bg-surface">
          <ConversationSidebar activeConversationId={conversationId} />
        </aside>

        {/* Right: Active Chat Area */}
        <main className="flex flex-1 flex-col h-full overflow-hidden min-w-0 bg-surface">
          {lockCheckDone && (isLocked || isHidden) && !isSessionUnlocked ? (
            <div className="flex flex-1 items-center justify-center p-4">
              <NeoSurface
                variant="raised"
                className="w-full max-w-sm rounded-2xl p-6 flex flex-col items-center text-center gap-4 bg-surface border border-glass-border/60 shadow-2xl"
              >
                <div className="w-14 h-14 rounded-2xl bg-accent-warning/15 text-accent-warning flex items-center justify-center">
                  {isHidden && !isLocked ? (
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  )}
                </div>
                {!(isHidden && !isLocked ? hasHideChatPassword : hasChatLockPassword) ? (
                  <>
                    <div>
                      <h2 className="text-base font-bold text-ink">
                        {isHidden && !isLocked ? 'Set Up Hide Chat Password' : 'Set Up Chat Lock Password'}
                      </h2>
                      <p className="mt-1 text-xs text-ink-dim leading-relaxed">
                        This conversation is protected, but you have not configured a {isHidden && !isLocked ? 'Hide Chat' : 'Chat Lock'} Password yet. Create one now to open and protect your chats.
                      </p>
                    </div>
                    <form onSubmit={handleSetupChatLockAndUnlock} className="w-full flex flex-col gap-3">
                      <NeoInput
                        type="password"
                        placeholder={`New ${isHidden && !isLocked ? 'Hide Chat' : 'Chat Lock'} Password (min 4 chars)`}
                        value={lockSetupNewPassword}
                        onChange={(e) => {
                          setLockSetupNewPassword(e.target.value);
                          if (lockSetupError) setLockSetupError(null);
                        }}
                        autoFocus
                        required
                      />
                      <NeoInput
                        type="password"
                        placeholder={`Confirm ${isHidden && !isLocked ? 'Hide Chat' : 'Chat Lock'} Password`}
                        value={lockSetupConfirmPassword}
                        onChange={(e) => {
                          setLockSetupConfirmPassword(e.target.value);
                          if (lockSetupError) setLockSetupError(null);
                        }}
                        required
                      />
                      {lockSetupError && (
                        <div className="text-[11.5px] text-danger font-medium text-left leading-tight">{lockSetupError}</div>
                      )}
                      <Button
                        type="submit"
                        variant="raised"
                        accent="info"
                        className="w-full text-xs font-bold py-2.5"
                        disabled={unlockLoading || !lockSetupNewPassword.trim()}
                      >
                        {unlockLoading ? 'Saving…' : 'Set Password & Unlock'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full text-xs"
                        onClick={() => router.push('/chat')}
                      >
                        Back to Chats
                      </Button>
                    </form>
                  </>
                ) : (
                  <>
                    <div>
                      <h2 className="text-base font-bold text-ink">{isHidden && !isLocked ? 'Hidden Conversation' : 'Locked Conversation'}</h2>
                      <p className="mt-1 text-xs text-ink-dim leading-relaxed">
                        This conversation is protected. Enter your {isHidden && !isLocked ? 'Hide Chat' : 'Chat Lock'} password to view messages.
                      </p>
                    </div>
                    <form onSubmit={handleUnlockConversation} className="w-full flex flex-col gap-3">
                      <NeoInput
                        type="password"
                        placeholder={`Enter ${isHidden && !isLocked ? 'Hide Chat' : 'Chat Lock'} password`}
                        value={unlockPassword}
                        onChange={(e) => {
                          setUnlockPassword(e.target.value);
                          if (unlockError) setUnlockError(null);
                        }}
                        autoFocus
                        required
                      />
                      {unlockError && (
                        <div className="text-[11.5px] text-danger font-medium text-left leading-tight">{unlockError}</div>
                      )}
                      <Button
                        type="submit"
                        variant="raised"
                        accent="info"
                        className="w-full text-xs font-bold py-2.5"
                        disabled={unlockLoading || !unlockPassword.trim()}
                      >
                        {unlockLoading ? 'Verifying…' : 'Unlock Conversation'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full text-xs"
                        onClick={() => router.push('/chat')}
                      >
                        Back to Chats
                      </Button>
                    </form>
                  </>
                )}
              </NeoSurface>
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between border-b border-glass-border/40 px-3 sm:px-6 py-2.5 bg-surface shrink-0">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Link
                    href="/chat"
                    className="md:hidden p-1.5 -ml-1 text-ink-dim hover:text-ink active:scale-95 transition-all rounded-lg hover:bg-surface-2 shrink-0 mr-0.5"
                    aria-label="Back to conversations"
                    title="Back to conversations"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </Link>

                  <div
                    className="flex items-center gap-2.5 min-w-0 cursor-pointer p-1 -ml-1 rounded-xl hover:bg-surface-2/60 transition-colors"
              onClick={() => {
                setShowProfileModal(true);
                api<{ label: string; seconds: number | null }[]>('/api/conversations/disappearing-options')
                  .then(setDisappearingOptions)
                  .catch(() => {});
              }}
              role="button"
              tabIndex={0}
              title="View contact profile and settings"
            >
              <div className="w-8 h-8 rounded-full bg-info/10 text-info font-bold text-xs flex items-center justify-center shrink-0 border border-info/20">
                {otherUser?.username ? otherUser.username.slice(0, 2).toUpperCase() : 'U'}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-bold text-ink truncate leading-tight">
                  {otherUser?.username ? `@${otherUser.username}` : 'Encrypted Conversation'}
                </span>
                <span className="text-[11px] text-ink-dim truncate leading-tight mt-0.5 flex items-center gap-1.5">
                  {otherUser?.isOnline === true ? (
                    <>
                      <span className="w-2 h-2 rounded-full bg-positive inline-block animate-pulse shrink-0" />
                      <span className="text-positive font-medium">Online</span>
                    </>
                  ) : otherUser?.lastSeenAt ? (
                    <span>Last seen {formatLastSeen(otherUser.lastSeenAt)}</span>
                  ) : (
                    <span>{otherUser?.displayName ? otherUser.displayName : 'Tap for profile & security'}</span>
                  )}
                </span>
              </div>
            </div>
          </div>

            <div className="flex items-center gap-2 shrink-0">
              {isTemporary && (
                <div className="flex items-center gap-1.5">
                  <div
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${
                      isChatExpired
                        ? 'bg-danger/10 text-danger border-danger/30'
                        : 'bg-info/10 text-info border-info/30'
                    }`}
                    title={isChatExpired ? 'This temporary chat has expired' : `Chat lifetime: ${countdownText}`}
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span>{isChatExpired ? 'Chat expired' : (countdownText || 'Calculating…')}</span>
                  </div>
                  {isCreator && !isChatExpired && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setExtendError(null);
                        setShowExtendModal(true);
                      }}
                      className="!h-7 !px-2.5 text-xs font-semibold text-info hover:bg-info/10 flex items-center gap-1"
                      title="Extend chat lifetime"
                    >
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      <span>Extend time</span>
                    </Button>
                  )}
                </div>
              )}

              <Button
                variant="ghost"
                size="icon"
                className="!h-9 !w-9 text-ink-dim hover:text-ink"
                title="Conversation info & settings"
                onClick={() => {
                  setShowProfileModal(true);
                  api<{ label: string; seconds: number | null }[]>('/api/conversations/disappearing-options')
                    .then(setDisappearingOptions)
                    .catch(() => {});
                }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </Button>
            </div>
          </header>

          {actionError && (
            <div
              role="alert"
              className="m-3 flex items-center justify-between rounded-lg bg-danger/10 px-3.5 py-2 text-xs text-danger"
            >
              <span>{actionError}</span>
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="ml-2 opacity-75 hover:opacity-100"
                aria-label="Dismiss error"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
          )}

          {/* "Copied!" success toast — auto-clears after 1.5s (Issue #9: explicit Copy action must
              provide success feedback distinct from a generic clipboard browser affordance). */}
          {copyFeedback && (
            <div
              role="status"
              aria-live="polite"
              className="m-3 flex items-center gap-2 rounded-lg bg-positive/10 px-3.5 py-2 text-xs text-positive font-medium"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
              Copied to clipboard
            </div>
          )}


          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto px-3 sm:px-6 py-3"
            onScroll={() => {
              const el = scrollContainerRef.current;
              if (!el) return;
              // Consider "at bottom" when within 120px of the bottom edge
              isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
          >
            <div className="mx-auto w-full max-w-5xl flex flex-col gap-2.5">
              {initializing && messages.length === 0 && (
                <div className="flex flex-1 items-center justify-center text-xs text-ink-dim py-12">
                  Loading conversation…
                </div>
              )}
              {!initializing && messages.length === 0 && (
                <div className="flex flex-1 items-center justify-center text-xs text-ink-dim py-12">
                  No messages yet. Say hello!
                </div>
              )}
              {messages.map((m) => {
                const attachment = parseAttachmentPayload(m.text);
                return (
                  // msg-no-select prevents native text-selection copy (Issue #9).
                  // The explicit Copy button in the action menu below is still available.
                  <div key={m.id} id={`msg-${m.id}`} className={`msg-no-select flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}>
                    <div onClick={() => setOpenActionsFor(openActionsFor === m.id ? null : m.id)} className="cursor-pointer max-w-full">
                      {attachment ? (
                        attachment.mimeTypeHint === 'image' ? (
                          <DecryptedImageAttachment
                            payload={attachment}
                            isMine={m.mine}
                            timestamp={new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            status={m.mine ? m.status : undefined}
                            replyTo={m.replyTo}
                            onReplyClick={scrollToMessage}
                            onClick={() => (attachment.viewOnce ? openViewOnceMedia(m.id, attachment) : openAttachment(attachment))}
                          />
                        ) : (
                          <NeoSurface
                            variant="raised"
                            className={`flex max-w-[78%] items-center gap-2 px-4 py-3 ${m.mine ? 'bg-surface-2' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              openAttachment(attachment);
                            }}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5 flex-shrink-0 text-ink-dim" aria-hidden="true">
                              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                            </svg>
                            <span className="truncate text-sm">{attachment.filename}</span>
                          </NeoSurface>
                        )
                      ) : (
                        <MessageBubble
                          id={m.id}
                          direction={m.mine ? 'sent' : 'received'}
                          text={m.text}
                          timestamp={new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          status={m.mine ? m.status : undefined}
                          replyTo={m.replyTo ?? undefined}
                          onReplyClick={scrollToMessage}
                          onDismiss={() => deleteMessage(m)}
                        />
                      )}
                    </div>
                    {openActionsFor === m.id && (
                      <div className="neo-raised mt-1 flex gap-1 rounded-lg p-1">
                        {m.text === '[Could not decrypt this message]' || m.text.startsWith('[Could not decrypt') ? (
                          <button onClick={() => deleteMessage(m)} className="rounded-md px-2 py-1 text-[11px] font-semibold text-danger">
                            Dismiss / Remove
                          </button>
                        ) : (
                          <>
                            <button onClick={() => startReply(m)} className="rounded-md px-2 py-1 text-[11px] font-semibold text-ink-dim">
                              Reply
                            </button>
                            {!attachment && (
                              // allow-select lets the user select/read the text in Copy confirmation
                              <button onClick={() => copyMessage(m)} className="allow-select rounded-md px-2 py-1 text-[11px] font-semibold text-ink-dim">
                                Copy
                              </button>
                            )}
                            {m.mine && (
                              <>
                                {!attachment && (
                                  <button onClick={() => startEdit(m)} className="rounded-md px-2 py-1 text-[11px] font-semibold text-ink-dim">
                                    Edit
                                  </button>
                                )}
                                <button onClick={() => deleteMessage(m)} className="rounded-md px-2 py-1 text-[11px] font-semibold text-danger">
                                  Delete
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {/* Scroll sentinel — messagesEndRef targets this for auto-scroll */}
              <div ref={messagesEndRef} className="h-px" aria-hidden="true" />
            </div>
          </div>

          {/* Typing indicator — OUTSIDE the scroll container (Issue #2 fix).
              Previously rendered inside the scrollable div, making it invisible
              unless the user scrolled to the very bottom. Now pinned between
              the message list and the composer so it's always visible.           */}
          {peerTyping && (
            <div className="px-3 sm:px-6 py-1.5 shrink-0">
              <div className="mx-auto w-full max-w-5xl">
                <TypingIndicator />
              </div>
            </div>
          )}


          {(replyTo || editingId) && (
            <div className="px-3 sm:px-6 shrink-0">
              <div className="mx-auto w-full max-w-5xl">
                <div className="neo-pressed mb-1 flex items-center justify-between rounded-lg px-3 py-2 text-xs text-ink-dim">
                  <span>{editingId ? 'Editing message' : `Replying to: ${replyTo?.text.slice(0, 40)}`}</span>
                  <button
                    onClick={() => {
                      setReplyTo(null);
                      setEditingId(null);
                      setDraft('');
                    }}
                    className="p-1 text-ink-dim hover:text-ink rounded"
                    aria-label="Cancel editing or reply"
                  >
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Composer anchored at bottom */}
          <div
            className={`border-t border-glass-border/40 p-2.5 sm:p-4 bg-surface shrink-0 ${
              keyboardOffset === 0 ? 'pb-[max(0.75rem,env(safe-area-inset-bottom))]' : ''
            }`}
          >
            {!isOnline && (
              <div className="mx-auto w-full max-w-5xl mb-2.5 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-500 text-xs animate-in fade-in duration-200">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                </svg>
                <span className="font-medium">You are offline. Messages will be queued and sent automatically when reconnected.</span>
              </div>
            )}
            {isChatExpired ? (
              <div className="mx-auto w-full max-w-5xl flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-danger/10 border border-danger/20 text-danger">
                <div className="flex items-center gap-2.5">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <div className="flex flex-col text-left">
                    <span className="text-xs font-bold">Chat Expired</span>
                    <span className="text-[11px] text-ink-dim leading-tight">This temporary conversation has expired. All messages have been securely deleted.</span>
                  </div>
                </div>
                <Button
                  variant="raised"
                  className="!h-8 !px-3 text-xs shrink-0"
                  onClick={() => router.push('/chat')}
                >
                  Back to Chats
                </Button>
              </div>
            ) : (
              <>
                {scheduledList.length > 0 && (
                  <div
                    onClick={() => setShowScheduledListModal(true)}
                    className="mx-auto w-full max-w-5xl mb-2 flex items-center justify-between px-3.5 py-1.5 rounded-xl bg-info/10 border border-info/30 text-info text-xs font-semibold cursor-pointer hover:bg-info/20 active:scale-[0.99] transition-all select-none"
                  >
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span>{scheduledList.length} scheduled message{scheduledList.length > 1 ? 's' : ''}</span>
                    </div>
                    <span className="text-[11px] underline">Manage</span>
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    send();
                    textInputRef.current?.focus({ preventScroll: true });
                  }}
                  className="mx-auto w-full max-w-5xl flex items-center gap-2"
                >
                  <Button
                    type="button"
                    variant="raised"
                    size="icon"
                    aria-label="Attach a file"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        if (file.type.startsWith('image/')) {
                          setPendingImageFile(file);
                        } else {
                          sendFile(file);
                        }
                      }
                      e.target.value = '';
                    }}
                  />
                  <NeoSurface variant="pressed" className="flex-1 px-1">
                    <input
                      ref={textInputRef}
                      value={draft}
                      onChange={(e) => onDraftChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      placeholder="Message"
                      aria-label="Message text"
                      className="w-full bg-transparent px-3 py-2.5 sm:py-3 text-sm text-ink placeholder:text-ink-dim focus:outline-none"
                    />
                  </NeoSurface>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Schedule message"
                    title="Schedule message"
                    onClick={() => {
                      setShowScheduleModal(true);
                      setScheduleError(null);
                    }}
                    className="!h-9 !w-9 text-ink-dim hover:text-ink shrink-0"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </Button>
                  <Button
                    type="submit"
                    variant="glass"
                    size="icon"
                    accent="info"
                    aria-label="Send message"
                    onTouchStart={(e) => {
                      // Prevent virtual keyboard blur on mobile while sending directly
                      e.preventDefault();
                      send();
                      textInputRef.current?.focus({ preventScroll: true });
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => {
                      e.preventDefault();
                      send();
                      textInputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-[17px] w-[17px]" aria-hidden="true">
                      <path d="M3 11.5L21 3l-8.5 18-2.5-7.5L3 11.5z" />
                    </svg>
                  </Button>
                </form>
              </>
            )}
          </div>

          {/* Image Preview & Caption Modal */}
          {pendingImageFile && (
            <ImagePreviewModal
              file={pendingImageFile}
              onSend={async (file, caption, viewOnce) => {
                await sendFile(file, caption, viewOnce);
              }}
              onCancel={() => setPendingImageFile(null)}
              isSending={isSendingAttachment}
            />
          )}

          {/* View Once Photo Single-View Modal */}
          {activeViewOnce && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/95 backdrop-blur-xl animate-in fade-in duration-200 select-none"
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="relative max-w-2xl w-full flex flex-col items-center gap-3 select-none">
                <div className="flex items-center justify-between w-full text-white/90 px-2">
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <span className="w-5 h-5 rounded-full border border-info bg-info text-white flex items-center justify-center text-[10px] font-black">
                      1
                    </span>
                    <span>View Once Photo · Disappears after closing</span>
                  </div>
                  <Button
                    variant="glass"
                    className="!text-xs !py-1 !px-3 font-semibold text-white bg-white/10 hover:bg-white/20 border-white/20"
                    onClick={closeViewOnceModal}
                  >
                    Close & Shred
                  </Button>
                </div>

                <div
                  className="relative max-h-[75vh] w-full flex items-center justify-center rounded-2xl overflow-hidden bg-black/40 border border-white/10 p-2 select-none"
                  onContextMenu={(e) => e.preventDefault()}
                  onDragStart={(e) => e.preventDefault()}
                >
                  <img
                    src={activeViewOnce.blobUrl}
                    alt={activeViewOnce.payload.filename || 'View Once photo'}
                    draggable={false}
                    onContextMenu={(e) => e.preventDefault()}
                    onDragStart={(e) => e.preventDefault()}
                    style={{
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                      WebkitTouchCallout: 'none',
                      pointerEvents: 'none',
                    }}
                    className="max-h-[70vh] max-w-full object-contain rounded-xl select-none pointer-events-none"
                  />
                </div>

                {activeViewOnce.payload.caption && (
                  <div className="text-xs text-white/80 bg-white/10 px-4 py-2 rounded-xl backdrop-blur-md max-w-lg text-center select-none">
                    {activeViewOnce.payload.caption}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* User Profile Panel Modal */}
          {showProfileModal && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
            >
              <NeoSurface variant="raised" className="w-full max-w-md p-6 flex flex-col gap-5 bg-surface rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-ink">Contact Details</h2>
                  <button
                    type="button"
                    onClick={() => setShowProfileModal(false)}
                    className="p-1 rounded-lg text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>

                {/* Profile Identity */}
                <div className="flex flex-col items-center text-center gap-2 py-2">
                  <div className="w-16 h-16 rounded-full bg-info/10 text-info font-bold text-xl flex items-center justify-center border border-info/20 shadow-sm">
                    {otherUser?.username ? otherUser.username.slice(0, 2).toUpperCase() : 'U'}
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-ink">
                      {otherUser?.displayName || (otherUser?.username ? `@${otherUser.username}` : 'Encrypted Contact')}
                    </h3>
                    {otherUser?.username && otherUser?.displayName && (
                      <p className="text-xs text-ink-dim font-mono mt-0.5">@{otherUser.username}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 px-3 py-1 bg-positive/10 text-positive rounded-full text-xs font-semibold border border-positive/20 mt-1">
                    <span className="w-2 h-2 rounded-full bg-positive" />
                    <span>Signal Double Ratchet E2EE</span>
                  </div>
                </div>

                {/* Section 1: Disappearing Messages */}
                <div className="space-y-2 border-t border-glass-border/40 pt-4">
                  <div>
                    <h4 className="text-xs font-bold text-ink">Disappearing Messages</h4>
                    <p className="text-[11px] text-ink-dim">Messages disappear from both devices after reading</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {disappearingOptions.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => setDisappearing(opt.seconds)}
                        className="neo-raised rounded-lg px-2.5 py-1 text-xs font-semibold text-ink-dim hover:text-ink hover:bg-surface-2 transition-all"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Section 2: Privacy & Security Actions */}
                <div className="space-y-2 border-t border-glass-border/40 pt-4">
                  <h4 className="text-xs font-bold text-ink mb-1">Privacy & Security</h4>
                  <div className="flex flex-col gap-2">
                    {/* Chat Lock */}
                    <Button
                      variant="ghost"
                      className="w-full flex items-center justify-start gap-2.5 px-3 !py-2.5 text-xs font-semibold rounded-xl hover:bg-surface-2 transition-colors text-ink"
                      onClick={async () => {
                        if (isLocked) {
                          setRemoveLockPassword('');
                          setRemoveLockError(null);
                          setConfirmAction('remove-lock');
                        } else if (!hasChatLockPassword) {
                          setLockSetupNewPassword('');
                          setLockSetupConfirmPassword('');
                          setLockSetupError(null);
                          setConfirmAction('lock-setup');
                        } else {
                          await lockChat(conversationId, userId);
                          setIsLocked(true);
                          setShowProfileModal(false);
                        }
                      }}
                    >
                      <div className="w-6 h-6 rounded-lg bg-accent-warning/15 text-accent-warning flex items-center justify-center shrink-0">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </div>
                      <span>{isLocked ? 'Remove Chat Lock' : 'Lock Chat'}</span>
                    </Button>

                    {/* Hide Chat */}
                    <Button
                      variant="ghost"
                      className="w-full flex items-center justify-start gap-2.5 px-3 !py-2.5 text-xs font-semibold rounded-xl hover:bg-surface-2 transition-colors text-ink"
                      onClick={async () => {
                        if (isHidden) {
                          await unhideChat(conversationId, userId);
                          setIsHidden(false);
                        } else if (!hasHideChatPassword) {
                          setHideSetupNewPassword('');
                          setHideSetupConfirmPassword('');
                          setHideSetupError(null);
                          setConfirmAction('hide-setup');
                        } else {
                          setHideConfirmPassword('');
                          setHideConfirmError(null);
                          setConfirmAction('hide-confirm');
                        }
                      }}
                    >
                      <div className="w-6 h-6 rounded-lg bg-info/15 text-info flex items-center justify-center shrink-0">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      </div>
                      <span>{isHidden ? 'Unhide Chat' : 'Hide Chat'}</span>
                    </Button>

                    {/* Clear Undecryptable Messages */}
                    {messages.some((m) => m.text === '[Could not decrypt this message]' || m.text.startsWith('[Could not decrypt')) && (
                      <Button
                        variant="ghost"
                        className="w-full flex items-center justify-start gap-2.5 px-3 !py-2.5 text-xs font-semibold rounded-xl hover:bg-amber-500/10 transition-colors text-amber-500"
                        onClick={clearUndecryptableMessages}
                      >
                        <div className="w-6 h-6 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </div>
                        <span>
                          Clear Undecryptable Messages ({messages.filter((m) => m.text === '[Could not decrypt this message]' || m.text.startsWith('[Could not decrypt')).length})
                        </span>
                      </Button>
                    )}

                    {/* Block / Unblock Contact */}
                    {convoStatus.startsWith('BLOCKED') ? (
                      <Button
                        variant="ghost"
                        className="w-full flex items-center justify-start gap-2.5 px-3 !py-2.5 text-xs font-semibold rounded-xl hover:bg-surface-2 transition-colors text-positive"
                        onClick={handleUnblock}
                      >
                        <div className="w-6 h-6 rounded-lg bg-positive/10 text-positive flex items-center justify-center shrink-0">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <path d="M9 12l2 2 4-4" />
                          </svg>
                        </div>
                        <span>Unblock Contact</span>
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        accent="danger"
                        className="w-full flex items-center justify-start gap-2.5 px-3 !py-2.5 text-xs font-semibold rounded-xl hover:bg-danger/10 transition-colors"
                        onClick={() => setConfirmAction('block')}
                      >
                        <div className="w-6 h-6 rounded-lg bg-danger/10 text-danger flex items-center justify-center shrink-0">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                          </svg>
                        </div>
                        <span>Block Contact</span>
                      </Button>
                    )}

                    {/* Burn Conversation */}
                    <Button
                      variant="ghost"
                      accent="danger"
                      className="w-full flex items-center justify-start gap-2.5 px-3 !py-2.5 text-xs font-semibold rounded-xl hover:bg-danger/10 transition-colors"
                      onClick={() => {
                        setBurnPassword('');
                        setBurnError(null);
                        setConfirmAction('burn');
                      }}
                    >
                      <div className="w-6 h-6 rounded-lg bg-danger/15 text-danger flex items-center justify-center shrink-0">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 2c.5 3 2.5 5 4 7 1.5 2 2 4.5 1 7-1 2.5-3 4-5 4s-4-1.5-5-4c-1-2.5-.5-5 1-7 1.5-2 3.5-4 4-7z" />
                        </svg>
                      </div>
                      <span>Burn Conversation</span>
                    </Button>
                  </div>
                </div>
              </NeoSurface>
            </div>
          )}

          {/* Themed Confirmation Modal for Block / Burn / Lock / Hide */}
          {confirmAction && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
            >
              <NeoSurface variant="raised" className="w-full max-w-sm p-6 flex flex-col gap-4 bg-surface rounded-2xl shadow-2xl">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    confirmAction === 'burn' || confirmAction === 'block' ? 'bg-danger/15 text-danger' :
                    confirmAction === 'remove-lock' || confirmAction === 'lock-setup' ? 'bg-accent-warning/15 text-accent-warning' :
                    'bg-info/15 text-info'
                  }`}>
                    {confirmAction === 'burn' && (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    )}
                    {confirmAction === 'block' && (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                      </svg>
                    )}
                    {(confirmAction === 'remove-lock' || confirmAction === 'lock-setup') && (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    )}
                    {(confirmAction === 'hide-setup' || confirmAction === 'hide-confirm') && (
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    )}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-ink">
                      {confirmAction === 'block' ? 'Block Contact?' :
                       confirmAction === 'burn' ? 'Burn Conversation?' :
                       confirmAction === 'remove-lock' ? 'Remove Chat Lock' :
                       confirmAction === 'lock-setup' ? 'Set Up Chat Lock' :
                       confirmAction === 'hide-confirm' ? 'Hide Conversation' :
                       'Set Up Hide Chat'}
                    </h3>
                    <p className="text-xs text-ink-dim mt-0.5">
                      {confirmAction === 'block' ? 'You will no longer receive messages in this conversation.' :
                       confirmAction === 'burn' ? 'Permanently destroy all cryptographic session keys and message history on both devices. This cannot be undone.' :
                       confirmAction === 'remove-lock' ? 'Enter your Chat Lock Password to remove protection from this conversation.' :
                       confirmAction === 'lock-setup' ? 'Create a Chat Lock Password to protect this conversation. Minimum 4 characters.' :
                       confirmAction === 'hide-confirm' ? 'Enter your Hide Chat password to confirm hiding this conversation.' :
                       'Create a Hide Chat Password to conceal this conversation from your chats list. Minimum 4 characters.'}
                    </p>
                  </div>
                </div>

                {confirmAction === 'burn' && !hasBurnPassword && (
                  <div className="flex flex-col gap-2 py-1">
                    <div className="text-[11.5px] text-accent-warning font-semibold bg-accent-warning/10 p-2.5 rounded-xl border border-accent-warning/25">
                      Burn Password is not configured yet. Create a Burn Password to authorize destroying this conversation.
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold text-ink-dim">Create Burn Password</label>
                      <NeoInput
                        type="password"
                        placeholder="New Burn Password (min 4 chars)"
                        value={burnSetupNewPassword}
                        onChange={(e) => {
                          setBurnSetupNewPassword(e.target.value);
                          setBurnSetupError(null);
                        }}
                        className="text-xs"
                        autoFocus
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold text-ink-dim">Confirm Burn Password</label>
                      <NeoInput
                        type="password"
                        placeholder="Confirm Burn Password"
                        value={burnSetupConfirmPassword}
                        onChange={(e) => {
                          setBurnSetupConfirmPassword(e.target.value);
                          setBurnSetupError(null);
                        }}
                        className="text-xs"
                      />
                    </div>
                    {burnSetupError && (
                      <span className="text-[11px] text-danger font-medium">{burnSetupError}</span>
                    )}
                  </div>
                )}

                {confirmAction === 'burn' && hasBurnPassword && (
                  <div className="flex flex-col gap-1.5 py-1">
                    <label className="text-[11px] font-semibold text-ink-dim">
                      Enter Burn Password to authorize:
                    </label>
                    <NeoInput
                      type="password"
                      placeholder="Burn Password"
                      value={burnPassword}
                      onChange={(e) => {
                        setBurnPassword(e.target.value);
                        setBurnError(null);
                      }}
                      className="text-xs"
                      autoFocus
                    />
                    {burnError && (
                      <span className="text-[11px] text-danger font-medium mt-0.5">{burnError}</span>
                    )}
                  </div>
                )}

                {confirmAction === 'remove-lock' && (
                  <div className="flex flex-col gap-1.5 py-1">
                    <label className="text-[11px] font-semibold text-ink-dim">
                      Enter Chat Lock Password:
                    </label>
                    <NeoInput
                      type="password"
                      placeholder="Chat Lock Password"
                      value={removeLockPassword}
                      onChange={(e) => {
                        setRemoveLockPassword(e.target.value);
                        setRemoveLockError(null);
                      }}
                      className="text-xs"
                      autoFocus
                    />
                    {removeLockError && (
                      <span className="text-[11px] text-danger font-medium mt-0.5">{removeLockError}</span>
                    )}
                  </div>
                )}

                {confirmAction === 'lock-setup' && (
                  <div className="flex flex-col gap-2 py-1">
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold text-ink-dim">New Chat Lock Password</label>
                      <NeoInput
                        type="password"
                        placeholder="Password (min 4 chars)"
                        value={lockSetupNewPassword}
                        onChange={(e) => {
                          setLockSetupNewPassword(e.target.value);
                          setLockSetupError(null);
                        }}
                        className="text-xs"
                        autoFocus
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold text-ink-dim">Confirm Chat Lock Password</label>
                      <NeoInput
                        type="password"
                        placeholder="Confirm Password"
                        value={lockSetupConfirmPassword}
                        onChange={(e) => {
                          setLockSetupConfirmPassword(e.target.value);
                          setLockSetupError(null);
                        }}
                        className="text-xs"
                      />
                    </div>
                    {lockSetupError && (
                      <span className="text-[11px] text-danger font-medium">{lockSetupError}</span>
                    )}
                  </div>
                )}

                {confirmAction === 'hide-setup' && (
                  <div className="flex flex-col gap-2 py-1">
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold text-ink-dim">New Hide Chat Password</label>
                      <NeoInput
                        type="password"
                        placeholder="Password (min 4 chars)"
                        value={hideSetupNewPassword}
                        onChange={(e) => {
                          setHideSetupNewPassword(e.target.value);
                          setHideSetupError(null);
                        }}
                        className="text-xs"
                        autoFocus
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold text-ink-dim">Confirm Hide Chat Password</label>
                      <NeoInput
                        type="password"
                        placeholder="Confirm Password"
                        value={hideSetupConfirmPassword}
                        onChange={(e) => {
                          setHideSetupConfirmPassword(e.target.value);
                          setHideSetupError(null);
                        }}
                        className="text-xs"
                      />
                    </div>
                    {hideSetupError && (
                      <span className="text-[11px] text-danger font-medium">{hideSetupError}</span>
                    )}
                  </div>
                )}

                {confirmAction === 'hide-confirm' && (
                  <div className="flex flex-col gap-2 py-1">
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-semibold text-ink-dim">Hide Chat Password</label>
                      <NeoInput
                        type="password"
                        placeholder="Enter Hide Chat password"
                        value={hideConfirmPassword}
                        onChange={(e) => {
                          setHideConfirmPassword(e.target.value);
                          setHideConfirmError(null);
                        }}
                        className="text-xs"
                        autoFocus
                      />
                    </div>
                    {hideConfirmError && (
                      <span className="text-[11px] text-danger font-medium">{hideConfirmError}</span>
                    )}
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <Button
                    variant="ghost"
                    className="flex-1 text-xs"
                    disabled={burnLoading}
                    onClick={() => {
                      setConfirmAction(null);
                      setBurnPassword('');
                      setBurnError(null);
                      setRemoveLockPassword('');
                      setRemoveLockError(null);
                      setLockSetupNewPassword('');
                      setLockSetupConfirmPassword('');
                      setLockSetupError(null);
                      setHideSetupNewPassword('');
                      setHideSetupConfirmPassword('');
                      setHideSetupError(null);
                      setHideConfirmPassword('');
                      setHideConfirmError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="raised"
                    accent={confirmAction === 'burn' || confirmAction === 'block' ? 'danger' : 'info'}
                    className="flex-1 text-xs font-bold"
                    disabled={burnLoading}
                    onClick={async () => {
                      const action = confirmAction;
                      if (action === 'block') {
                        setConfirmAction(null);
                        setShowProfileModal(false);
                        await handleBlock();
                      } else if (action === 'burn') {
                        await handleBurn();
                      } else if (action === 'remove-lock') {
                        await handleConfirmRemoveLock();
                      } else if (action === 'lock-setup') {
                        await handleConfirmLockSetup();
                      } else if (action === 'hide-setup') {
                        await handleConfirmHideSetup();
                      } else if (action === 'hide-confirm') {
                        await handleConfirmHide();
                      }
                    }}
                  >
                    {burnLoading
                      ? 'Processing…'
                      : confirmAction === 'block'
                      ? 'Confirm Block'
                      : confirmAction === 'burn'
                      ? 'Confirm Burn'
                      : confirmAction === 'remove-lock'
                      ? 'Remove Lock'
                      : confirmAction === 'lock-setup'
                      ? 'Set & Lock'
                      : confirmAction === 'hide-confirm'
                      ? 'Hide Chat'
                      : 'Set & Hide'}
                  </Button>
                </div>
              </NeoSurface>
            </div>
          )}

          {/* Extend Temporary Chat Lifetime Modal */}
          {showExtendModal && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
            >
              <NeoSurface variant="raised" className="w-full max-w-md p-6 flex flex-col gap-4 bg-surface rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-info/10 text-info">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </div>
                    <h2 className="text-base font-bold text-ink">Extend Chat Lifetime</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowExtendModal(false)}
                    className="p-1 rounded-lg text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>

                <p className="text-xs text-ink-dim leading-relaxed">
                  Add more time to this temporary conversation. The remaining time will be increased for both participants. Maximum total lifetime is 90 days.
                </p>

                {/* Mode Selector */}
                <div className="flex items-center justify-between border-b border-glass-border/40 pb-2">
                  <span className="text-xs font-bold text-ink">Select Added Duration</span>
                  <div className="flex items-center gap-1 rounded-lg bg-surface-2/60 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setExtendDurationMode('preset')}
                      className={`px-2.5 py-1 rounded-md transition-all ${
                        extendDurationMode === 'preset' ? 'neo-raised text-info bg-surface font-bold shadow-sm' : 'text-ink-dim hover:text-ink'
                      }`}
                    >
                      Presets
                    </button>
                    <button
                      type="button"
                      onClick={() => setExtendDurationMode('custom')}
                      className={`px-2.5 py-1 rounded-md transition-all ${
                        extendDurationMode === 'custom' ? 'neo-raised text-info bg-surface font-bold shadow-sm' : 'text-ink-dim hover:text-ink'
                      }`}
                    >
                      Custom Wheel
                    </button>
                  </div>
                </div>

                {extendDurationMode === 'preset' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {TEMPORARY_DURATIONS.map((d) => (
                      <button
                        key={d.label}
                        type="button"
                        onClick={() => setExtendDuration(d.seconds)}
                        className={`p-3 rounded-xl text-left transition-all flex flex-col gap-1 ${
                          extendDuration === d.seconds
                            ? 'neo-pressed border border-info/50 bg-info/10'
                            : 'neo-raised hover:opacity-90'
                        }`}
                      >
                        <div className={`text-xs font-bold ${extendDuration === d.seconds ? 'text-info' : 'text-ink'}`}>
                          +{d.label}
                        </div>
                        <div className="text-[10px] text-ink-dim leading-tight">{d.description}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <CustomDurationPicker
                    valueSeconds={extendDuration}
                    onChange={(secs) => setExtendDuration(secs)}
                  />
                )}

                {extendError && (
                  <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger">
                    {extendError}
                  </div>
                )}

                <div className="flex gap-2.5 pt-2">
                  <Button
                    variant="raised"
                    className="flex-1 font-semibold text-xs"
                    onClick={() => setShowExtendModal(false)}
                    disabled={extending}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="raised"
                    accent="info"
                    className="flex-1 font-bold text-xs"
                    onClick={handleExtendSubmit}
                    disabled={extending || extendDuration <= 0}
                  >
                    {extending ? 'Extending…' : 'Add Time'}
                  </Button>
                </div>
              </NeoSurface>
            </div>
          )}

          {/* Schedule Message Modal */}
          {showScheduleModal && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
            >
              <NeoSurface variant="raised" className="w-full max-w-sm p-6 flex flex-col gap-4 bg-surface rounded-2xl shadow-2xl">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-info">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <h2 className="text-base font-bold text-ink">Schedule Message</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowScheduleModal(false)}
                    className="p-1 rounded-lg text-ink-dim hover:text-ink"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>

                <p className="text-xs text-ink-dim">
                  Pick a future time when this message should be automatically sent.
                </p>

                {draft.trim() && (
                  <div className="p-2.5 rounded-xl bg-surface-2/60 border border-glass-border/40 text-xs text-ink line-clamp-2 italic">
                    &ldquo;{draft.trim()}&rdquo;
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <span className="text-[11px] font-bold text-ink-dim uppercase tracking-wider">Quick Presets</span>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="raised"
                      className="!text-xs !py-2 font-medium"
                      onClick={() => handleScheduleMessage(Date.now() + 15 * 60 * 1000)}
                    >
                      In 15 minutes
                    </Button>
                    <Button
                      variant="raised"
                      className="!text-xs !py-2 font-medium"
                      onClick={() => handleScheduleMessage(Date.now() + 30 * 60 * 1000)}
                    >
                      In 30 minutes
                    </Button>
                    <Button
                      variant="raised"
                      className="!text-xs !py-2 font-medium"
                      onClick={() => handleScheduleMessage(Date.now() + 60 * 60 * 1000)}
                    >
                      In 1 hour
                    </Button>
                    <Button
                      variant="raised"
                      className="!text-xs !py-2 font-medium"
                      onClick={() => handleScheduleMessage(Date.now() + 3 * 3600 * 1000)}
                    >
                      In 3 hours
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2 pt-1 border-t border-glass-border/40">
                  <span className="text-[11px] font-bold text-ink-dim uppercase tracking-wider">Custom Date & Time</span>
                  <input
                    type="datetime-local"
                    value={customScheduleInput}
                    min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                    onChange={(e) => setCustomScheduleInput(e.target.value)}
                    className="w-full neo-pressed px-3 py-2 rounded-xl text-xs bg-transparent text-ink focus:outline-none"
                  />
                  {scheduleError && (
                    <span className="text-[11px] text-danger font-medium">{scheduleError}</span>
                  )}
                  <Button
                    variant="raised"
                    accent="info"
                    className="!text-xs !py-2 font-bold w-full mt-1"
                    disabled={!customScheduleInput}
                    onClick={() => {
                      const ts = new Date(customScheduleInput).getTime();
                      if (isNaN(ts) || ts <= Date.now()) {
                        setScheduleError('Please choose a valid future time.');
                        return;
                      }
                      handleScheduleMessage(ts);
                    }}
                  >
                    Schedule Custom Time
                  </Button>
                </div>
              </NeoSurface>
            </div>
          )}

          {/* Manage Scheduled Messages Modal */}
          {showScheduledListModal && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
            >
              <NeoSurface variant="raised" className="w-full max-w-md p-6 flex flex-col gap-4 bg-surface rounded-2xl shadow-2xl max-h-[85vh] overflow-y-auto">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-info">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <h2 className="text-base font-bold text-ink">Scheduled Messages ({scheduledList.length})</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowScheduledListModal(false)}
                    className="p-1 rounded-lg text-ink-dim hover:text-ink"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </button>
                </div>

                {scheduledList.length === 0 ? (
                  <p className="text-xs text-ink-dim py-6 text-center">No scheduled messages for this conversation.</p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {scheduledList.map((item) => (
                      <div
                        key={item.id}
                        className="p-3 rounded-xl bg-surface-2/60 border border-glass-border/40 flex flex-col gap-2"
                      >
                        <div className="text-xs text-ink break-words line-clamp-3">
                          {item.text || '[Scheduled Attachment]'}
                        </div>
                        <div className="flex items-center justify-between pt-1 border-t border-glass-border/20 text-[11px] text-ink-dim">
                          <span className="flex items-center gap-1 font-medium">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
                            {new Date(item.scheduledFor).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                          </span>
                          <button
                            type="button"
                            onClick={async () => {
                              if (userId) {
                                await removeScheduledMessage(userId, item.id);
                                loadScheduled();
                              }
                            }}
                            className="text-danger hover:underline font-semibold"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <Button
                  variant="raised"
                  className="w-full text-xs font-semibold mt-1"
                  onClick={() => setShowScheduledListModal(false)}
                >
                  Close
                </Button>
              </NeoSurface>
            </div>
          )}

          {conversationBurned && (
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="burned-title"
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            >
              <NeoSurface variant="raised" className="w-full max-w-sm p-6 flex flex-col items-center gap-4 bg-surface text-center shadow-2xl">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                </div>
                <div>
                  <h3 id="burned-title" className="text-base font-bold text-ink">Conversation Ended</h3>
                  <p className="mt-1 text-xs text-ink-dim">This conversation was deleted by the other person.</p>
                </div>
                <Button
                  variant="raised"
                  className="w-full mt-2"
                  onClick={() => router.push('/chat')}
                >
                  Back to Conversations
                </Button>
              </NeoSurface>
            </div>
          )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
