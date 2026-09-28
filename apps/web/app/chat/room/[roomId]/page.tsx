'use client';

import { useEffect, useRef, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppHeader } from '@/components/navigation/AppHeader';
import { ConversationSidebar } from '@/components/chat/ConversationSidebar';
import { Button } from '@/components/ui/Button';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { NeoInput } from '@/components/ui/NeoInput';
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
  encryptOpenRoomKey,
  decryptOpenRoomKey,
} from '@/lib/crypto/roomCrypto';
import { loadRoomKey, saveRoomKey } from '@/lib/storage/roomStorage';

const ROOM_CAPACITY_PRESETS = [10, 25, 50, 100, 250, 500, 1000, 1500, 2000];

async function decryptRoomMessageWithFallback(
  key: Uint8Array,
  ciphertext: string,
  iv: string,
  roomId: string,
  clientMessageId: string,
  sequenceNumber?: number,
): Promise<string> {
  const candidates: string[] = [
    `${roomId}:${clientMessageId}`,
    sequenceNumber !== undefined ? `${roomId}:${sequenceNumber}` : null,
    `${roomId}`,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const aad = new TextEncoder().encode(candidate);
      return await decryptRoomMessage(key, ciphertext, iv, aad);
    } catch {
      // try next candidate
    }
  }
  throw new Error('Could not decrypt with candidate AAD');
}

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
  joinLocked?: boolean;
  openKeyCiphertext?: string | null;
  openKeyNonce?: string | null;
  owner: { id: string; username: string; displayName: string | null };
  members: RoomMember[];
  createdAt: string;
}

interface PaginatedMembersResponse {
  members: RoomMember[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface SearchCandidateUser {
  id: string;
  username: string;
  displayName: string | null;
  isMember: boolean;
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
  const [isSyncingKey, setIsSyncingKey] = useState(false);
  const [keySyncError, setKeySyncError] = useState<string | null>(null);

  // Pending requests (for owner)
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [acceptingStatus, setAcceptingStatus] = useState<string | null>(null);

  // Messages
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);

  // Header helpers & Modals
  const [copiedCode, setCopiedCode] = useState(false);
  const [showRoomInfoModal, setShowRoomInfoModal] = useState(false);
  const [roomInfoTab, setRoomInfoTab] = useState<'members' | 'settings'>('members');
  const [actionError, setActionError] = useState<string | null>(null);

  // Confirmation Modals (no browser confirm or alert)
  const [confirmModal, setConfirmModal] = useState<{
    type: 'leave' | 'delete' | 'remove_member';
    targetMember?: RoomMember;
  } | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deletePasswordError, setDeletePasswordError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [roomClosedBanner, setRoomClosedBanner] = useState<string | null>(null);

  // Paginated Members in Panel
  const [memberPage, setMemberPage] = useState(1);
  const [paginatedMembers, setPaginatedMembers] = useState<PaginatedMembersResponse | null>(null);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

  // Room Owner Member Search & Add
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [memberSearchResults, setMemberSearchResults] = useState<SearchCandidateUser[]>([]);
  const [isSearchingMembers, setIsSearchingMembers] = useState(false);
  const [addingMemberId, setAddingMemberId] = useState<string | null>(null);
  const [memberAddSuccess, setMemberAddSuccess] = useState<string | null>(null);
  const [memberSearchError, setMemberSearchError] = useState<string | null>(null);

  // Owner Room Settings
  const [editRoomName, setEditRoomName] = useState('');
  const [editMaxMembers, setEditMaxMembers] = useState(50);
  const [editCustomMaxMembers, setEditCustomMaxMembers] = useState('50');
  const [editJoinPolicy, setEditJoinPolicy] = useState<'OPEN' | 'APPROVAL_REQUIRED'>('APPROVAL_REQUIRED');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSuccessMessage, setSettingsSuccessMessage] = useState<string | null>(null);

  // ISSUE #8 — Group chat typing indicator state.
  // Map of userId → { username, timer } for each user currently typing.
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ISSUE #10 — Join-lock toggle state (owner UI).
  const [joinLocked, setJoinLocked] = useState(false);
  const [lockingJoin, setLockingJoin] = useState(false);

  // ISSUE #11 — Burn Password state for closing/burning room
  const [hasBurnPassword, setHasBurnPassword] = useState(false);
  const [burnSetupNewPassword, setBurnSetupNewPassword] = useState('');
  const [burnSetupConfirmPassword, setBurnSetupConfirmPassword] = useState('');
  const [burnSetupError, setBurnSetupError] = useState<string | null>(null);

  // ISSUE #8 — Group typing throttler
  const typingThrottleRef = useRef<boolean>(false);
  const emitRoomTyping = async (isTyping: boolean) => {
    try {
      const socket = await connectSocket();
      socket.emit('room_typing', { roomId, isTyping });
    } catch {}
  };

  function handleInputChange(value: string) {
    setInputText(value);
    if (!typingThrottleRef.current) {
      typingThrottleRef.current = true;
      emitRoomTyping(true);
      setTimeout(() => {
        typingThrottleRef.current = false;
      }, 2500);
    }
    if (!value.trim()) {
      emitRoomTyping(false);
    }
  }

  async function handleToggleJoinLock() {
    if (lockingJoin) return;
    setLockingJoin(true);
    try {
      const next = !joinLocked;
      const res = await api<{ roomId: string; joinLocked: boolean }>(`/api/rooms/${roomId}/join-lock`, {
        method: 'PATCH',
        body: { locked: next },
      });
      setJoinLocked(res.joinLocked);
    } catch (err: any) {
      setActionError(err.message || 'Could not update join lock.');
    } finally {
      setLockingJoin(false);
    }
  }

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const roomKeyRef = useRef<Uint8Array | null>(null);
  roomKeyRef.current = roomKey;

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load paginated members
  const fetchMembers = (page: number) => {
    setLoadingMembers(true);
    api<PaginatedMembersResponse>(`/api/rooms/${roomId}/members?page=${page}&limit=20`)
      .then((data) => {
        setPaginatedMembers(data);
        setMemberPage(data.page);
      })
      .catch(() => {})
      .finally(() => {
        setLoadingMembers(false);
      });
  };

  useEffect(() => {
    if (showRoomInfoModal && roomInfoTab === 'members') {
      fetchMembers(memberPage);
    }
  }, [showRoomInfoModal, roomInfoTab, roomId]);

  // Room Owner Member Search (debounced 300ms, min 2 chars)
  useEffect(() => {
    if (!showRoomInfoModal || room?.role !== 'OWNER') return;
    const trimmed = memberSearchQuery.trim();
    if (trimmed.length < 2) {
      setMemberSearchResults([]);
      setIsSearchingMembers(false);
      setMemberSearchError(null);
      return;
    }

    setIsSearchingMembers(true);
    setMemberSearchError(null);
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const results = await api<SearchCandidateUser[]>(
          `/api/rooms/${roomId}/search-users?query=${encodeURIComponent(trimmed)}`,
        );
        if (!cancelled) {
          setMemberSearchResults(results);
        }
      } catch (err: any) {
        if (!cancelled) {
          setMemberSearchError(err instanceof ApiError ? err.message : 'Could not search users');
        }
      } finally {
        if (!cancelled) {
          setIsSearchingMembers(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [memberSearchQuery, showRoomInfoModal, room?.role, roomId]);

  async function handleAddMember(candidate: SearchCandidateUser) {
    if (addingMemberId || candidate.isMember) return;
    setAddingMemberId(candidate.id);
    setMemberSearchError(null);
    setMemberAddSuccess(null);

    try {
      const res = await api<{ success: boolean; member: any; memberCount: number }>(
        `/api/rooms/${roomId}/members`,
        {
          method: 'POST',
          body: { userId: candidate.id },
        },
      );

      // Mark candidate as member in search results
      setMemberSearchResults((prev) =>
        prev.map((u) => (u.id === candidate.id ? { ...u, isMember: true } : u)),
      );

      // Increment room member count
      setRoom((prev) =>
        prev
          ? {
              ...prev,
              memberCount: res.memberCount ?? prev.memberCount + 1,
            }
          : prev,
      );

      // Refresh paginated members
      fetchMembers(memberPage);

      // Feedback toast/badge
      setMemberAddSuccess(`@${candidate.username} added to room`);
      setTimeout(() => setMemberAddSuccess(null), 3500);
    } catch (err: any) {
      setMemberSearchError(err instanceof ApiError ? err.message : 'Failed to add member to room.');
    } finally {
      setAddingMemberId(null);
    }
  }

  // Decrypt or retry-decrypt messages using a given room key
  const decryptMessagesWithKey = async (key: Uint8Array, rawMsgs?: any[]) => {
    const listToDecrypt = rawMsgs ?? messages;
    const decryptedList: DisplayMessage[] = [];
    for (const m of listToDecrypt) {
      if (m.isSystem) {
        decryptedList.push(m);
        continue;
      }
      if (!m.decryptFailed && m.plaintext !== undefined && m.plaintext !== '') {
        decryptedList.push(m);
        continue;
      }
      let plaintext = '';
      let decryptFailed = false;
      try {
        plaintext = await decryptRoomMessageWithFallback(key, m.ciphertext, m.iv, roomId, m.clientMessageId, m.sequenceNumber);
      } catch {
        decryptFailed = true;
      }
      decryptedList.push({ ...m, plaintext, decryptFailed });
    }
    setMessages(decryptedList);
  };

  // Synchronize room key from IDB, open room decryption, or backend key-package
  const syncRoomKey = async (overrideRoom?: RoomDetails | null): Promise<Uint8Array | null> => {
    const targetRoom = overrideRoom ?? room;
    if (!targetRoom) return null;

    setIsSyncingKey(true);
    setKeySyncError(null);

    try {
      // 1. Try loading cached room key from IDB
      let key = await loadRoomKey(roomId, targetRoom.keyEpoch);

      // 2. If Owner and key not in IDB (e.g. fresh device or cache cleared), generate and save
      if (!key && targetRoom.role === 'OWNER') {
        key = generateRoomKey();
        await saveRoomKey(roomId, targetRoom.keyEpoch, key);
        if (targetRoom.code) {
          encryptOpenRoomKey(key, targetRoom.code).then(({ openKeyCiphertext, openKeyNonce }) => {
            api(`/api/rooms/${roomId}`, { method: 'PATCH', body: { openKeyCiphertext, openKeyNonce } }).catch(() => {});
          });
        }
      }

      // 3. Open room: decrypt key package using room code
      if (!key && targetRoom.code && targetRoom.openKeyCiphertext && targetRoom.openKeyNonce) {
        try {
          key = await decryptOpenRoomKey(targetRoom.openKeyCiphertext, targetRoom.openKeyNonce, targetRoom.code);
          if (key) {
            await saveRoomKey(roomId, targetRoom.keyEpoch, key);
          }
        } catch {
          // Fall through to member key package
        }
      }

      // 4. Normal member: fetch key package from backend
      if (!key) {
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
              if (key) {
                await saveRoomKey(roomId, targetRoom.keyEpoch, key);
              }
            }
          }
        } catch {
          // Key not yet delivered
        }
      }

      // 5. If Owner has key and room has code but open key not published yet, publish it
      if (targetRoom.role === 'OWNER' && key && targetRoom.code && (!targetRoom.openKeyCiphertext || !targetRoom.openKeyNonce)) {
        encryptOpenRoomKey(key, targetRoom.code).then(({ openKeyCiphertext, openKeyNonce }) => {
          api(`/api/rooms/${roomId}`, { method: 'PATCH', body: { openKeyCiphertext, openKeyNonce } }).catch(() => {});
        });
      }

      if (key) {
        setRoomKey(key);
        setKeySyncError(null);
        await decryptMessagesWithKey(key);
        return key;
      } else {
        if (targetRoom.joinPolicy === 'OPEN') {
          if (!targetRoom.openKeyCiphertext) {
            setKeySyncError('Room key is being prepared by the room owner.');
          } else if (!targetRoom.code) {
            setKeySyncError('Room code required to decrypt room key.');
          } else {
            setKeySyncError('Could not decrypt open room key with code.');
          }
        } else {
          setKeySyncError('Room encryption key has not been delivered by the owner yet.');
        }
        return null;
      }
    } catch (err: any) {
      setKeySyncError(err?.message || 'Error synchronizing room key.');
      return null;
    } finally {
      setIsSyncingKey(false);
    }
  };

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
        setJoinLocked(!!data.joinLocked);
        api<{ hasBurnPassword?: boolean }>('/api/settings')
          .then((s) => {
            if (mounted) setHasBurnPassword(!!s.hasBurnPassword);
          })
          .catch(() => {});
        setEditRoomName(data.name);
        setEditMaxMembers(data.maxMembers);
        setEditCustomMaxMembers(String(data.maxMembers));
        setEditJoinPolicy(data.joinPolicy);

        // Fetch messages
        const msgs = await api<any[]>(`/api/rooms/${roomId}/messages`).catch(() => []);

        // Sync room key
        const key = await syncRoomKey(data);

        if (mounted) {
          const decryptedList: DisplayMessage[] = [];
          for (const m of msgs) {
            let plaintext = '';
            let decryptFailed = false;
            if (key) {
              try {
                plaintext = await decryptRoomMessageWithFallback(key, m.ciphertext, m.iv, roomId, m.clientMessageId, m.sequenceNumber);
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

        // If owner, fetch pending requests
        if (data.role === 'OWNER') {
          const reqs = await api<JoinRequest[]>(`/api/rooms/${roomId}/requests`).catch(() => []);
          if (mounted) setPendingRequests(reqs);
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

            if (showRoomInfoModal) fetchMembers(memberPage);
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

            if (showRoomInfoModal) fetchMembers(memberPage);
          }
        });

        // 4. Room updated event (name, capacity, join policy)
        socket.on('room:updated', (evt: any) => {
          if (evt.roomId === roomId) {
            setRoom((prev) =>
              prev
                ? {
                    ...prev,
                    name: evt.name ?? prev.name,
                    maxMembers: evt.maxMembers ?? prev.maxMembers,
                    joinPolicy: evt.joinPolicy ?? prev.joinPolicy,
                  }
                : prev,
            );
          }
        });

        // 5. Room closed event (themed modal, zero alert)
        socket.on('room:closed', (evt: any) => {
          if (evt.roomId === roomId) {
            setRoomClosedBanner(`This room was closed and deleted by the owner.`);
          }
        });

        // 6. Member removed event (if me)
        socket.on('room:member_removed', (evt: any) => {
          if (evt.roomId === roomId) {
            setRoomClosedBanner(`You have been removed from this room by the owner.`);
          }
        });

        // 7. Room message event
        socket.on('room:message', async (evt: any) => {
          if (evt.roomId === roomId) {
            let plaintext = '';
            let decryptFailed = false;
            const currentKey = roomKeyRef.current;
            if (currentKey) {
              try {
                plaintext = await decryptRoomMessageWithFallback(currentKey, evt.ciphertext, evt.iv, roomId, evt.clientMessageId, evt.sequenceNumber);
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

            // Clear the sender's typing indicator when their message arrives
            if (evt.sender?.id) {
              const timer = typingTimers.current.get(evt.sender.id);
              if (timer) clearTimeout(timer);
              typingTimers.current.delete(evt.sender.id);
              setTypingUsers((prev) => {
                const next = new Map(prev);
                next.delete(evt.sender.id);
                return next;
              });
            }
          }
        });

        // ISSUE #8 — Group chat typing indicator
        socket.on('room_typing', (evt: { roomId: string; from: string; username: string; isTyping: boolean }) => {
          if (evt.roomId !== roomId) return;
          const { from, username, isTyping } = evt;

          // Clear any existing auto-stop timer for this user
          const existing = typingTimers.current.get(from);
          if (existing) clearTimeout(existing);

          if (isTyping) {
            // Auto-remove after 5 seconds of silence
            const timer = setTimeout(() => {
              typingTimers.current.delete(from);
              setTypingUsers((prev) => {
                const next = new Map(prev);
                next.delete(from);
                return next;
              });
            }, 5000);
            typingTimers.current.set(from, timer);
            setTypingUsers((prev) => {
              const next = new Map(prev);
              next.set(from, username);
              return next;
            });
          } else {
            typingTimers.current.delete(from);
            setTypingUsers((prev) => {
              const next = new Map(prev);
              next.delete(from);
              return next;
            });
          }
        });

        // ISSUE #10 — Join-lock state pushed by server to all members
        socket.on('room:join_lock_changed', (evt: { roomId: string; joinLocked: boolean }) => {
          if (evt.roomId === roomId && active) {
            setJoinLocked(evt.joinLocked);
          }
        });

        // Key delivered to current user by owner
        socket.on('room:key_delivered', (evt: any) => {
          if (evt.roomId === roomId && active) {
            syncRoomKey();
          }
        });

        // User's join request accepted
        socket.on('room:join_accepted', (evt: any) => {
          if (evt.roomId === roomId && active) {
            syncRoomKey();
          }
        });

      } catch {
        // Socket connection failed
      }
    }

    setupSocket();

    return () => {
      active = false;
      // Clean up typing timers on unmount
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
    };
  }, [roomId, showRoomInfoModal, memberPage]);

  // Handle Accept Join Request
  async function handleAccept(requestId: string, requesterIdentityDhPublic: string | null) {
    if (processingRequestId) return;
    setProcessingRequestId(requestId);
    setAcceptingStatus('Authorizing member...');

    try {
      let currentKey = roomKeyRef.current;
      if (!currentKey) {
        currentKey = generateRoomKey();
        await saveRoomKey(roomId, room?.keyEpoch ?? 1, currentKey);
        setRoomKey(currentKey);
      }

      let encryptedKey: string | undefined;
      let nonce: string | undefined;

      if (requesterIdentityDhPublic) {
        const identity = await idbGet<DeviceIdentity>('crypto:identity');
        if (identity) {
          const encrypted = await encryptRoomKeyForRecipient(
            currentKey,
            requesterIdentityDhPublic,
            identity._private.identityDhKeyPair.privateKey,
          );
          encryptedKey = encrypted.encryptedKey;
          nonce = encrypted.nonce;
        }
      }

      await api(`/api/rooms/${roomId}/requests/${requestId}/accept`, {
        method: 'POST',
        body: {
          encryptedKey,
          nonce,
        },
      });

      const currentReq = pendingRequests.find((r) => r.id === requestId);
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
      setAcceptingStatus(`@${currentReq?.requester.username ?? 'user'} joined the room`);
      setTimeout(() => setAcceptingStatus(null), 2500);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not accept request.');
      setAcceptingStatus(null);
    } finally {
      setProcessingRequestId(null);
    }
  }

  // Handle Reject Join Request
  async function handleReject(requestId: string) {
    if (processingRequestId) return;
    setProcessingRequestId(requestId);
    try {
      await api(`/api/rooms/${roomId}/requests/${requestId}/reject`, { method: 'POST' });
      setPendingRequests((prev) => prev.filter((r) => r.id !== requestId));
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not reject request.');
    } finally {
      setProcessingRequestId(null);
    }
  }

  // Send Message
  async function handleSendMessage(e: React.FormEvent) {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || sending || !roomKey || !room) return;

    setSending(true);
    const clientMessageId = 'room-msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);

    try {
      const aad = new TextEncoder().encode(`${roomId}:${clientMessageId}`);
      const encrypted = await encryptRoomMessage(roomKey, text, aad);

      const optimisticMsg: DisplayMessage = {
        id: clientMessageId,
        roomId,
        sender: { id: userId ?? '', username: 'you', displayName: null },
        sequenceNumber: messages.length + 1,
        clientMessageId,
        plaintext: text,
        messageType: 'TEXT',
        sentAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimisticMsg]);
      setInputText('');

      await api(`/api/rooms/${roomId}/messages`, {
        method: 'POST',
        body: {
          clientMessageId,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          keyEpoch: room.keyEpoch,
          messageType: 'TEXT',
        },
      });
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not send room message.');
    } finally {
      setSending(false);
    }
  }

  async function handleCopyCode() {
    if (!room?.code) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {}
  }

  // Themed Leave Room Execution
  async function executeLeaveRoom() {
    try {
      await api(`/api/rooms/${roomId}/leave`, { method: 'POST' });
      router.push('/chat');
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not leave room.');
    } finally {
      setConfirmModal(null);
    }
  }

  // Themed Delete Room Execution (Issue #11 — uses dedicated Burn Password)
  async function executeDeleteRoom() {
    setIsDeleting(true);
    setDeletePasswordError(null);
    setBurnSetupError(null);

    let passwordToSend = deletePassword.trim();

    // First-time setup flow: if Burn Password is not configured, set it first
    if (!hasBurnPassword) {
      if (burnSetupNewPassword.length < 4) {
        setIsDeleting(false);
        setBurnSetupError('Burn Password must be at least 4 characters.');
        return;
      }
      if (burnSetupNewPassword !== burnSetupConfirmPassword) {
        setIsDeleting(false);
        setBurnSetupError('Passwords do not match.');
        return;
      }
      try {
        await api('/api/settings/feature-passwords/set', {
          method: 'POST',
          body: { feature: 'burn', newPassword: burnSetupNewPassword },
        });
        setHasBurnPassword(true);
        passwordToSend = burnSetupNewPassword;
      } catch (e: any) {
        setIsDeleting(false);
        setBurnSetupError(e?.message || 'Could not configure Burn Password.');
        return;
      }
    }

    try {
      await api(`/api/rooms/${roomId}`, {
        method: 'DELETE',
        body: { password: passwordToSend || undefined },
      });
      setIsDeleting(false);
      setConfirmModal(null);
      router.push('/chat');
    } catch (e) {
      setIsDeleting(false);
      setDeletePasswordError(e instanceof ApiError ? e.message : 'Could not delete room. Check your Burn Password.');
    }
  }

  // Themed Remove Member Execution
  async function executeRemoveMember() {
    if (!confirmModal?.targetMember) return;
    const targetUserId = confirmModal.targetMember.userId;
    setRemovingMemberId(targetUserId);

    try {
      const res = await api<{ success: boolean; newKeyEpoch: number }>(`/api/rooms/${roomId}/members/${targetUserId}`, {
        method: 'DELETE',
      });

      // Owner key rotation: generate key for new key epoch and save locally
      const rotatedKey = generateRoomKey();
      await saveRoomKey(roomId, res.newKeyEpoch, rotatedKey);
      setRoomKey(rotatedKey);
      setRoom((prev) => (prev ? { ...prev, keyEpoch: res.newKeyEpoch } : prev));

      // Refresh members
      fetchMembers(memberPage);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not remove member.');
    } finally {
      setRemovingMemberId(null);
      setConfirmModal(null);
    }
  }

  // Save Owner Room Settings (up to 2000 capacity)
  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsSuccessMessage(null);
    setActionError(null);

    const parsedCap = parseInt(editCustomMaxMembers, 10);
    if (isNaN(parsedCap) || parsedCap < 2 || parsedCap > 2000) {
      setActionError('Maximum members must be between 2 and 2,000.');
      setSavingSettings(false);
      return;
    }

    try {
      const updated = await api<{ id: string; name: string; maxMembers: number; joinPolicy: 'OPEN' | 'APPROVAL_REQUIRED' }>(
        `/api/rooms/${roomId}`,
        {
          method: 'PATCH',
          body: {
            name: editRoomName.trim(),
            maxMembers: parsedCap,
            joinPolicy: editJoinPolicy,
          },
        },
      );

      setRoom((prev) =>
        prev
          ? {
              ...prev,
              name: updated.name,
              maxMembers: updated.maxMembers,
              joinPolicy: updated.joinPolicy,
            }
          : prev,
      );

      setSettingsSuccessMessage('Room settings updated successfully!');
      setTimeout(() => setSettingsSuccessMessage(null), 3000);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not update room settings.');
    } finally {
      setSavingSettings(false);
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
      <AppHeader activeTab="Chat" showBack backHref="/chat" />

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Left: Desktop Sidebar */}
        <aside className="hidden md:flex w-80 lg:w-96 shrink-0 h-full border-r border-glass-border/40 flex-col bg-surface">
          <ConversationSidebar activeRoomId={roomId} />
        </aside>

        {/* Right: Room Area */}
        <section aria-label="Room chat area" className="flex flex-1 flex-col h-full overflow-hidden bg-surface-2/20">
          {/* Header */}
          <div className="glass px-3 sm:px-4 py-2.5 shrink-0 flex items-center justify-between border-b border-glass-border/40">
            <div
              className="flex items-center gap-2.5 sm:gap-3 min-w-0 cursor-pointer p-1 -ml-1 rounded-xl hover:bg-surface-2/60 transition-colors"
              onClick={() => setShowRoomInfoModal(true)}
              role="button"
              tabIndex={0}
              title="Click to view room details, members, and settings"
            >
              <Link
                href="/chat"
                className="text-ink-dim hover:text-ink p-1 -ml-1 shrink-0"
                onClick={(e) => e.stopPropagation()}
                title="Back to Chats"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </Link>
              <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-info/10 text-info flex items-center justify-center shrink-0 border border-info/20 shadow-sm font-bold text-sm">
                #
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <h1 className="font-bold text-sm sm:text-base text-ink truncate leading-tight">#{room.name}</h1>
                  <span className="px-1.5 sm:px-2 py-0.5 rounded-full bg-surface-2 text-[10px] font-bold text-ink-dim border border-glass-border/40 shrink-0">
                    {room.memberCount}/{room.maxMembers}
                  </span>
                  {joinLocked && (
                    <span className="px-1.5 py-0.5 rounded-full bg-accent-warning/15 text-accent-warning text-[10px] font-bold border border-accent-warning/30 flex items-center gap-1 shrink-0" title="New joins locked">
                      <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.5}><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                      <span className="hidden xs:inline">Locked</span>
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-dim truncate leading-tight mt-0.5">
                  Tap for room details & members
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Single Room Details / Settings Button */}
              <button
                type="button"
                onClick={() => setShowRoomInfoModal(true)}
                className="p-2 text-ink-dim hover:text-ink rounded-lg bg-surface-2/60 hover:bg-surface-2 border border-glass-border/40 transition-colors"
                title="Room Details, Members & Settings"
                aria-label="Room Details, Members & Settings"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="16" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
              </button>
            </div>
          </div>

          {actionError && (
            <div className="mx-4 mt-2 p-2.5 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger flex items-center justify-between">
              <span>{actionError}</span>
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="opacity-75 hover:opacity-100"
                aria-label="Dismiss error"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
          )}

          {/* TOP OWNER REQUEST QUEUE CARD */}
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
                      +{pendingRequests.length - 1} more
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
                    onCopy={(e) => e.preventDefault()}
                    className={`max-w-[80%] sm:max-w-md px-3.5 py-2 rounded-2xl text-xs sm:text-sm shadow-sm break-words select-none msg-no-select ${
                      isMe
                        ? 'bg-info text-white rounded-br-none'
                        : 'glass text-ink rounded-bl-none border border-glass-border/40'
                    }`}
                  >
                    {m.decryptFailed ? (
                      <span className="italic opacity-70 flex items-center gap-1.5">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                        <span>Encrypted group message</span>
                      </span>
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

          {/* ISSUE #8: Group typing indicator pinned immediately above composer */}
          {typingUsers.size > 0 && (
            <div className="px-4 py-1.5 shrink-0 flex items-center gap-2 text-xs text-ink-dim animate-in fade-in duration-150">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-info animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-info animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-info animate-bounce" />
              </div>
              <span className="truncate font-medium">
                {typingUsers.size === 1
                  ? `${Array.from(typingUsers.values())[0]} is typing…`
                  : typingUsers.size === 2
                  ? `${Array.from(typingUsers.values())[0]} and ${Array.from(typingUsers.values())[1]} are typing…`
                  : `${typingUsers.size} people are typing…`}
              </span>
            </div>
          )}

          {/* Key Synchronization Status Banner */}
          {(!roomKey || keySyncError) && (
            <div className="mx-3 sm:mx-4 mb-2 p-2.5 rounded-xl bg-accent-warning/10 border border-accent-warning/25 flex items-center justify-between gap-2 text-xs shrink-0">
              <div className="flex items-center gap-2 text-accent-warning min-w-0">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span className="truncate">
                  {keySyncError || (isSyncingKey ? 'Synchronizing room encryption key…' : 'Waiting for room encryption key')}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                disabled={isSyncingKey}
                onClick={() => syncRoomKey()}
                className="!px-2.5 !py-1 text-xs font-semibold text-info hover:bg-info/10 shrink-0"
              >
                {isSyncingKey ? 'Syncing…' : 'Retry'}
              </Button>
            </div>
          )}

          {/* Room Chat Composer */}
          <div className="border-t border-glass-border/40 p-2.5 sm:p-4 bg-surface shrink-0">
            <form onSubmit={handleSendMessage} className="mx-auto w-full max-w-3xl flex items-center gap-2.5">
              <NeoSurface variant="pressed" className="flex-1 px-1">
                <input
                  value={inputText}
                  onChange={(e) => handleInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage(e);
                    }
                  }}
                  placeholder={
                    isSyncingKey
                      ? 'Synchronizing room key…'
                      : !roomKey
                      ? 'Room key required to send messages'
                      : `Message #${room.name}`
                  }
                  aria-label="Room message text"
                  disabled={sending || !roomKey}
                  className="w-full bg-transparent px-3 py-2.5 sm:py-3 text-sm text-ink placeholder:text-ink-dim focus:outline-none disabled:opacity-50"
                />
              </NeoSurface>
              <Button
                type="submit"
                variant="glass"
                size="icon"
                accent="info"
                aria-label="Send message"
                disabled={sending || !inputText.trim() || !roomKey}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 h-[17px] w-[17px]" aria-hidden="true">
                  <path d="M3 11.5L21 3l-8.5 18-2.5-7.5L3 11.5z" />
                </svg>
              </Button>
            </form>
          </div>
        </section>
      </div>

      {/* Room Profile / Info Modal */}
      {showRoomInfoModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <NeoSurface variant="raised" className="w-full max-w-lg p-5 space-y-4 rounded-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-info/10 text-info flex items-center justify-center border border-info/20 shadow-sm">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div>
                  <h2 className="font-bold text-sm sm:text-base text-ink">#{room.name}</h2>
                  <p className="text-[11px] text-ink-dim">
                    {room.memberCount} of {room.maxMembers} members (Capacity: up to 2,000)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowRoomInfoModal(false);
                  setMemberSearchQuery('');
                  setMemberSearchResults([]);
                  setMemberSearchError(null);
                  setMemberAddSuccess(null);
                }}
                className="p-1 rounded-lg text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Room Join Code Display */}
            {room.code && (
              <div className="p-3 bg-surface-2/60 rounded-xl flex items-center justify-between border border-glass-border/40 shrink-0">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-ink-dim">Room Code</div>
                  <div className="font-mono text-sm font-bold text-ink">{room.code}</div>
                </div>
                <Button
                  variant="glass"
                  accent="info"
                  className="!px-3 !py-1 text-xs"
                  onClick={handleCopyCode}
                >
                  {copiedCode ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}

            {/* Tabs for Room Profile: Members vs Settings (Settings only for Owner) */}
            <div className="flex border-b border-glass-border/40 shrink-0">
              <button
                type="button"
                onClick={() => setRoomInfoTab('members')}
                className={`flex-1 py-2 text-xs font-bold border-b-2 transition-all ${
                  roomInfoTab === 'members'
                    ? 'border-info text-info'
                    : 'border-transparent text-ink-dim hover:text-ink'
                }`}
              >
                Members ({room.memberCount})
              </button>
              {room.role === 'OWNER' && (
                <button
                  type="button"
                  onClick={() => setRoomInfoTab('settings')}
                  className={`flex-1 py-2 text-xs font-bold border-b-2 transition-all ${
                    roomInfoTab === 'settings'
                      ? 'border-info text-info'
                      : 'border-transparent text-ink-dim hover:text-ink'
                  }`}
                >
                  Owner Settings
                </button>
              )}
            </div>

            {/* Tab 1: Paginated Members List */}
            {roomInfoTab === 'members' && (
              <div className="flex-1 flex flex-col min-h-0 space-y-3">
                {/* Room Owner Member Search & Add */}
                {room.role === 'OWNER' && (
                  <div className="space-y-2 shrink-0 bg-surface-2/40 p-2.5 rounded-xl border border-glass-border/30">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-ink-dim">
                        Add Members
                      </span>
                      {isSearchingMembers && (
                        <span className="text-[10px] text-info animate-pulse">Searching…</span>
                      )}
                    </div>

                    <div className="relative flex items-center">
                      <input
                        type="text"
                        value={memberSearchQuery}
                        onChange={(e) => setMemberSearchQuery(e.target.value)}
                        placeholder="Search username or name to add…"
                        className="w-full bg-surface-2 text-xs text-ink rounded-lg pl-8 pr-8 py-2 border border-glass-border/40 focus:outline-none focus:ring-1 focus:ring-info/60 placeholder:text-ink-dim"
                      />
                      <svg
                        className="absolute left-2.5 w-3.5 h-3.5 text-ink-dim pointer-events-none"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      {memberSearchQuery && (
                        <button
                          type="button"
                          onClick={() => {
                            setMemberSearchQuery('');
                            setMemberSearchResults([]);
                            setMemberSearchError(null);
                          }}
                          className="absolute right-2 text-ink-dim hover:text-ink p-1 rounded transition-colors"
                          title="Clear search"
                        >
                          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </div>

                    {/* Status feedback alerts */}
                    {memberSearchError && (
                      <div className="text-[11px] text-danger bg-danger/10 px-2.5 py-1.5 rounded-lg border border-danger/20">
                        {memberSearchError}
                      </div>
                    )}
                    {memberAddSuccess && (
                      <div className="text-[11px] text-accent bg-accent/15 px-2.5 py-1.5 rounded-lg border border-accent/30 font-medium">
                        {memberAddSuccess}
                      </div>
                    )}

                    {/* Search Candidate Results List */}
                    {memberSearchQuery.trim().length >= 2 && (
                      <div className="max-h-40 overflow-y-auto space-y-1 pt-1 divide-y divide-glass-border/20 border-t border-glass-border/30">
                        {!isSearchingMembers && memberSearchResults.length === 0 && (
                          <div className="py-2 text-center text-[11px] text-ink-dim">
                            No matching users found
                          </div>
                        )}
                        {memberSearchResults.map((candidate) => (
                          <div
                            key={candidate.id}
                            className="pt-1.5 pb-1 flex items-center justify-between text-xs"
                          >
                            <div className="flex items-center gap-2 min-w-0 pr-2">
                              <div className="w-6 h-6 rounded-full bg-info/10 text-info font-bold text-[9px] flex items-center justify-center shrink-0 border border-info/20">
                                {candidate.username.slice(0, 2).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <div className="font-semibold text-ink truncate text-[11px]">
                                  @{candidate.username}
                                </div>
                                {candidate.displayName && (
                                  <div className="text-[10px] text-ink-dim truncate">
                                    {candidate.displayName}
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="shrink-0">
                              {candidate.isMember ? (
                                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-surface-2 text-ink-dim border border-glass-border/40">
                                  Already a member
                                </span>
                              ) : (
                                <Button
                                  type="button"
                                  variant="glass"
                                  accent="info"
                                  className="!px-2.5 !py-1 text-[11px] min-h-[32px] sm:min-h-0"
                                  disabled={addingMemberId === candidate.id}
                                  onClick={() => handleAddMember(candidate)}
                                >
                                  {addingMemberId === candidate.id ? 'Adding…' : '+ Add'}
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="flex-1 overflow-y-auto space-y-1.5 pr-1 divide-y divide-glass-border/20">
                  {loadingMembers && !paginatedMembers && (
                    <div className="py-8 text-center text-xs text-ink-dim">Loading members...</div>
                  )}

                  {paginatedMembers?.members.map((m) => {
                    const isOwner = m.role === 'OWNER';
                    const isMe = m.userId === userId;

                    return (
                      <div key={m.id} className="pt-2 pb-1 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-info/10 text-info font-bold text-[10px] flex items-center justify-center shrink-0 border border-info/20">
                            {m.username.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-ink truncate flex items-center gap-1.5">
                              <span>@{m.username}</span>
                              {isMe && <span className="text-[10px] text-ink-dim font-normal">(you)</span>}
                            </div>
                            {m.displayName && <div className="text-[10px] text-ink-dim truncate">{m.displayName}</div>}
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                              isOwner
                                ? 'bg-accent/15 text-accent border-accent/30'
                                : 'bg-surface-2 text-ink-dim border-glass-border/40'
                            }`}
                          >
                            {m.role}
                          </span>

                          {room.role === 'OWNER' && !isOwner && !isMe && (
                            <button
                              type="button"
                              onClick={() => setConfirmModal({ type: 'remove_member', targetMember: m })}
                              disabled={removingMemberId === m.userId}
                              className="text-[11px] text-danger hover:underline px-1.5 py-0.5 rounded"
                              title="Remove member from room"
                            >
                              {removingMemberId === m.userId ? 'Removing...' : 'Remove'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Pagination Controls */}
                {paginatedMembers && paginatedMembers.totalPages > 1 && (
                  <div className="flex items-center justify-between pt-2 border-t border-glass-border/40 text-xs shrink-0">
                    <span className="text-ink-dim text-[11px]">
                      Page {paginatedMembers.page} of {paginatedMembers.totalPages} ({paginatedMembers.total} total)
                    </span>
                    <div className="flex gap-1.5">
                      <Button
                        variant="ghost"
                        className="!px-2.5 !py-1 text-xs"
                        disabled={paginatedMembers.page <= 1 || loadingMembers}
                        onClick={() => fetchMembers(paginatedMembers.page - 1)}
                      >
                        Previous
                      </Button>
                      <Button
                        variant="ghost"
                        className="!px-2.5 !py-1 text-xs"
                        disabled={paginatedMembers.page >= paginatedMembers.totalPages || loadingMembers}
                        onClick={() => fetchMembers(paginatedMembers.page + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}

                {/* Leave Room (Non-owner) */}
                {room.role !== 'OWNER' && (
                  <div className="pt-2 border-t border-glass-border/40 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      accent="danger"
                      className="w-full text-xs font-semibold py-2 rounded-xl"
                      onClick={() => {
                        setShowRoomInfoModal(false);
                        setConfirmModal({ type: 'leave' });
                      }}
                    >
                      Leave Room
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Tab 2: Owner Settings */}
            {roomInfoTab === 'settings' && room.role === 'OWNER' && (
              <form onSubmit={handleSaveSettings} className="flex-1 overflow-y-auto space-y-4 pr-1">
                {settingsSuccessMessage && (
                  <div className="p-2.5 rounded-xl bg-accent/15 border border-accent/30 text-xs font-semibold text-accent">
                    {settingsSuccessMessage}
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-ink">Room Name</label>
                  <input
                    type="text"
                    value={editRoomName}
                    onChange={(e) => setEditRoomName(e.target.value)}
                    maxLength={50}
                    required
                    className="w-full bg-surface-2 text-xs text-ink rounded-xl px-3 py-2 border border-glass-border/40 focus:outline-none focus:ring-1 focus:ring-info/60"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <label className="font-semibold text-ink">Capacity Limit (2 – 2,000)</label>
                    <span className="text-ink-dim font-bold">{editCustomMaxMembers} members</span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {ROOM_CAPACITY_PRESETS.map((cap) => (
                      <button
                        type="button"
                        key={cap}
                        onClick={() => {
                          setEditMaxMembers(cap);
                          setEditCustomMaxMembers(String(cap));
                        }}
                        className={`rounded-xl px-2.5 py-1 text-xs font-semibold transition-all ${
                          editCustomMaxMembers === String(cap)
                            ? 'neo-pressed text-info font-bold shadow-inner'
                            : 'neo-raised text-ink-dim hover:text-ink'
                        }`}
                      >
                        {cap}
                      </button>
                    ))}
                  </div>

                  <div className="pt-1 flex items-center gap-2">
                    <span className="text-xs text-ink-dim shrink-0">Custom limit:</span>
                    <input
                      type="number"
                      min={room.memberCount}
                      max={2000}
                      value={editCustomMaxMembers}
                      onChange={(e) => setEditCustomMaxMembers(e.target.value)}
                      className="neo-pressed w-24 text-xs font-bold text-ink rounded-xl px-2.5 py-1 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                    />
                    <span className="text-[11px] text-ink-dim">Current: {room.memberCount}</span>
                  </div>
                </div>

                <div className="space-y-2 pt-1">
                  <label className="text-xs font-semibold text-ink">Join Policy</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setEditJoinPolicy('OPEN')}
                      className={`p-2.5 rounded-xl text-left transition-all flex flex-col gap-0.5 ${
                        editJoinPolicy === 'OPEN'
                          ? 'neo-pressed border border-info/40 bg-info/5'
                          : 'neo-raised hover:opacity-90'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${editJoinPolicy === 'OPEN' ? 'border-info' : 'border-ink-dim/40'}`}>
                          {editJoinPolicy === 'OPEN' && <div className="w-1.5 h-1.5 rounded-full bg-info" />}
                        </div>
                        <span className="font-semibold text-ink">Open Join</span>
                      </div>
                      <span className="text-[10px] text-ink-dim">Immediate access with code</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setEditJoinPolicy('APPROVAL_REQUIRED')}
                      className={`p-2.5 rounded-xl text-left transition-all flex flex-col gap-0.5 ${
                        editJoinPolicy === 'APPROVAL_REQUIRED'
                          ? 'neo-pressed border border-info/40 bg-info/5'
                          : 'neo-raised hover:opacity-90'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${editJoinPolicy === 'APPROVAL_REQUIRED' ? 'border-info' : 'border-ink-dim/40'}`}>
                          {editJoinPolicy === 'APPROVAL_REQUIRED' && <div className="w-1.5 h-1.5 rounded-full bg-info" />}
                        </div>
                        <span className="font-semibold text-ink">Approval Required</span>
                      </div>
                      <span className="text-[10px] text-ink-dim">Owner approval needed</span>
                    </button>
                  </div>
                </div>

                {/* Stop New Joins Toggle */}
                <div className="border-t border-glass-border/40 pt-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-ink">Room Join Lock</div>
                      <div className="text-[11px] text-ink-dim">
                        {joinLocked ? 'New users cannot join via room code' : 'Anyone with code can join or request'}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="raised"
                      disabled={lockingJoin}
                      onClick={handleToggleJoinLock}
                      className={`!px-3 !py-1.5 text-xs font-semibold ${
                        joinLocked
                          ? 'bg-accent-warning/20 text-accent-warning border border-accent-warning/40'
                          : ''
                      }`}
                    >
                      {joinLocked ? 'Unlock Joins' : 'Stop Joins'}
                    </Button>
                  </div>
                </div>

                <Button
                  type="submit"
                  variant="raised"
                  accent="info"
                  disabled={savingSettings || !editRoomName.trim()}
                  className="w-full text-xs font-bold mt-2"
                >
                  {savingSettings ? 'Saving...' : 'Save Room Settings'}
                </Button>

                {/* Close & Delete Room (Owner) */}
                <div className="border-t border-glass-border/40 pt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    accent="danger"
                    className="w-full text-xs font-semibold py-2 rounded-xl"
                    onClick={() => {
                      setShowRoomInfoModal(false);
                      setDeletePassword('');
                      setDeletePasswordError(null);
                      setConfirmModal({ type: 'delete' });
                    }}
                  >
                    Close & Delete Room
                  </Button>
                </div>
              </form>
            )}
          </NeoSurface>
        </div>
      )}

      {/* Themed Confirmation Modal for Leave / Close / Remove Member */}
      {confirmModal && (
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
                  {confirmModal.type === 'delete' && 'Close & Delete Room?'}
                  {confirmModal.type === 'leave' && 'Leave Room?'}
                  {confirmModal.type === 'remove_member' && `Remove @${confirmModal.targetMember?.username}?`}
                </h3>
                <p className="text-xs text-ink-dim mt-0.5">
                  {confirmModal.type === 'delete' &&
                    'This permanently destroys the room, keys, and message history for all members. This cannot be undone.'}
                  {confirmModal.type === 'leave' &&
                    `You will leave #${room.name}. You will need a new invite or code to rejoin.`}
                  {confirmModal.type === 'remove_member' &&
                    'This member will be removed from the room, and the cryptographic room key will be automatically rotated.'}
                </p>
              </div>
            </div>

            {confirmModal.type === 'delete' && !hasBurnPassword && (
              <div className="flex flex-col gap-2 py-1">
                <div className="text-[11.5px] text-accent-warning font-semibold bg-accent-warning/10 p-2.5 rounded-xl border border-accent-warning/25">
                  Burn Password is not configured yet. Create a Burn Password to authorize destroying this room.
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

            {confirmModal.type === 'delete' && hasBurnPassword && (
              <div className="flex flex-col gap-1.5 py-1">
                <label className="text-[11px] font-semibold text-ink-dim">
                  Enter Burn Password to authorize:
                </label>
                <NeoInput
                  type="password"
                  placeholder="Burn Password"
                  value={deletePassword}
                  onChange={(e) => {
                    setDeletePassword(e.target.value);
                    setDeletePasswordError(null);
                  }}
                  className="text-xs"
                  autoFocus
                />
                {deletePasswordError && (
                  <span className="text-[11px] text-danger font-medium mt-0.5">{deletePasswordError}</span>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button
                variant="ghost"
                className="flex-1 text-xs"
                disabled={isDeleting}
                onClick={() => {
                  setConfirmModal(null);
                  setDeletePassword('');
                  setDeletePasswordError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="raised"
                accent="danger"
                className="flex-1 text-xs font-bold"
                disabled={isDeleting}
                onClick={() => {
                  if (confirmModal.type === 'delete') {
                    executeDeleteRoom();
                  } else if (confirmModal.type === 'leave') {
                    executeLeaveRoom();
                  } else if (confirmModal.type === 'remove_member') {
                    executeRemoveMember();
                  }
                }}
              >
                {isDeleting
                  ? 'Closing…'
                  : confirmModal.type === 'delete'
                  ? 'Close Room'
                  : confirmModal.type === 'leave'
                  ? 'Leave'
                  : 'Remove'}
              </Button>
            </div>
          </NeoSurface>
        </div>
      )}

      {/* Themed Room Closed / Removed Banner Modal */}
      {roomClosedBanner && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-150"
        >
          <NeoSurface variant="raised" className="w-full max-w-sm p-6 flex flex-col items-center gap-4 bg-surface text-center shadow-2xl">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/15 text-danger">
              <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            </div>
            <div>
              <h3 className="text-base font-bold text-ink">Room Notice</h3>
              <p className="mt-1 text-xs text-ink-dim">{roomClosedBanner}</p>
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
    </div>
  );
}
