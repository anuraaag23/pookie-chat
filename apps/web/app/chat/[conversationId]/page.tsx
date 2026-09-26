'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { AppHeader } from '@/components/navigation/AppHeader';
import { ConversationSidebar } from '@/components/chat/ConversationSidebar';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { idbGet, idbSet } from '@/lib/storage/localDb';
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
import { encryptFile, decryptFile } from '@/lib/crypto/fileCrypto';
import { uploadAttachment, downloadAttachment } from '@/lib/api/client';
import { ImagePreviewModal } from '@/components/chat/ImagePreviewModal';
import { NeoInput } from '@/components/ui/NeoInput';
import {
  isChatLocked,
  isChatSessionUnlocked,
  setChatSessionUnlocked,
  verifyAccountPassword,
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
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  replyTo?: { text: string; senderUsername?: string; messageId?: string } | null;
  onReplyClick?: (msgId: string) => void;
  onClick: () => void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const ciphertext = await downloadAttachment(payload.attachmentId);
        const dekBytes = Uint8Array.from(atob(payload.dek), (c) => c.charCodeAt(0));
        const blob = await decryptFile(ciphertext, dekBytes);
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
  }, [payload.attachmentId, payload.dek]);

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
          {status === 'read' && (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-[13px] w-[13px] text-info" aria-label="Read">
              <path d="M1 12l5 5L17 6" />
              <path d="M7 12l5 5L23 6" />
            </svg>
          )}
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
  const [showDisappearing, setShowDisappearing] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'block' | 'burn' | null>(null);
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

  const [otherUser, setOtherUser] = useState<{
    id: string;
    username: string;
    displayName?: string | null;
    isOnline?: boolean | null;
    lastSeenAt?: string | null;
  } | null>(null);
  const [pendingImageFile, setPendingImageFile] = useState<File | null>(null);
  const [isSendingAttachment, setIsSendingAttachment] = useState(false);
  const [burnPassword, setBurnPassword] = useState('');
  const [burnLoading, setBurnLoading] = useState(false);
  const [burnError, setBurnError] = useState<string | null>(null);

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
        const sessionUnlocked = isChatSessionUnlocked(conversationId);
        if (!cancelled) {
          setIsLocked(locked);
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
    return () => {
      cancelled = true;
    };
  }, [conversationId, userId]);

  async function handleUnlockConversation(e: React.FormEvent) {
    e.preventDefault();
    if (!unlockPassword.trim()) return;
    try {
      setUnlockLoading(true);
      setUnlockError(null);
      const ok = await verifyAccountPassword(unlockPassword);
      if (ok) {
        setChatSessionUnlocked(conversationId, true);
        setIsSessionUnlocked(true);
      } else {
        setUnlockError('Incorrect password. If you signed in with Google, please set an account password in Settings.');
      }
    } catch (err: any) {
      setUnlockError(err.message || 'Verification failed. Please try again.');
    } finally {
      setUnlockLoading(false);
    }
  }

  function scrollToMessage(msgId: string) {
    const el = document.getElementById(`msg-${msgId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    if (!lockCheckDone || (isLocked && !isSessionUnlocked)) return;
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
        const body = isLocked || !settingsRef.current.notificationContentVisible
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
        if (status.otherUser && !cancelled) {
          setOtherUser(status.otherUser);
        }
        if (!cancelled) {
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
        const identity = await idbGet<DeviceIdentity>('crypto:identity');
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

      const socket = await connectSocket();
      socketRef.current = socket;
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
      const socket = socketRef.current;
      if (socket) {
        socket.off('message');
        socket.off('typing');
        socket.off('read_receipt');
        socket.off('message_deleted');
        socket.off('message_edited');
        socket.off('conversation_burned');
        socket.off('temporary_chat_expiry_updated');
        socket.off('temporary_chat_expired');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, lockCheckDone, isLocked, isSessionUnlocked]);

  async function send() {
    const text = draft.trim();
    if (!text || !sessionRef.current || isChatExpired) return;
    setDraft('');
    const replyToMessageId = replyTo?.id;
    const replyToPayload = replyTo
      ? {
          messageId: replyTo.id,
          senderUsername: replyTo.mine ? 'You' : (otherUser?.username || 'Contact'),
          text: parseAttachmentPayload(replyTo.text)?.filename || replyTo.text.slice(0, 100),
        }
      : null;
    setReplyTo(null);

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
      return;
    }

    const aad = buildAad(conversationId, sessionRef.current.sendStep);
    const { envelope, nextChainKey } = await ratchetEncrypt(sessionRef.current.sendingChainKey, text, aad);
    sessionRef.current.sendingChainKey = nextChainKey;
    sessionRef.current.sendStep += 1;
    await saveSession(conversationId, sessionRef.current);

    const clientMessageId = crypto.randomUUID();
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
    } catch {
      setMessages((prev) => [
        ...prev,
        { id: clientMessageId, conversationId, senderId: userId!, text, sentAt: new Date().toISOString(), status: 'failed', mine: true },
      ]);
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

  async function sendFile(file: File, caption?: string) {
    if (!sessionRef.current || isChatExpired) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setActionError('File is too large (25MB limit).');
      return;
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
    } catch {
      setActionError(`Failed to send "${file.name}". Please try again.`);
    } finally {
      setIsSendingAttachment(false);
    }
  }

  async function openAttachment(payload: AttachmentPayload) {
    try {
      const ciphertext = await downloadAttachment(payload.attachmentId);
      const dekBytes = Uint8Array.from(atob(payload.dek), (c) => c.charCodeAt(0));
      const blob = await decryptFile(ciphertext, dekBytes);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch {
      setActionError('Could not open this attachment. It may have expired or been deleted.');
    }
  }

  async function copyMessage(m: CachedMessage) {
    await navigator.clipboard.writeText(m.text);
    setOpenActionsFor(null);
  }

  async function deleteMessage(m: CachedMessage) {
    try {
      await api(`/api/messages/${m.id}`, { method: 'DELETE' });
    } catch {
      setActionError('Could not delete this message. Please try again.');
      return;
    }
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
    await removeCachedMessage(conversationId, m.id);
    setOpenActionsFor(null);
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
    try {
      await api(`/api/conversations/${conversationId}/burn`, {
        method: 'POST',
        body: { password: burnPassword.trim() || undefined },
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
    <div className="flex h-dvh max-h-dvh w-full flex-col overflow-hidden bg-surface">
      <AppHeader activeTab="Chat" showBack backHref="/chat" />

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Left: Persistent Conversations Sidebar on desktop (hidden on mobile) */}
        <aside className="hidden md:flex w-80 lg:w-96 shrink-0 h-full border-r border-glass-border/40 flex-col bg-surface">
          <ConversationSidebar activeConversationId={conversationId} />
        </aside>

        {/* Right: Active Chat Area */}
        <main className="flex flex-1 flex-col h-full overflow-hidden min-w-0 bg-surface">
          {lockCheckDone && isLocked && !isSessionUnlocked ? (
            <div className="flex flex-1 items-center justify-center p-4">
              <NeoSurface
                variant="raised"
                className="w-full max-w-sm rounded-2xl p-6 flex flex-col items-center text-center gap-4 bg-surface border border-glass-border/60 shadow-2xl"
              >
                <div className="w-14 h-14 rounded-2xl bg-accent-warning/15 text-accent-warning flex items-center justify-center">
                  <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-ink">Locked Conversation</h2>
                  <p className="mt-1 text-xs text-ink-dim leading-relaxed">
                    This conversation is protected. Enter your account password to decrypt and view messages.
                  </p>
                </div>
                <form onSubmit={handleUnlockConversation} className="w-full flex flex-col gap-3">
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
              </NeoSurface>
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between border-b border-glass-border/40 px-3 sm:px-6 py-2.5 bg-surface shrink-0">
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

          {/* Independently scrollable message history */}
          <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3">
            <div className="mx-auto w-full max-w-3xl flex flex-col gap-2.5">
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
                  <div key={m.id} id={`msg-${m.id}`} className={`flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}>
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
                            onClick={() => openAttachment(attachment)}
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
                        />
                      )}
                    </div>
                    {openActionsFor === m.id && (
                      <div className="neo-raised mt-1 flex gap-1 rounded-lg p-1">
                        <button onClick={() => startReply(m)} className="rounded-md px-2 py-1 text-[11px] font-semibold text-ink-dim">
                          Reply
                        </button>
                        {!attachment && (
                          <button onClick={() => copyMessage(m)} className="rounded-md px-2 py-1 text-[11px] font-semibold text-ink-dim">
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
                      </div>
                    )}
                  </div>
                );
              })}
              {peerTyping && <TypingIndicator />}
            </div>
          </div>

          {(replyTo || editingId) && (
            <div className="px-3 sm:px-6 shrink-0">
              <div className="mx-auto w-full max-w-3xl">
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
          <div className="border-t border-glass-border/40 p-2.5 sm:p-4 bg-surface shrink-0">
            {isChatExpired ? (
              <div className="mx-auto w-full max-w-3xl flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-danger/10 border border-danger/20 text-danger">
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
              <div className="mx-auto w-full max-w-3xl flex items-center gap-2.5">
                <Button variant="raised" size="icon" aria-label="Attach a file" onClick={() => fileInputRef.current?.click()}>
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
                    value={draft}
                    onChange={(e) => onDraftChange(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && send()}
                    placeholder="Message"
                    aria-label="Message text"
                    className="w-full bg-transparent px-3 py-2.5 sm:py-3 text-sm text-ink placeholder:text-ink-dim focus:outline-none"
                  />
                </NeoSurface>
                <Button variant="glass" size="icon" accent="info" aria-label="Send message" onClick={send}>
                  <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-[17px] w-[17px]" aria-hidden="true">
                    <path d="M3 11.5L21 3l-8.5 18-2.5-7.5L3 11.5z" />
                  </svg>
                </Button>
              </div>
            )}
          </div>

          {/* Image Preview & Caption Modal */}
          {pendingImageFile && (
            <ImagePreviewModal
              file={pendingImageFile}
              onSend={async (file, caption) => {
                await sendFile(file, caption);
              }}
              onCancel={() => setPendingImageFile(null)}
              isSending={isSendingAttachment}
            />
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
                    <Button
                      variant="ghost"
                      accent="danger"
                      className="w-full justify-start text-xs font-semibold !py-2.5"
                      onClick={() => setConfirmAction('block')}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2 shrink-0">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                      </svg>
                      Block Contact
                    </Button>
                    <Button
                      variant="ghost"
                      accent="danger"
                      className="w-full justify-start text-xs font-semibold !py-2.5"
                      onClick={() => {
                        setBurnPassword('');
                        setBurnError(null);
                        setConfirmAction('burn');
                      }}
                    >
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className="mr-2 shrink-0">
                        <path d="M12 2c.5 3 2.5 5 4 7 1.5 2 2 4.5 1 7-1 2.5-3 4-5 4s-4-1.5-5-4c-1-2.5-.5-5 1-7 1.5-2 3.5-4 4-7z" />
                      </svg>
                      Burn Conversation
                    </Button>
                  </div>
                </div>
              </NeoSurface>
            </div>
          )}

          {/* Themed Confirmation Modal for Block / Burn */}
          {confirmAction && (
            <div
              role="dialog"
              aria-modal="true"
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
            >
              <NeoSurface variant="raised" className="w-full max-w-sm p-6 flex flex-col gap-4 bg-surface rounded-2xl shadow-2xl">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-danger/15 text-danger flex items-center justify-center shrink-0">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-ink">
                      {confirmAction === 'block' ? 'Block Contact?' : 'Burn Conversation?'}
                    </h3>
                    <p className="text-xs text-ink-dim mt-0.5">
                      {confirmAction === 'block'
                        ? 'You will no longer receive messages in this conversation.'
                        : 'Permanently destroy all cryptographic session keys and message history on both devices. This cannot be undone.'}
                    </p>
                  </div>
                </div>

                {confirmAction === 'burn' && (
                  <div className="flex flex-col gap-1.5 py-1">
                    <label className="text-[11px] font-semibold text-ink-dim">
                      Enter account password to authorize:
                    </label>
                    <NeoInput
                      type="password"
                      placeholder="Account password"
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

                <div className="flex gap-2 pt-2">
                  <Button
                    variant="ghost"
                    className="flex-1 text-xs"
                    disabled={burnLoading}
                    onClick={() => {
                      setConfirmAction(null);
                      setBurnPassword('');
                      setBurnError(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="raised"
                    accent="danger"
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
                      }
                    }}
                  >
                    {burnLoading
                      ? 'Burning…'
                      : confirmAction === 'block'
                      ? 'Confirm Block'
                      : 'Confirm Burn'}
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
