'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { TabBar } from '@/components/chat/TabBar';
import { AppHeader } from '@/components/navigation/AppHeader';
import { NeoSurface } from '@/components/ui/NeoSurface';
import { NeoInput } from '@/components/ui/NeoInput';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { idbGet } from '@/lib/storage/localDb';
import { initiateHandshake, DeviceIdentity, PublicKeyBundle } from '@/lib/crypto/engine';
import { initSession } from '@/lib/crypto/sessionStore';
import { normalizeUsername, validateUsername } from '@/lib/username';
import { connectSocket } from '@/lib/realtime/socket';
import { generateRoomKey, encryptOpenRoomKey } from '@/lib/crypto/roomCrypto';
import { saveRoomKey } from '@/lib/storage/roomStorage';
import { TEMPORARY_DURATIONS } from '@/lib/pairing/durations';
import { CustomDurationPicker } from '@/components/pairing/CustomDurationPicker';

const ROOM_CAPACITY_PRESETS = [10, 25, 50, 100, 250, 500, 1000, 1500, 2000];

interface FoundUser {
  id?: string;
  username: string;
  displayName: string | null;
}

interface SearchResponse {
  user: FoundUser | null;
  isSelf?: boolean;
}

interface IncomingRequest {
  id: string;
  senderId: string;
  createdAt: string;
  sender: {
    id: string;
    username: string;
    displayName: string | null;
  };
}

export default function ConnectPage() {
  const { userId } = useAuth();
  const router = useRouter();

  // Top-level tab: 'person' (1-on-1) vs 'room' (Group Chat Room)
  const [connectTab, setConnectTab] = useState<'person' | 'room'>('person');

  // Dedicated surface action modal: 'none' | 'enter' | 'create_temp' | 'username'
  const [personAction, setPersonAction] = useState<'none' | 'enter' | 'create_temp' | 'username'>('none');
  const [foreverCode, setForeverCode] = useState<string | null>(null);
  const [loadingForeverCode, setLoadingForeverCode] = useState(true);
  const [foreverCodeAction, setForeverCodeAction] = useState<'creating' | 'deleting' | null>(null);
  const [foreverCodeError, setForeverCodeError] = useState<string | null>(null);
  const [copiedForeverCode, setCopiedForeverCode] = useState(false);
  const [connectSuccessMessage, setConnectSuccessMessage] = useState<string | null>(null);

  // Incoming Conversation Requests
  const [incomingRequests, setIncomingRequests] = useState<IncomingRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);

  // --- Room state ---
  const [roomSubTab, setRoomSubTab] = useState<'create' | 'join'>('create');
  const [roomName, setRoomName] = useState('');
  const [roomMaxMembers, setRoomMaxMembers] = useState(50);
  const [customMaxMembersInput, setCustomMaxMembersInput] = useState('50');
  const [roomJoinPolicy, setRoomJoinPolicy] = useState<'OPEN' | 'APPROVAL_REQUIRED'>('APPROVAL_REQUIRED');
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [createRoomError, setCreateRoomError] = useState<string | null>(null);
  const [createdRoomInfo, setCreatedRoomInfo] = useState<{ id: string; name: string; code: string; maxMembers: number } | null>(null);
  const [copiedCreatedRoomCode, setCopiedCreatedRoomCode] = useState(false);

  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [joiningRoom, setJoiningRoom] = useState(false);
  const [joinRoomError, setJoinRoomError] = useState<string | null>(null);
  const [waitingRoomState, setWaitingRoomState] = useState<{ roomId: string; roomName: string } | null>(null);
  const [joinAcceptedBanner, setJoinAcceptedBanner] = useState<string | null>(null);

  // Keyboard accessibility: Escape closes any open modal
  useEffect(() => {
    if (personAction === 'none') return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPersonAction('none');
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [personAction]);

  // Load Forever Code
  useEffect(() => {
    let mounted = true;
    api<{ code: string | null }>('/api/pairing/forever')
      .then((res) => {
        if (mounted) setForeverCode(res.code);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setLoadingForeverCode(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Fetch Incoming Conversation Requests
  const fetchIncomingRequests = () => {
    setLoadingRequests(true);
    api<IncomingRequest[]>('/api/conversation-requests/incoming')
      .then((res) => {
        if (Array.isArray(res)) setIncomingRequests(res);
      })
      .catch(() => {})
      .finally(() => {
        setLoadingRequests(false);
      });
  };

  useEffect(() => {
    fetchIncomingRequests();
  }, []);

  // Listen for socket events while waiting for room approval
  useEffect(() => {
    if (!waitingRoomState) return;
    let active = true;

    connectSocket().then((socket) => {
      if (!active) return;
      socket.on('room:join_accepted', (evt: any) => {
        if (evt.roomId === waitingRoomState.roomId) {
          setJoinAcceptedBanner(`Joined ${evt.roomName}! Entering room...`);
          setTimeout(() => {
            router.push(`/chat/room/${evt.roomId}`);
          }, 1000);
        }
      });
      socket.on('room:join_rejected', (evt: any) => {
        if (evt.roomId === waitingRoomState.roomId) {
          setJoinRoomError(`Your request to join ${evt.roomName} was declined.`);
          setWaitingRoomState(null);
        }
      });
    }).catch(() => {});

    return () => {
      active = false;
    };
  }, [waitingRoomState, router]);

  async function handleCreateForeverCode() {
    setForeverCodeError(null);
    setForeverCodeAction('creating');
    try {
      const res = await api<{ code: string }>('/api/pairing/forever', { method: 'POST' });
      setForeverCode(res.code);
    } catch (e) {
      setForeverCodeError(e instanceof ApiError ? e.message : 'Could not create Forever Code.');
    } finally {
      setForeverCodeAction(null);
    }
  }

  async function handleDeleteForeverCode() {
    setForeverCodeError(null);
    setForeverCodeAction('deleting');
    try {
      await api('/api/pairing/forever', { method: 'DELETE' });
      setForeverCode(null);
    } catch (e) {
      setForeverCodeError(e instanceof ApiError ? e.message : 'Could not delete Forever Code.');
    } finally {
      setForeverCodeAction(null);
    }
  }

  async function handleCopyForeverCode() {
    if (!foreverCode) return;
    try {
      await navigator.clipboard.writeText(foreverCode);
      setCopiedForeverCode(true);
      setTimeout(() => setCopiedForeverCode(false), 2500);
    } catch {}
  }

  // --- Username-search & Request flow ---
  const [usernameQuery, setUsernameQuery] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResponse | 'not-found' | null>(null);
  const [searching, setSearching] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [sendingRequest, setSendingRequest] = useState(false);
  const [usernameRequestError, setUsernameRequestError] = useState<string | null>(null);
  const searchRequestIdRef = useRef(0);

  const normalizedQuery = normalizeUsername(usernameQuery);
  const queryValidation = validateUsername(normalizedQuery);

  useEffect(() => {
    setSearchResult(null);
    setRequestSent(false);
    setUsernameRequestError(null);
    if (!queryValidation.valid) return;
    const thisRequestId = ++searchRequestIdRef.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await api<SearchResponse>(`/api/users/search?username=${encodeURIComponent(normalizedQuery)}`);
        if (searchRequestIdRef.current === thisRequestId) setSearchResult(result.user ? result : 'not-found');
      } catch {
        if (searchRequestIdRef.current === thisRequestId) setSearchResult('not-found');
      } finally {
        if (searchRequestIdRef.current === thisRequestId) setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [normalizedQuery, queryValidation.valid]);

  async function handleSendConversationRequest() {
    if (!searchResult || searchResult === 'not-found' || !searchResult.user) return;
    setSendingRequest(true);
    setUsernameRequestError(null);
    try {
      await api('/api/conversation-requests', {
        method: 'POST',
        body: { recipientUsername: searchResult.user.username },
      });
      setRequestSent(true);
    } catch (e) {
      setUsernameRequestError(e instanceof ApiError ? e.message : 'Could not send conversation request.');
    } finally {
      setSendingRequest(false);
    }
  }

  // Handle Incoming Request Accept / Decline
  async function handleAcceptIncomingRequest(reqId: string) {
    setProcessingRequestId(reqId);
    try {
      const res = await api<{ request: any; conversation: { id: string } }>(`/api/conversation-requests/${reqId}/accept`, {
        method: 'POST',
      });
      if (res.conversation?.id) {
        router.push(`/chat/${res.conversation.id}`);
      } else {
        fetchIncomingRequests();
      }
    } catch {
      fetchIncomingRequests();
    } finally {
      setProcessingRequestId(null);
    }
  }

  async function handleRejectIncomingRequest(reqId: string) {
    setProcessingRequestId(reqId);
    try {
      await api(`/api/conversation-requests/${reqId}/reject`, { method: 'POST' });
      setIncomingRequests((prev) => prev.filter((r) => r.id !== reqId));
    } catch {
      fetchIncomingRequests();
    } finally {
      setProcessingRequestId(null);
    }
  }

  // --- Temporary code flow (15m, 1h, 1d, 7d, 30d, 90d, custom) ---
  const [tempDuration, setTempDuration] = useState<number>(15 * 60);
  const [durationMode, setDurationMode] = useState<'preset' | 'custom'>('preset');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [generatedPairingId, setGeneratedPairingId] = useState<string | null>(null);
  const [createTempError, setCreateTempError] = useState<string | null>(null);
  const [generatingTemp, setGeneratingTemp] = useState(false);
  const [cancellingTemp, setCancellingTemp] = useState(false);
  const [copiedTempCode, setCopiedTempCode] = useState(false);

  function formatCustomDurationLabel(totalSeconds: number): string {
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  // --- Redeem Code Flow ---
  const [digits, setDigits] = useState('');
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  async function handleCreateTempCode() {
    setCreateTempError(null);
    setGeneratingTemp(true);
    try {
      const result = await api<{ pairingId: string; code: string }>('/api/pairing/create', {
        method: 'POST',
        body: { durationSeconds: tempDuration },
      });
      setGeneratedCode(result.code);
      setGeneratedPairingId(result.pairingId);
    } catch (e) {
      setCreateTempError(e instanceof ApiError ? e.message : 'Could not create temporary code. Please try again.');
    } finally {
      setGeneratingTemp(false);
    }
  }

  async function handleCancelTempCode() {
    if (!generatedPairingId) return;
    setCancellingTemp(true);
    try {
      await api(`/api/pairing/${generatedPairingId}`, { method: 'DELETE' });
      setGeneratedCode(null);
      setGeneratedPairingId(null);
    } catch {
      setCreateTempError('Could not cancel code. Please try again.');
    } finally {
      setCancellingTemp(false);
    }
  }

  async function handleCopyTempCode() {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopiedTempCode(true);
      setTimeout(() => setCopiedTempCode(false), 2000);
    } catch {}
  }

  async function handleRedeem() {
    setRedeemError(null);
    setConnectSuccessMessage(null);
    const cleanCode = digits.trim().toUpperCase();
    if (cleanCode.length < 6) {
      setRedeemError('Enter a valid code (at least 6 characters).');
      return;
    }
    setRedeeming(true);
    try {
      const identity = await idbGet<DeviceIdentity>('crypto:identity');
      if (!identity) throw new Error('No local device identity — please sign in again.');

      const result = await api<{
        conversationId: string;
        bundle: PublicKeyBundle;
        sessionEpoch: number;
        otherUser?: { id: string; username: string; displayName?: string | null };
      }>('/api/pairing/redeem', {
        method: 'POST',
        body: { code: cleanCode },
      });

      const { session, message } = await initiateHandshake(identity, result.bundle);
      await api('/api/handshake', {
        method: 'POST',
        body: { conversationId: result.conversationId, handshakeMessage: message, sessionEpoch: result.sessionEpoch },
      });
      await initSession(result.conversationId, session, result.sessionEpoch);

      const username = result.otherUser?.username ? `@${result.otherUser.username}` : 'user';
      setConnectSuccessMessage(`Connected with ${username}!`);
      setTimeout(() => {
        router.push(`/chat/${result.conversationId}`);
      }, 1000);
    } catch (e) {
      setRedeemError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong.');
      setRedeeming(false);
    }
  }

  // --- Room Actions ---
  function handleCapacityPresetSelect(cap: number) {
    setRoomMaxMembers(cap);
    setCustomMaxMembersInput(String(cap));
  }

  function handleCustomCapacityChange(val: string) {
    setCustomMaxMembersInput(val);
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed >= 2 && parsed <= 2000) {
      setRoomMaxMembers(parsed);
    }
  }

  async function handleCreateRoom(e: React.FormEvent) {
    e.preventDefault();
    setCreateRoomError(null);
    const trimmedName = roomName.trim();
    if (trimmedName.length < 2) {
      setCreateRoomError('Room name must be at least 2 characters.');
      return;
    }
    if (trimmedName.length > 50) {
      setCreateRoomError('Room name cannot exceed 50 characters.');
      return;
    }

    const finalCapacity = parseInt(customMaxMembersInput, 10);
    if (isNaN(finalCapacity) || finalCapacity < 2 || finalCapacity > 2000) {
      setCreateRoomError('Maximum members must be between 2 and 2,000.');
      return;
    }

    setCreatingRoom(true);
    try {
      const res = await api<{
        room: { id: string; name: string; maxMembers: number; memberCount: number; joinPolicy: string; code: string };
      }>('/api/rooms', {
        method: 'POST',
        body: {
          name: trimmedName,
          maxMembers: finalCapacity,
          joinPolicy: roomJoinPolicy,
        },
      });

      // Generate local room key and store in IDB
      const rKey = generateRoomKey();
      await saveRoomKey(res.room.id, 1, rKey);

      if (roomJoinPolicy === 'OPEN' && res.room.code) {
        try {
          const { openKeyCiphertext, openKeyNonce } = await encryptOpenRoomKey(rKey, res.room.code);
          await api(`/api/rooms/${res.room.id}`, {
            method: 'PATCH',
            body: { openKeyCiphertext, openKeyNonce },
          });
        } catch {
          // non-critical
        }
      }

      setCreatedRoomInfo({
        id: res.room.id,
        name: res.room.name,
        code: res.room.code,
        maxMembers: res.room.maxMembers,
      });
    } catch (e) {
      setCreateRoomError(e instanceof ApiError ? e.message : 'Could not create room.');
    } finally {
      setCreatingRoom(false);
    }
  }

  async function handleCopyCreatedRoomCode() {
    if (!createdRoomInfo?.code) return;
    try {
      await navigator.clipboard.writeText(createdRoomInfo.code);
      setCopiedCreatedRoomCode(true);
      setTimeout(() => setCopiedCreatedRoomCode(false), 2000);
    } catch {}
  }

  async function handleJoinRoom(e: React.FormEvent) {
    e.preventDefault();
    setJoinRoomError(null);
    setJoinAcceptedBanner(null);
    const cleanCode = roomCodeInput.trim().toUpperCase();
    if (cleanCode.length < 6) {
      setJoinRoomError('Enter a valid room code (at least 6 characters).');
      return;
    }

    setJoiningRoom(true);
    try {
      const res = await api<{
        status: 'JOINED' | 'REQUEST_SENT' | 'ALREADY_MEMBER' | 'PENDING';
        roomId: string;
        roomName?: string;
        message?: string;
      }>('/api/rooms/join', {
        method: 'POST',
        body: { code: cleanCode },
      });

      if (res.status === 'ALREADY_MEMBER' || res.status === 'JOINED') {
        router.push(`/chat/room/${res.roomId}`);
        return;
      }

      if (res.status === 'REQUEST_SENT' || res.status === 'PENDING') {
        setWaitingRoomState({
          roomId: res.roomId,
          roomName: res.roomName ?? 'the room',
        });
      }
    } catch (e) {
      setJoinRoomError(e instanceof ApiError ? e.message : 'Could not join room.');
    } finally {
      setJoiningRoom(false);
    }
  }

  function handleBack() {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/chat');
    }
  }

  const selectedDurationLabel =
    TEMPORARY_DURATIONS.find((d) => d.seconds === tempDuration)?.label ??
    formatCustomDurationLabel(tempDuration);

  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <AppHeader activeTab="Connect" />

      <main className="flex flex-1 flex-col px-4 py-6 pb-24 md:pb-8">
        <div className="mx-auto flex w-full max-w-md md:max-w-lg lg:max-w-xl flex-col gap-5">
          <header className="flex items-center gap-2 px-1 py-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Go back"
              title="Go back"
              onClick={handleBack}
              className="!h-9 !w-9 shrink-0 md:hidden"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Button>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink">Connect</h1>
              <p className="mt-0.5 text-xs text-ink-dim">Start a direct 1-to-1 chat or join a group chat room</p>
            </div>
          </header>

          {/* Segment Selector: Person vs Room */}
          <div className="neo-pressed p-1 rounded-2xl max-w-md mx-auto w-full flex gap-1">
            <button
              type="button"
              onClick={() => { setConnectTab('person'); setPersonAction('none'); }}
              className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${
                connectTab === 'person' ? 'neo-raised text-ink shadow-sm' : 'text-ink-dim hover:text-ink'
              }`}
            >
              Person (1-on-1)
            </button>
            <button
              type="button"
              onClick={() => { setConnectTab('room'); setCreatedRoomInfo(null); setWaitingRoomState(null); }}
              className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${
                connectTab === 'room' ? 'neo-raised text-ink shadow-sm' : 'text-ink-dim hover:text-ink'
              }`}
            >
              Chat Room (Group)
            </button>
          </div>

          {/* ============================================================== */}
          {/* TAB 1: 1-to-1 PERSON CONNECT                                   */}
          {/* ============================================================== */}
          {connectTab === 'person' && (
            <div className="flex flex-col gap-5">
              {/* Incoming Conversation Requests Banner (if any) */}
              {incomingRequests.length > 0 && (
                <NeoSurface variant="raised" className="p-4 border border-info/30 bg-info/5 flex flex-col gap-3 rounded-2xl">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" className="text-info">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                      <span className="text-xs font-bold text-ink">
                        Incoming Requests ({incomingRequests.length})
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {incomingRequests.map((req) => (
                      <div key={req.id} className="p-3 bg-surface rounded-xl flex items-center justify-between border border-glass-border/40">
                        <div className="min-w-0 pr-2">
                          <div className="text-xs font-bold text-ink truncate">@{req.sender.username}</div>
                          {req.sender.displayName && (
                            <div className="text-[11px] text-ink-dim truncate">{req.sender.displayName}</div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant="ghost"
                            className="!px-2.5 !py-1 text-xs"
                            disabled={processingRequestId === req.id}
                            onClick={() => handleRejectIncomingRequest(req.id)}
                          >
                            Decline
                          </Button>
                          <Button
                            variant="glass"
                            accent="info"
                            className="!px-3 !py-1 text-xs font-bold"
                            disabled={processingRequestId === req.id}
                            onClick={() => handleAcceptIncomingRequest(req.id)}
                          >
                            {processingRequestId === req.id ? 'Connecting...' : 'Accept'}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </NeoSurface>
              )}

              {/* Section 1: Dedicated Forever Code */}
              <NeoSurface variant="raised" className="flex flex-col gap-4 p-5 rounded-2xl">
                <div>
                  <h2 className="text-base font-bold text-ink">Your Forever Code</h2>
                  <p className="mt-0.5 text-xs text-ink-dim">
                    This code never changes until you delete it. Share it with friends to connect anytime.
                  </p>
                </div>

                {loadingForeverCode ? (
                  <div className="py-4 text-center text-xs text-ink-dim animate-pulse">Loading your Forever Code…</div>
                ) : foreverCode ? (
                  <div className="flex flex-col gap-3">
                    <div className="neo-pressed flex items-center justify-between rounded-xl px-4 py-3.5">
                      <span className="font-mono text-xl sm:text-2xl font-bold tracking-widest text-ink selection:bg-accent/30">
                        {foreverCode}
                      </span>
                      <Button
                        variant="glass"
                        accent="info"
                        className="!px-3.5 !py-1.5 text-xs font-semibold"
                        onClick={handleCopyForeverCode}
                      >
                        {copiedForeverCode ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <p className="text-xs text-ink-dim">Permanent until you delete it.</p>
                    {foreverCodeError && <div className="text-xs text-danger">{foreverCodeError}</div>}
                    <Button
                      variant="ghost"
                      accent="danger"
                      className="w-full text-xs font-semibold"
                      onClick={handleDeleteForeverCode}
                      disabled={foreverCodeAction === 'deleting'}
                    >
                      {foreverCodeAction === 'deleting' ? 'Deleting…' : 'Delete Forever Code'}
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <p className="text-xs text-ink-dim">
                      You don&apos;t have an active Forever Code. Create one to pair with others without expiration.
                    </p>
                    {foreverCodeError && <div className="text-xs text-danger">{foreverCodeError}</div>}
                    <Button
                      variant="raised"
                      className="w-full font-semibold"
                      onClick={handleCreateForeverCode}
                      disabled={foreverCodeAction === 'creating'}
                    >
                      {foreverCodeAction === 'creating' ? 'Creating…' : 'Create Forever Code'}
                    </Button>
                  </div>
                )}
              </NeoSurface>

              {/* Section 2: Neomorphic Action Buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setRedeemError(null);
                    setConnectSuccessMessage(null);
                    setPersonAction('enter');
                  }}
                  className="neo-raised active:neo-pressed flex flex-col items-center justify-center p-4 rounded-2xl transition-all text-center gap-2 hover:opacity-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info group"
                >
                  <div className="w-10 h-10 rounded-xl bg-info/10 text-info flex items-center justify-center border border-info/20 group-hover:scale-105 transition-transform">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" y1="12" x2="3" y2="12" />
                    </svg>
                  </div>
                  <span className="text-xs font-bold text-ink">Connect with Code</span>
                  <span className="text-[11px] text-ink-dim leading-tight">Enter friend&apos;s code</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setCreateTempError(null);
                    setPersonAction('create_temp');
                  }}
                  className="neo-raised active:neo-pressed flex flex-col items-center justify-center p-4 rounded-2xl transition-all text-center gap-2 hover:opacity-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info group"
                >
                  <div className="w-10 h-10 rounded-xl bg-info/10 text-info flex items-center justify-center border border-info/20 group-hover:scale-105 transition-transform">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                  <span className="text-xs font-bold text-ink">Generate Temporary Code</span>
                  <span className="text-[11px] text-ink-dim leading-tight">15m to 90d duration</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setUsernameRequestError(null);
                    setPersonAction('username');
                  }}
                  className="neo-raised active:neo-pressed flex flex-col items-center justify-center p-4 rounded-2xl transition-all text-center gap-2 hover:opacity-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-info group"
                >
                  <div className="w-10 h-10 rounded-xl bg-info/10 text-info flex items-center justify-center border border-info/20 group-hover:scale-105 transition-transform">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </div>
                  <span className="text-xs font-bold text-ink">Find by Username</span>
                  <span className="text-[11px] text-ink-dim leading-tight">Send chat request</span>
                </button>
              </div>

              {/* Dedicated Themed Surface Modal: Enter Code */}
              {personAction === 'enter' && (
                <div
                  className="fixed inset-0 z-50 flex sm:items-center items-end justify-center p-0 sm:p-4 bg-backdrop/75 backdrop-blur-sm animate-in fade-in duration-200"
                  role="dialog"
                  aria-modal="true"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setPersonAction('none');
                  }}
                >
                  <NeoSurface variant="raised" className="w-full max-w-md rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 flex flex-col gap-4 border border-glass-border/60 bg-surface shadow-2xl max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-base font-bold text-ink">Connect with Code</h2>
                        <p className="mt-0.5 text-xs text-ink-dim">
                          Enter a friend&apos;s Forever Code or temporary pairing code.
                        </p>
                      </div>
                      <Button variant="ghost" size="icon" aria-label="Close dialog" className="!h-8 !w-8" onClick={() => setPersonAction('none')}>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </Button>
                    </div>

                    <div className="flex flex-col gap-3">
                      <input
                        type="text"
                        value={digits}
                        onChange={(e) => setDigits(e.target.value.toUpperCase())}
                        placeholder="ABC123XYZ"
                        maxLength={32}
                        autoCapitalize="characters"
                        autoComplete="off"
                        spellCheck={false}
                        className="neo-pressed w-full rounded-xl py-3.5 px-4 text-center font-mono text-xl sm:text-2xl tracking-widest text-ink placeholder:text-ink-dim/40 placeholder:tracking-normal focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                      />

                      {connectSuccessMessage && (
                        <div role="status" className="flex items-center gap-2 rounded-xl bg-accent/15 border border-accent/30 p-3 text-xs font-semibold text-accent">
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                          <span>{connectSuccessMessage}</span>
                        </div>
                      )}

                      {redeemError && (
                        <div role="alert" className="flex items-center gap-2 rounded-xl bg-danger/15 border border-danger/30 p-3 text-xs font-semibold text-danger">
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" /></svg>
                          <span>{redeemError}</span>
                        </div>
                      )}

                      <div className="flex gap-2.5 pt-2">
                        <Button
                          variant="raised"
                          className="flex-1 font-semibold text-xs"
                          onClick={() => setPersonAction('none')}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="glass"
                          accent="info"
                          className="flex-1 font-bold text-xs"
                          onClick={handleRedeem}
                          disabled={redeeming || !digits.trim()}
                        >
                          {redeeming ? 'Connecting…' : 'Connect'}
                        </Button>
                      </div>
                    </div>
                  </NeoSurface>
                </div>
              )}

              {/* Dedicated Themed Surface Modal: Generate Temporary Code */}
              {personAction === 'create_temp' && (
                <div
                  className="fixed inset-0 z-50 flex sm:items-center items-end justify-center p-0 sm:p-4 bg-backdrop/75 backdrop-blur-sm animate-in fade-in duration-200"
                  role="dialog"
                  aria-modal="true"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setPersonAction('none');
                  }}
                >
                  <NeoSurface variant="raised" className="w-full max-w-md rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 flex flex-col gap-4 border border-glass-border/60 bg-surface shadow-2xl max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-base font-bold text-ink">
                          {generatedCode ? 'Temporary Code Generated' : 'Generate Temporary Code'}
                        </h2>
                        <p className="mt-0.5 text-xs text-ink-dim">
                          {generatedCode
                            ? `Valid for ${selectedDurationLabel}. Single-use pairing code.`
                            : 'Choose an expiration duration to create a one-time pairing code.'}
                        </p>
                      </div>
                      <Button variant="ghost" size="icon" aria-label="Close dialog" className="!h-8 !w-8" onClick={() => setPersonAction('none')}>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </Button>
                    </div>

                    {!generatedCode ? (
                      <div className="flex flex-col gap-4">
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <label className="text-xs font-semibold text-ink">Select Expiry Duration</label>
                            <div className="flex bg-surface-2 p-0.5 rounded-lg border border-glass-border/40 text-[11px] font-semibold">
                              <button
                                type="button"
                                onClick={() => setDurationMode('preset')}
                                className={`px-2.5 py-1 rounded-md transition-all ${
                                  durationMode === 'preset' ? 'neo-raised text-info bg-surface font-bold shadow-sm' : 'text-ink-dim hover:text-ink'
                                }`}
                              >
                                Presets
                              </button>
                              <button
                                type="button"
                                onClick={() => setDurationMode('custom')}
                                className={`px-2.5 py-1 rounded-md transition-all ${
                                  durationMode === 'custom' ? 'neo-raised text-info bg-surface font-bold shadow-sm' : 'text-ink-dim hover:text-ink'
                                }`}
                              >
                                Custom Wheel
                              </button>
                            </div>
                          </div>

                          {durationMode === 'preset' ? (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                              {TEMPORARY_DURATIONS.map((d) => (
                                <button
                                  key={d.label}
                                  type="button"
                                  onClick={() => setTempDuration(d.seconds)}
                                  className={`p-3 rounded-xl text-left transition-all flex flex-col gap-1 ${
                                    tempDuration === d.seconds
                                      ? 'neo-pressed border border-info/50 bg-info/10'
                                      : 'neo-raised hover:opacity-90'
                                  }`}
                                >
                                  <div className={`text-xs font-bold ${tempDuration === d.seconds ? 'text-info' : 'text-ink'}`}>
                                    {d.label}
                                  </div>
                                  <div className="text-[10px] text-ink-dim leading-tight">{d.description}</div>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <CustomDurationPicker
                              valueSeconds={tempDuration}
                              onChange={(secs) => setTempDuration(secs)}
                            />
                          )}
                        </div>

                        {createTempError && (
                          <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger">
                            {createTempError}
                          </div>
                        )}

                        <div className="flex gap-2.5 pt-2">
                          <Button
                            variant="raised"
                            className="flex-1 font-semibold text-xs"
                            onClick={() => setPersonAction('none')}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="raised"
                            accent="info"
                            className="flex-1 font-bold text-xs"
                            onClick={handleCreateTempCode}
                            disabled={generatingTemp}
                          >
                            {generatingTemp ? 'Generating…' : 'Generate Code'}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-4 text-center">
                        <div className="neo-pressed flex items-center justify-between rounded-xl px-4 py-3.5">
                          <span className="font-mono text-xl sm:text-2xl font-bold tracking-widest text-ink">
                            {generatedCode}
                          </span>
                          <Button
                            variant="glass"
                            accent="info"
                            className="!px-3.5 !py-1.5 text-xs font-semibold"
                            onClick={handleCopyTempCode}
                          >
                            {copiedTempCode ? 'Copied' : 'Copy'}
                          </Button>
                        </div>

                        <p className="text-xs text-ink-dim">
                          Share this code with the person you wish to connect with. Once redeemed, it cannot be reused.
                        </p>

                        <div className="flex gap-2.5 pt-2">
                          <Button
                            variant="ghost"
                            accent="danger"
                            className="flex-1 text-xs font-semibold"
                            onClick={handleCancelTempCode}
                            disabled={cancellingTemp}
                          >
                            {cancellingTemp ? 'Cancelling…' : 'Cancel Code'}
                          </Button>
                          <Button
                            variant="raised"
                            className="flex-1 text-xs font-bold"
                            onClick={() => {
                              setGeneratedCode(null);
                              setGeneratedPairingId(null);
                              setPersonAction('none');
                            }}
                          >
                            Done
                          </Button>
                        </div>
                      </div>
                    )}
                  </NeoSurface>
                </div>
              )}

              {/* Dedicated Themed Surface Modal: Find someone by username */}
              {personAction === 'username' && (
                <div
                  className="fixed inset-0 z-50 flex sm:items-center items-end justify-center p-0 sm:p-4 bg-backdrop/75 backdrop-blur-sm animate-in fade-in duration-200"
                  role="dialog"
                  aria-modal="true"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setPersonAction('none');
                  }}
                >
                  <NeoSurface variant="raised" className="w-full max-w-md rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 flex flex-col gap-4 border border-glass-border/60 bg-surface shadow-2xl max-h-[90vh] overflow-y-auto">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-base font-bold text-ink">Find by Username</h2>
                        <p className="mt-0.5 text-xs text-ink-dim">
                          Search for a handle to send an end-to-end encrypted conversation request.
                        </p>
                      </div>
                      <Button variant="ghost" size="icon" aria-label="Close dialog" className="!h-8 !w-8" onClick={() => setPersonAction('none')}>
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                      </Button>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-ink">Username</label>
                      <NeoInput
                        value={usernameQuery}
                        onChange={(e) => setUsernameQuery(e.target.value)}
                        placeholder="e.g. alice"
                        spellCheck={false}
                        autoCapitalize="none"
                      />
                      <p className="text-[11px] text-ink-dim">Enter handle without @ symbol</p>
                    </div>

                    {searching && (
                      <div className="flex items-center gap-2 text-xs text-ink-dim py-1">
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-info border-t-transparent animate-spin" />
                        <span>Searching directory…</span>
                      </div>
                    )}

                    {searchResult && searchResult !== 'not-found' && searchResult.user && (
                      <div className="p-3.5 bg-surface-2 rounded-xl flex items-center justify-between border border-glass-border/40">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-full bg-info/10 text-info font-bold text-xs flex items-center justify-center shrink-0 border border-info/20">
                            {searchResult.user.username.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-xs text-ink truncate">@{searchResult.user.username}</div>
                            {searchResult.user.displayName && (
                              <div className="text-[11px] text-ink-dim truncate">{searchResult.user.displayName}</div>
                            )}
                          </div>
                        </div>

                        {requestSent ? (
                          <div className="flex items-center gap-1.5 px-3 py-1 bg-positive/10 text-positive rounded-lg text-xs font-semibold border border-positive/20">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                            <span>Request Sent</span>
                          </div>
                        ) : (
                          <Button
                            variant="glass"
                            accent="info"
                            onClick={handleSendConversationRequest}
                            disabled={sendingRequest || searchResult.isSelf}
                            className="text-xs !py-1.5 !px-3 font-semibold"
                          >
                            {searchResult.isSelf ? 'This is you' : sendingRequest ? 'Sending…' : 'Send Request'}
                          </Button>
                        )}
                      </div>
                    )}

                    {searchResult === 'not-found' && (
                      <div className="p-3 bg-surface-2/60 rounded-xl text-xs text-ink-dim border border-glass-border/30">
                        No user found with that username, or their privacy settings prevent discovery.
                      </div>
                    )}

                    {usernameRequestError && (
                      <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger">
                        {usernameRequestError}
                      </div>
                    )}

                    <div className="flex justify-end pt-2">
                      <Button
                        variant="raised"
                        className="w-full font-semibold text-xs"
                        onClick={() => setPersonAction('none')}
                      >
                        Close
                      </Button>
                    </div>
                  </NeoSurface>
                </div>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 2: GROUP CHAT ROOMS                                        */}
          {/* ============================================================== */}
          {connectTab === 'room' && (
            <div className="flex flex-col gap-5">
              {/* Room Sub-switcher */}
              <div className="flex gap-2">
                <Button
                  variant={roomSubTab === 'create' ? 'raised' : 'ghost'}
                  accent={roomSubTab === 'create' ? 'info' : undefined}
                  className="flex-1 text-xs font-bold"
                  onClick={() => { setRoomSubTab('create'); setCreatedRoomInfo(null); }}
                >
                  Create Room
                </Button>
                <Button
                  variant={roomSubTab === 'join' ? 'raised' : 'ghost'}
                  accent={roomSubTab === 'join' ? 'info' : undefined}
                  className="flex-1 text-xs font-bold"
                  onClick={() => { setRoomSubTab('join'); setWaitingRoomState(null); }}
                >
                  Join with Code
                </Button>
              </div>

              {/* Sub-view: Create Room */}
              {roomSubTab === 'create' && (
                <NeoSurface variant="raised" className="flex flex-col gap-4 p-5 rounded-2xl">
                  {!createdRoomInfo ? (
                    <form onSubmit={handleCreateRoom} className="flex flex-col gap-4">
                      <div>
                        <h2 className="text-base font-bold text-ink">Create Chat Room</h2>
                        <p className="mt-0.5 text-xs text-ink-dim">
                          You will be the Room Owner with authority over keys, settings, and member limits up to 2,000.
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-ink">Room Name</label>
                        <NeoInput
                          type="text"
                          value={roomName}
                          onChange={(e) => setRoomName(e.target.value)}
                          placeholder="e.g. Design Team, Family Hangout"
                          maxLength={50}
                          required
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <label className="font-semibold text-ink">Maximum Members (2 – 2,000)</label>
                          <span className="text-ink-dim font-bold">{roomMaxMembers} members</span>
                        </div>
                        
                        {/* Preset buttons */}
                        <div className="flex flex-wrap gap-1.5">
                          {ROOM_CAPACITY_PRESETS.map((count) => (
                            <button
                              type="button"
                              key={count}
                              onClick={() => handleCapacityPresetSelect(count)}
                              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${
                                roomMaxMembers === count && customMaxMembersInput === String(count)
                                  ? 'neo-pressed text-info font-bold shadow-inner'
                                  : 'neo-raised text-ink-dim hover:text-ink'
                              }`}
                            >
                              {count}
                            </button>
                          ))}
                        </div>

                        {/* Custom Capacity Input */}
                        <div className="pt-1 flex items-center gap-2">
                          <span className="text-xs text-ink-dim shrink-0">Custom limit:</span>
                          <input
                            type="number"
                            min={2}
                            max={2000}
                            value={customMaxMembersInput}
                            onChange={(e) => handleCustomCapacityChange(e.target.value)}
                            className="neo-pressed w-24 text-xs font-bold text-ink rounded-xl px-3 py-1.5 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                          />
                          <span className="text-[11px] text-ink-dim">
                            (Owner counts as 1 member)
                          </span>
                        </div>
                      </div>

                      <div className="space-y-2 pt-1">
                        <label className="text-xs font-semibold text-ink">Join Permission</label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => setRoomJoinPolicy('OPEN')}
                            className={`p-3 rounded-xl text-left transition-all flex flex-col gap-1 ${
                              roomJoinPolicy === 'OPEN'
                                ? 'neo-pressed border border-info/40 bg-info/5'
                                : 'neo-raised hover:opacity-90'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${roomJoinPolicy === 'OPEN' ? 'border-info' : 'border-ink-dim/40'}`}>
                                {roomJoinPolicy === 'OPEN' && <div className="w-1.5 h-1.5 rounded-full bg-info" />}
                              </div>
                              <span className="font-semibold text-ink">Open Join</span>
                            </div>
                            <span className="text-[11px] text-ink-dim">Anyone with the code can join immediately.</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => setRoomJoinPolicy('APPROVAL_REQUIRED')}
                            className={`p-3 rounded-xl text-left transition-all flex flex-col gap-1 ${
                              roomJoinPolicy === 'APPROVAL_REQUIRED'
                                ? 'neo-pressed border border-info/40 bg-info/5'
                                : 'neo-raised hover:opacity-90'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center ${roomJoinPolicy === 'APPROVAL_REQUIRED' ? 'border-info' : 'border-ink-dim/40'}`}>
                                {roomJoinPolicy === 'APPROVAL_REQUIRED' && <div className="w-1.5 h-1.5 rounded-full bg-info" />}
                              </div>
                              <span className="font-semibold text-ink">Approval Required</span>
                            </div>
                            <span className="text-[11px] text-ink-dim">Owner must accept join requests from queue.</span>
                          </button>
                        </div>
                      </div>

                      {createRoomError && (
                        <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger">
                          {createRoomError}
                        </div>
                      )}

                      <div className="flex gap-2.5 pt-2">
                        <Button
                          type="button"
                          variant="raised"
                          className="flex-1 font-semibold text-xs"
                          onClick={() => {
                            setRoomName('');
                            setRoomMaxMembers(50);
                            setCustomMaxMembersInput('50');
                            setConnectTab('person');
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          variant="raised"
                          accent="info"
                          disabled={creatingRoom || !roomName.trim()}
                          className="flex-1 font-bold text-xs"
                        >
                          {creatingRoom ? 'Creating Room…' : 'Create Room'}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-4 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-info/10 text-info flex items-center justify-center mx-auto border border-info/20 shadow-sm">
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                      </div>
                      <div>
                        <h2 className="text-lg font-bold text-ink">Room Created</h2>
                        <p className="mt-0.5 text-xs text-ink-dim">
                          Share this permanent code with anyone you want in #{createdRoomInfo.name}.
                        </p>
                      </div>

                      <div className="neo-pressed flex items-center justify-between rounded-xl px-4 py-3.5 my-1">
                        <span className="font-mono text-xl sm:text-2xl font-bold tracking-widest text-ink">
                          {createdRoomInfo.code}
                        </span>
                        <Button
                          variant="glass"
                          accent="info"
                          className="!px-3.5 !py-1.5 text-xs font-semibold"
                          onClick={handleCopyCreatedRoomCode}
                        >
                          {copiedCreatedRoomCode ? 'Copied' : 'Copy'}
                        </Button>
                      </div>

                      <p className="text-xs text-ink-dim">
                        Limit: 1 / {createdRoomInfo.maxMembers} members.
                      </p>

                      <Button
                        variant="raised"
                        accent="info"
                        className="w-full font-bold"
                        onClick={() => router.push(`/chat/room/${createdRoomInfo.id}`)}
                      >
                        Open Chat Room
                      </Button>
                    </div>
                  )}
                </NeoSurface>
              )}

              {/* Sub-view: Join Room */}
              {roomSubTab === 'join' && (
                <NeoSurface variant="raised" className="flex flex-col gap-4 p-5 rounded-2xl">
                  {!waitingRoomState ? (
                    <form onSubmit={handleJoinRoom} className="flex flex-col gap-4">
                      <div>
                        <h2 className="text-base font-bold text-ink">Join Chat Room</h2>
                        <p className="mt-0.5 text-xs text-ink-dim">
                          Enter the 9-character Room Code provided by the owner.
                        </p>
                      </div>

                      <input
                        type="text"
                        value={roomCodeInput}
                        onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                        placeholder="ABC123XYZ"
                        maxLength={32}
                        autoCapitalize="characters"
                        autoComplete="off"
                        spellCheck={false}
                        className="neo-pressed w-full rounded-xl py-3.5 px-4 text-center font-mono text-xl sm:text-2xl tracking-widest text-ink placeholder:text-ink-dim/40 placeholder:tracking-normal focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-info"
                      />

                      {joinRoomError && (
                        <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger">
                          {joinRoomError}
                        </div>
                      )}

                      <div className="flex gap-2.5 pt-2">
                        <Button
                          type="button"
                          variant="raised"
                          className="flex-1 font-semibold text-xs"
                          onClick={() => {
                            setRoomCodeInput('');
                            setConnectTab('person');
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          variant="raised"
                          accent="info"
                          disabled={joiningRoom || !roomCodeInput.trim()}
                          className="flex-1 font-bold text-xs"
                        >
                          {joiningRoom ? 'Joining…' : 'Join Room'}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-4 text-center py-4">
                      <div className="w-12 h-12 rounded-2xl bg-info/10 text-info flex items-center justify-center mx-auto border border-info/20 shadow-sm animate-pulse">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                      </div>
                      <div>
                        <h2 className="text-base font-bold text-ink">Join request sent</h2>
                        <p className="mt-1 text-xs text-ink-dim">
                          Waiting for the room owner to approve your request to join <span className="font-semibold text-ink">{waitingRoomState.roomName}</span>.
                        </p>
                      </div>

                      {joinAcceptedBanner ? (
                        <div className="p-3 rounded-xl bg-accent/15 border border-accent/30 text-xs font-bold text-accent">
                          {joinAcceptedBanner}
                        </div>
                      ) : (
                        <div className="p-3 rounded-xl bg-surface-2 text-xs text-ink-dim border border-glass-border/40">
                          You will enter automatically once accepted.
                        </div>
                      )}

                      <Button
                        variant="ghost"
                        className="text-xs text-ink-dim"
                        onClick={() => setWaitingRoomState(null)}
                      >
                        Cancel / Back
                      </Button>
                    </div>
                  )}
                </NeoSurface>
              )}
            </div>
          )}
        </div>
      </main>

      <TabBar active="Connect" />
    </div>
  );
}
