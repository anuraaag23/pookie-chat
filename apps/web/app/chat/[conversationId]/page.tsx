'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { MessageBubble } from '@/components/chat/MessageBubble';
import { TypingIndicator } from '@/components/chat/TypingIndicator';
import { useAuth } from '@/lib/auth/AuthContext';
import { api } from '@/lib/api/client';
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
}

function parseAttachmentPayload(text: string): AttachmentPayload | null {
  try {
    const parsed = JSON.parse(text);
    return parsed?.kind === 'attachment' ? (parsed as AttachmentPayload) : null;
  } catch {
    return null;
  }
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
    function enqueueIncoming(m: { id: string; senderId: string; sequenceNumber: number; ciphertext: string; iv: string; sentAt: string }): Promise<void> {
      const result = ratchetQueue.then(() => processIncoming(m));
      ratchetQueue = result.catch(() => {}); // one bad message must never wedge the queue for everything after it
      return result;
    }

    async function processIncoming(m: { id: string; senderId: string; sequenceNumber: number; ciphertext: string; iv: string; sentAt: string }) {
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
      const alreadyCached = (await getCachedMessages(conversationId)).some((c) => c.id === m.id);
      if (alreadyCached) {
        await updateCachedMessage(conversationId, m.id, { text });
        if (!cancelled) setMessages((prev) => prev.map((p) => (p.id === m.id ? { ...p, text } : p)));
      } else {
        const cachedMsg: CachedMessage = { id: m.id, conversationId, senderId: m.senderId, text, sentAt: m.sentAt, status: 'delivered', mine: false };
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
        new Notification('Pookie Chat', {
          body: settingsRef.current.notificationContentVisible ? text : 'New message',
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
      if (session) {
        try {
          const status = await api<{ id: string; status: string; sessionEpoch: number }>(`/api/conversations/${conversationId}`);
          if (isSessionStale(session, status)) {
            await deleteSession(conversationId);
            await clearCachedMessages(conversationId);
            if (!cancelled) setMessages([]);
            session = null;
          }
        } catch {
          return session;
        }
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
      socket.on('message', (evt: { id: string; senderId: string; sequenceNumber: number; ciphertext: string; iv: string; sentAt: string }) => {
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
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  async function send() {
    const text = draft.trim();
    if (!text || !sessionRef.current) return;
    setDraft('');
    const replyToMessageId = replyTo?.id;
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

    // crypto.randomUUID(), not Math.random() — this is validated as
    // @IsUUID() by the real backend's SendMessageDto (messages.dto.ts),
    // so a non-UUID-shaped id (the previous Date.now()+Math.random()
    // construction) would have been rejected by NestJS's ValidationPipe
    // on every real send. The harness never caught this because it
    // doesn't replicate class-validator's format checks — found while
    // specifically hunting for client/server contract mismatches the
    // harness can't see, not by running the real stack (still not
    // possible in this environment; see the final report).
    const clientMessageId = crypto.randomUUID();
    // Wrapped — previously a failed request here (backend down, network
    // drop, a stale-epoch 409, anything) propagated as an unhandled
    // rejection: the draft was already cleared above, so the user's
    // typed message just vanished with no error and no way to recover
    // the text. MessageBubble already renders a 'failed' status
    // ("Failed to send") — nothing ever fed it one. Shown in local
    // state only, not cached: there's no server-confirmed id for a
    // message that was never actually accepted, so persisting it across
    // a reload would need its own local-only identity scheme, which is
    // more than this fix needs — the user can see it and retype it
    // while the tab is still open, which is the actual gap being closed.
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

  async function sendFile(file: File) {
    if (!sessionRef.current) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setActionError('File is too large (25MB limit).');
      return;
    }
    // Wrapped for the same reason as send() above — two network calls
    // here (upload, then the message send referencing it), either of
    // which failing previously meant the attempt just vanished with no
    // feedback and no way to know the file never actually reached the
    // other person.
    try {
      const encrypted = await encryptFile(file);
      const { attachmentId } = await uploadAttachment(conversationId, encrypted.ciphertext, encrypted.mimeTypeHint, encrypted.originalSize);

      const payload: AttachmentPayload = {
        kind: 'attachment',
        attachmentId,
        dek: btoa(String.fromCharCode(...encrypted.dek)),
        mimeTypeHint: encrypted.mimeTypeHint,
        filename: file.name,
      };
      const content = JSON.stringify(payload);

      const aad = buildAad(conversationId, sessionRef.current.sendStep);
      const { envelope, nextChainKey } = await ratchetEncrypt(sessionRef.current.sendingChainKey, content, aad);
      sessionRef.current.sendingChainKey = nextChainKey;
      sessionRef.current.sendStep += 1;
      await saveSession(conversationId, sessionRef.current);

      // See send()'s identical fix above — same @IsUUID() requirement applies here.
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
    } catch {
      setActionError(`Failed to send "${file.name}". Please try again.`);
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
      // Same "at least tell the person" fix as send()/sendFile() above —
      // previously an unhandled rejection here (download failure, a
      // burned/expired attachment now 404ing, a corrupted or truncated
      // ciphertext failing to decrypt) left the tap on the attachment
      // looking like it simply did nothing.
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
    try {
      await api(`/api/conversations/${conversationId}/burn`, { method: 'POST' });
    } catch {
      // Deliberately does not clear the local session/cache below on
      // failure — if the server call didn't actually succeed (network
      // drop, or the conversation was already burned/blocked by the
      // other party in a race), wiping this device's own copy would
      // make the local view diverge from what the server still has,
      // with no way back short of re-pairing. Leaving both untouched
      // means a retry is the correct next step, not a bad state.
      setActionError('Could not burn this conversation. Please check your connection and try again.');
      return;
    }
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

  return (
    <main className="mx-auto flex h-dvh max-w-md flex-col p-4 md:max-w-xl lg:max-w-2xl">
      <header className="mb-2 flex items-center justify-between px-1 py-2">
        <div className="text-[15px] font-semibold">Conversation</div>
        <div className="flex gap-1.5">
          <Button
            variant="ghost"
            className="!px-2.5 !py-1.5 text-xs"
            onClick={() => {
              setShowDisappearing((v) => !v);
              api<{ label: string; seconds: number | null }[]>('/api/conversations/disappearing-options')
                .then(setDisappearingOptions)
                .catch(() => {}); // keep whatever's already showing (the built-in defaults, or a previously successful fetch)
            }}
          >
            Timer
          </Button>
          <Button variant="ghost" accent="danger" className="!px-2.5 !py-1.5 text-xs" onClick={handleBlock}>
            Block
          </Button>
          <Button variant="ghost" accent="danger" className="!px-2.5 !py-1.5 text-xs" onClick={handleBurn}>
            Burn
          </Button>
        </div>
      </header>

      {actionError && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between rounded-lg bg-danger/10 px-3.5 py-2 text-xs text-danger"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="ml-2 font-bold opacity-75 hover:opacity-100"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {showDisappearing && (
        <NeoSurface variant="raised" className="mb-3 flex flex-wrap gap-2 p-3">
          {disappearingOptions.map((opt) => (
            <button key={opt.label} onClick={() => setDisappearing(opt.seconds)} className="neo-raised rounded-full px-3 py-1.5 text-xs font-semibold text-ink-dim">
              {opt.label}
            </button>
          ))}
        </NeoSurface>
      )}

      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto py-1">
        {initializing && messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-xs text-ink-dim">Loading conversation…</div>
        )}
        {!initializing && messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-xs text-ink-dim">No messages yet. Say hello!</div>
        )}
        {messages.map((m) => {
          const attachment = parseAttachmentPayload(m.text);
          return (
            <div key={m.id} className={`flex flex-col ${m.mine ? 'items-end' : 'items-start'}`}>
              <div onClick={() => setOpenActionsFor(openActionsFor === m.id ? null : m.id)} className="cursor-pointer">
                {attachment ? (
                  <NeoSurface
                    variant="raised"
                    className={`flex max-w-[78%] items-center gap-2 px-4 py-3 ${m.mine ? 'bg-surface-2' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openAttachment(attachment);
                    }}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5 flex-shrink-0 text-ink-dim" aria-hidden="true">
                      {attachment.mimeTypeHint === 'image' ? (
                        <>
                          <rect x="3" y="3" width="18" height="18" rx="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <path d="M21 15l-5-5L5 21" />
                        </>
                      ) : (
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                      )}
                    </svg>
                    <span className="truncate text-sm">{attachment.filename}</span>
                  </NeoSurface>
                ) : (
                  <MessageBubble
                    direction={m.mine ? 'sent' : 'received'}
                    text={m.text}
                    timestamp={new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    status={m.mine ? m.status : undefined}
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

      {(replyTo || editingId) && (
        <div className="neo-pressed mb-1 flex items-center justify-between rounded-lg px-3 py-2 text-xs text-ink-dim">
          <span>{editingId ? 'Editing message' : `Replying to: ${replyTo?.text.slice(0, 40)}`}</span>
          <button
            onClick={() => {
              setReplyTo(null);
              setEditingId(null);
              setDraft('');
            }}
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex items-center gap-2.5 pt-2">
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
            if (file) sendFile(file);
            e.target.value = '';
          }}
        />
        <NeoSurface variant="pressed" className="flex-1 px-1">
          <input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Message"
            className="w-full bg-transparent px-3 py-3 text-sm text-ink placeholder:text-ink-dim focus:outline-none"
          />
        </NeoSurface>
        <Button variant="glass" size="icon" accent="info" aria-label="Send message" onClick={send}>
          <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-[17px] w-[17px]" aria-hidden="true">
            <path d="M3 11.5L21 3l-8.5 18-2.5-7.5L3 11.5z" />
          </svg>
        </Button>
      </div>

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
    </main>
  );
}
