'use client';

import { useEffect, useRef, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppHeader } from '@/components/navigation/AppHeader';
import { ConversationSidebar } from '@/components/chat/ConversationSidebar';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { connectSocket } from '@/lib/realtime/socket';
import { idbGet } from '@/lib/storage/localDb';
import { DeviceIdentity } from '@/lib/crypto/engine';
import {
  generateRoomKey,
  encryptRoomKeyForRecipient,
  decryptRoomKeyFromSender,
  encryptRoomMessage,
  decryptRoomMessage,
} from '@/lib/crypto/roomCrypto';
import { loadRoomKey, saveRoomKey } from '@/lib/storage/roomStorage';

interface RoomMember {
  id: string;
  userId: string;
  username: string;
  displayName: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  joinedAt: string;
}

interface RoomDetails {
  id: string;
  name: string;
  maxMembers: number;
  memberCount: number;
  joinPolicy: 'OPEN' | 'APPROVAL_REQUIRED';
  status: string;
  keyEpoch: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  code: string | null;
  owner: { id: string; username: string; displayName: string | null };
  members: RoomMember[];
  createdAt: string;
}

interface JoinRequest {
  id: string;
  roomId: string;
  requester: {
    id: string;
    username: string;
    displayName: string | null;
    identityDhPublic: string | null;
  };
  createdAt: string;
  status: string;
}

interface DisplayMessage {
  id: string;
  roomId: string;
  sender: { id: string; username: string; displayName: string | null };
  sequenceNumber: number;
  clientMessageId: string;
  plaintext?: string;
  decryptFailed?: boolean;
  messageType: string;
  sentAt: string;
  isSystem?: boolean;
}

export default function RoomChatPage({ params }: { params: Promise<{ roomId: string }> }) {
  const resolvedParams = use(params);
  const roomId = resolvedParams.roomId;
  const { userId } = useAuth();
  const router = useRouter();

  const [room, setRoom] = useState<RoomDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roomKey, setRoomKey] = useState<Uint8Array | null>(null);

  // Pending requests (for owner)
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [acceptingStatus, setAcceptingStatus] = useState<string | null>(null);

  // Messages
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);

  // Header helpers
  const [copiedCode, setCopiedCode] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const roomKeyRef = useRef<Uint8Array | null>(null);
  roomKeyRef.current = roomKey;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load room details and room key
  useEffect(() => {
    let mounted = true;

    async function initRoom() {
      try {
        setLoading(true);
        setLoadError(null);
        const data = await api<RoomDetails>(`/api/rooms/${roomId}`);
        if (!mounted) return;
        setRoom(data);

        // Try loading cached room key
        let key = await loadRoomKey(roomId, data.keyEpoch);
        if (!key && data.role === 'OWNER') {
          // If owner and key not in IDB (e.g. fresh device), generate and save
          key = generateRoomKey();
          await saveRoomKey(roomId, data.keyEpoch, key);
        } else if (!key) {
          // Normal member: fetch key package from backend
          try {
            const keyPkgRes = await api<{
              keyPackage: {
                encryptedKey: string;
                nonce: string;
                sender: { identityDhPublic: string };
              } | null;
            }>(`/api/rooms/${roomId}/key-package`);

            if (keyPkgRes.keyPackage) {
              const identity = await idbGet<DeviceIdentity>('crypto:identity');
              if (identity) {
                key = await decryptRoomKeyFromSender(
                  keyPkgRes.keyPackage.encryptedKey,
                  keyPkgRes.keyPackage.nonce,
                  keyPkgRes.keyPackage.sender.identityDhPublic,
                  identity._private.identityDhKeyPair.privateKey,
                );
                await saveRoomKey(roomId, data.keyEpoch, key);
              }
            }
          } catch {
            // Key not yet delivered
          }
        }

        if (mounted) setRoomKey(key);

        // If owner, fetch pending requests
        if (data.role === 'OWNER') {
          const reqs = await api<JoinRequest[]>(`/api/rooms/${roomId}/requests`).catch(() => []);
          if (mounted) setPendingRequests(reqs);
        }

        // Fetch messages
        const msgs = await api<any[]>(`/api/rooms/${roomId}/messages`).catch(() => []);
        if (mounted) {
          const decryptedList: DisplayMessage[] = [];
          for (const m of msgs) {
            let plaintext = '';
            let decryptFailed = false;
            if (key) {
              try {
                const aad = new TextEncoder().encode(`${roomId}:${m.sequenceNumber}`);
                plaintext = await decryptRoomMessage(key, m.ciphertext, m.iv, aad);
              } catch {
                decryptFailed = true;
              }
            } else {
              decryptFailed = true;
            }
            decryptedList.push({ ...m, plaintext, decryptFailed });
          }
          setMessages(decryptedList);
        }
      } catch (e) {
        if (mounted) {
          setLoadError(e instanceof ApiError ? e.message : 'Could not load room.');
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    initRoom();
    return () => {
      mounted = false;
    };
  }, [roomId]);

  // Real-time socket events
  useEffect(() => {
    let active = true;

    async function setupSocket() {
      try {
        const socket = await connectSocket();
        if (!active) return;

        // 1. Join request event (for owner)
        socket.on('room:join_request', (evt: any) => {
          if (evt.roomId === roomId) {
            setPendingRequests((prev) => {
              if (prev.some((r) => r.id === evt.requestId)) return prev;
              return [
                ...prev,
                {
                  id: evt.requestId,
                  roomId: evt.roomId,
                  requester: evt.requester,
                  createdAt: evt.createdAt,
                  status: 'PENDING',
                },
              ];
            });
          }
        });

        // 2. Member joined event
        socket.on('room:member_joined', (evt: any) => {
          if (evt.roomId === roomId) {
            setRoom((prev) =>
              prev
                ? {
                    ...prev,
                    memberCount: evt.memberCount,
                    members: prev.members.some((m) => m.userId === evt.user.id)
                      ? prev.members
                      : [
                          ...prev.members,
                          {
                            id: 'temp-' + Date.now(),
                            userId: evt.user.id,
                            username: evt.user.username,
                            displayName: evt.user.displayName,
                            role: 'MEMBER',
                            joinedAt: new Date().toISOString(),
                          },
                        ],
                  }
                : prev,
            );

            // Subtle inline system message
            setMessages((prev) => [
              ...prev,
              {
                id: 'sys-' + Date.now() + Math.random(),
                roomId,
                sender: evt.user,
                sequenceNumber: 0,
                clientMessageId: 'sys-join',
                plaintext: `@${evt.user.username} joined the room`,
                messageType: 'SYSTEM',
                sentAt: new Date().toISOString(),
                isSystem: true,
              },
            ]);
          }
        });

        // 3. Member left event
        socket.on('room:member_left', (evt: any) => {
          if (evt.roomId === roomId) {
            setRoom((prev) =>
              prev
                ? {
                    ...prev,
                    memberCount: evt.memberCount,
                    members: prev.members.filter((m) => m.userId !== evt.user.id),
                  }
                : prev,
            );

            setMessages((prev) => [
              ...prev,
              {
                id: 'sys-leave-' + Date.now(),
                roomId,
                sender: evt.user,
                sequenceNumber: 0,
                clientMessageId: 'sys-leave',
                plaintext: `@${evt.user.username} left the room`,
                messageType: 'SYSTEM',
                sentAt: new Date().toISOString(),
                isSystem: true,
              },
            ]);
          }
        });

        // 4. Room closed event
        socket.on('room:closed', (evt: any) => {
          if (evt.roomId === roomId) {
            alert(`Room "${evt.roomName}" was closed by the owner.`);
            router.push('/chat');
          }
        });

        // 5. Room message event
        socket.on('room:message', async (evt: any) => {
          if (evt.roomId === roomId) {
            let plaintext = '';
            let decryptFailed = false;
            const currentKey = roomKeyRef.current;
            if (currentKey) {
              try {
                const aad = new TextEncoder().encode(`${roomId}:${evt.sequenceNumber}`);
                plaintext = await decryptRoomMessage(currentKey, evt.ciphertext, evt.iv, aad);
              } catch {
                decryptFailed = true;
              }
            } else {
              decryptFailed = true;
            }

            setMessages((prev) => {
              if (prev.some((m) => m.clientMessageId === evt.clientMessageId)) return prev;
              return [...prev, { ...evt, plaintext, decryptFailed }];
            });
          }
        });
      } catch {
        // Socket connection failed
      }
    }

    setupSocket();

    return () => {
      active = false;
    };
  }, [roomId, router]);

  // Handle Accept
  async function handleAccept(requestId: string, requesterIdentityDhPublic: string | null) {
    if (processingRequestId) return;
    setProcessingRequestId(requestId);
    setAcceptingStatus('Joining room...');

    try {
      let keyPayload: { encryptedKey?: string; nonce?: string } = {};

      // If we have the room key and requester public key, wrap the room key for them
      if (roomKey && requesterIdentityDhPublic) {
        const identity = await idbGet<DeviceIdentity>('crypto:identity');
        if (identity) {
          const wrapped = await encryptRoomKeyForRecipient(
            roomKey,
            requesterIdentityDhPublic,
            identity._private.identityDhKeyPair.privateKey,
          );
          keyPayload = wrapped;
        }
      }

      await api(`/api/rooms/${roomId}/requests/${requestId}/accept`, {
        method: 'POST',
        body: keyPayload,
      });

      // Animated "joined" transition state
      const currentReq = pendingRequests.find((r) => r.id === requestId);
      setAcceptingStatus(`✓ @${currentReq?.requester.username ?? 'user'} joined the room`);

      setTimeout(() => {
        setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
        setProcessingRequestId(null);
        setAcceptingStatus(null);
      }, 900);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Could not accept request.');
      setProcessingRequestId(null);
      setAcceptingStatus(null);
    }
  }

  // Handle Reject
  async function handleReject(requestId: string) {
    if (processingRequestId) return;
    setProcessingRequestId(requestId);

    try {
      await api(`/api/rooms/${roomId}/requests/${requestId}/reject`, {
        method: 'POST',
      });
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Could not reject request.');
    } finally {
      setProcessingRequestId(null);
    }
  }

  // Handle Send Message
  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || sending || !roomKey) return;

    setSending(true);
    const clientMessageId = 'rm_' + Date.now() + '_' + Math.random().toString(36).slice(2);

    try {
      // Estimated next sequence number for AAD
      const nextSeq = (messages[messages.length - 1]?.sequenceNumber ?? 0) + 1;
      const aad = new TextEncoder().encode(`${roomId}:${nextSeq}`);
      const { ciphertext, iv } = await encryptRoomMessage(roomKey, text, aad);

      setInputText('');
      await api(`/api/rooms/${roomId}/messages`, {
        method: 'POST',
        body: { clientMessageId, ciphertext, iv, messageType: 'TEXT' },
      });
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Could not send message.');
    } finally {
      setSending(false);
    }
  }

  // Handle Copy Code
  async function handleCopyCode() {
    if (!room?.code) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {}
  }

  // Handle Leave or Delete
  async function handleLeaveRoom() {
    if (!confirm('Are you sure you want to leave this room?')) return;
    try {
      await api(`/api/rooms/${roomId}/leave`, { method: 'POST' });
      router.push('/chat');
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not leave room.');
    }
  }

  async function handleDeleteRoom() {
    if (!confirm('Are you sure you want to delete and close this room for everyone?')) return;
    try {
      await api(`/api/rooms/${roomId}`, { method: 'DELETE' });
      router.push('/chat');
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not delete room.');
    }
  }

  if (loading) {
    return (
      <div className="flex h-dvh w-full flex-col bg-surface">
        <AppHeader activeTab="Chat" />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 rounded-full border-2 border-info border-t-transparent animate-spin mx-auto" />
            <div className="text-xs text-ink-dim">Loading room...</div>
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !room) {
    return (
      <div className="flex h-dvh w-full flex-col bg-surface">
        <AppHeader activeTab="Chat" />
        <div className="flex flex-1 items-center justify-center p-6">
          <NeoSurface variant="raised" className="max-w-md p-6 text-center space-y-4">
            <div className="text-danger font-bold text-base">Unable to open room</div>
            <p className="text-xs text-ink-dim">{loadError ?? 'Room not found.'}</p>
            <Link href="/chat">
              <Button variant="raised" accent="info" className="text-xs !py-2 !px-4">
                Back to Chats
              </Button>
            </Link>
          </NeoSurface>
        </div>
      </div>
    );
  }

  const activeRequest = pendingRequests[0];

  return (
    <div className="flex h-dvh max-h-dvh w-full flex-col overflow-hidden bg-surface">
      <AppHeader activeTab="Chat" />

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Left: Desktop Sidebar */}
        <aside className="hidden md:flex w-80 lg:w-96 shrink-0 h-full border-r border-glass-border/40 flex-col bg-surface">
          <ConversationSidebar activeRoomId={roomId} />
        </aside>

        {/* Right: Room Area */}
        <section aria-label="Room chat area" className="flex flex-1 flex-col h-full overflow-hidden bg-surface-2/20">
          {/* Header */}
          <div className="glass px-4 py-3 shrink-0 flex items-center justify-between border-b border-glass-border/40">
            <div className="flex items-center gap-3 min-w-0">
              <Link href="/chat" className="md:hidden text-ink-dim hover:text-ink p-1 -ml-1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </Link>
              <div className="w-9 h-9 rounded-xl bg-info/10 text-info flex items-center justify-center shrink-0 border border-info/20 shadow-sm">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-5 h-5">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="font-bold text-sm sm:text-base text-ink truncate">{room.name}</h1>
                  <span className="px-2 py-0.5 rounded-full bg-surface-2 text-[10px] font-bold text-ink-dim border border-glass-border/40">
                    {room.memberCount} / {room.maxMembers}
                  </span>
                </div>
                <div className="text-[11px] text-ink-dim truncate">
                  Owner: @{room.owner.username} · {room.joinPolicy === 'APPROVAL_REQUIRED' ? 'Approval required' : 'Open join'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {room.code && (
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-xs font-mono text-ink border border-glass-border/50 transition-colors"
                  title="Copy Room Join Code"
                >
                  <span>{room.code}</span>
                  <span className="text-[10px] text-info font-sans">{copiedCode ? '✓ Copied' : 'Copy'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowMembersModal(true)}
                className="p-2 text-ink-dim hover:text-ink rounded-lg bg-surface-2/60 hover:bg-surface-2 border border-glass-border/40 text-xs"
                title="View Room Members"
              >
                👥
              </button>

              {room.role === 'OWNER' ? (
                <button
                  type="button"
                  onClick={handleDeleteRoom}
                  className="px-2.5 py-1 text-xs text-danger hover:bg-danger/10 rounded-lg border border-danger/30 transition-colors"
                  title="Close and delete room"
                >
                  Close
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleLeaveRoom}
                  className="px-2.5 py-1 text-xs text-ink-dim hover:text-danger rounded-lg border border-glass-border/40 transition-colors"
                  title="Leave room"
                >
                  Leave
                </button>
              )}
            </div>
          </div>

          {actionError && (
            <div className="mx-4 mt-2 p-2.5 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger flex items-center justify-between">
              <span>{actionError}</span>
              <button type="button" onClick={() => setActionError(null)} className="text-xs font-bold">✕</button>
            </div>
          )}

          {/* TOP OWNER REQUEST QUEUE CARD (Requirements 7, 8, 9, 10, 24) */}
          {room.role === 'OWNER' && activeRequest && (
            <div className="mx-4 mt-3 mb-1 shrink-0">
              <div className="p-3.5 glass rounded-2xl border border-info/30 bg-surface/90 shadow-md transition-all duration-300 transform translate-y-0">
                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-ink-dim mb-2">
                  <div className="flex items-center gap-1.5 text-info">
                    <span className="inline-block w-2 h-2 rounded-full bg-info animate-pulse" />
                    <span>Join Request</span>
                  </div>
                  {pendingRequests.length > 1 && (
                    <span className="px-2 py-0.5 rounded-full bg-surface-2 text-[10px] font-semibold text-ink-dim border border-glass-border/40">
                      +{pendingRequests.length - 1} more request{pendingRequests.length > 2 ? 's' : ''}
                    </span>
                  )}
                </div>

                {acceptingStatus ? (
                  <div className="py-2 px-3 text-center text-xs font-semibold text-accent flex items-center justify-center gap-2">
                    <span>{acceptingStatus}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-info/10 text-info font-bold text-xs flex items-center justify-center shrink-0 border border-info/20">
                      {activeRequest.requester.username.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-xs sm:text-sm text-ink truncate">
                        @{activeRequest.requester.username}
                      </div>
                      <div className="text-[11px] text-ink-dim truncate">
                        wants to join this room
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        disabled={processingRequestId !== null}
                        onClick={() => handleReject(activeRequest.id)}
                        className="text-xs !py-1 !px-3"
                      >
                        Reject
                      </Button>
                      <Button
                        variant="raised"
                        accent="info"
                        disabled={processingRequestId !== null}
                        onClick={() => handleAccept(activeRequest.id, activeRequest.requester.identityDhPublic)}
                        className="text-xs !py-1 !px-3 font-bold"
                      >
                        Accept
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Messages Feed */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-12 text-xs text-ink-dim space-y-1">
                <p className="font-semibold">This is the start of #{room.name}.</p>
                <p className="text-[11px]">Messages are end-to-end encrypted for members.</p>
              </div>
            )}

            {messages.map((m) => {
              if (m.isSystem) {
                return (
                  <div key={m.id} className="text-center my-2 text-[11px] text-ink-dim font-medium tracking-wide">
                    ──── {m.plaintext} ────
                  </div>
                );
              }

              const isMe = m.sender?.id === userId;

              return (
                <div key={m.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                  {!isMe && (
                    <span className="text-[10px] text-ink-dim font-medium mb-0.5 pl-2">
                      @{m.sender?.username ?? 'member'}
                    </span>
                  )}
                  <div
                    className={`max-w-[80%] sm:max-w-md px-3.5 py-2 rounded-2xl text-xs sm:text-sm shadow-sm break-words ${
                      isMe
                        ? 'bg-info text-white rounded-br-none'
                        : 'glass text-ink rounded-bl-none border border-glass-border/40'
                    }`}
                  >
                    {m.decryptFailed ? (
                      <span className="italic opacity-70">🔒 Encrypted group message</span>
                    ) : (
                      m.plaintext
                    )}
                    <div
                      className={`text-[9px] mt-1 text-right ${
                        isMe ? 'text-white/70' : 'text-ink-dim'
                      }`}
                    >
                      {new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Composer */}
          <form onSubmit={handleSendMessage} className="p-3 glass border-t border-glass-border/40 flex items-center gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Send an encrypted message..."
              disabled={sending || !roomKey}
              className="flex-1 bg-surface-2/60 text-xs sm:text-sm text-ink placeholder:text-ink-dim rounded-xl px-3.5 py-2.5 border border-glass-border/40 focus:outline-none focus:ring-1 focus:ring-info/60"
            />
            <Button
              type="submit"
              variant="raised"
              accent="info"
              disabled={sending || !inputText.trim() || !roomKey}
              className="text-xs !py-2 !px-4 font-bold shrink-0"
            >
              {sending ? '...' : 'Send'}
            </Button>
          </form>
        </section>
      </div>

      {/* Members Modal */}
      {showMembersModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <NeoSurface variant="raised" className="w-full max-w-sm p-5 space-y-4 rounded-2xl">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-sm text-ink">Room Members ({room.members.length})</h2>
              <button
                type="button"
                onClick={() => setShowMembersModal(false)}
                className="text-ink-dim hover:text-ink text-sm font-bold"
              >
                ✕
              </button>
            </div>

            <div className="max-h-60 overflow-y-auto space-y-2 divide-y divide-glass-border/30">
              {room.members.map((m) => (
                <div key={m.id} className="pt-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-ink truncate">@{m.username}</span>
                    {m.displayName && <span className="text-ink-dim truncate">({m.displayName})</span>}
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                    m.role === 'OWNER'
                      ? 'bg-accent/15 text-accent border-accent/30'
                      : 'bg-surface-2 text-ink-dim border-glass-border/40'
                  }`}>
                    {m.role}
                  </span>
                </div>
              ))}
            </div>

            <Button
              variant="ghost"
              onClick={() => setShowMembersModal(false)}
              className="w-full text-xs"
            >
              Close
            </Button>
          </NeoSurface>
        </div>
      )}
    </div>
  );
}
