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
import { initiateHandshake, toPublicBundle, DeviceIdentity, PublicKeyBundle } from '@/lib/crypto/engine';
import { initSession } from '@/lib/crypto/sessionStore';
import { normalizeUsername, validateUsername } from '@/lib/username';
import { connectSocket } from '@/lib/realtime/socket';
import { generateRoomKey } from '@/lib/crypto/roomCrypto';
import { saveRoomKey } from '@/lib/storage/roomStorage';

const DURATIONS: { label: string; seconds: number | null }[] = [
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },
  { label: '1d', seconds: 86400 },
  { label: '7d', seconds: 604800 },
  { label: 'Forever', seconds: null },
];

interface FoundUser {
  username: string;
  displayName: string | null;
}
interface SearchResponse {
  user: FoundUser | null;
  isSelf?: boolean;
}

export default function ConnectPage() {
  const { userId } = useAuth();
  const router = useRouter();

  // Top-level tab: 'person' (1-on-1) vs 'room' (Group Chat Room)
  const [connectTab, setConnectTab] = useState<'person' | 'room'>('person');

  // --- 1-to-1 Mode state ---
  const [mode, setMode] = useState<'choose' | 'create' | 'enter' | 'username'>('choose');
  const [foreverCode, setForeverCode] = useState<string | null>(null);
  const [loadingForeverCode, setLoadingForeverCode] = useState(true);
  const [foreverCodeAction, setForeverCodeAction] = useState<'creating' | 'deleting' | null>(null);
  const [foreverCodeError, setForeverCodeError] = useState<string | null>(null);
  const [copiedForeverCode, setCopiedForeverCode] = useState(false);
  const [connectSuccessMessage, setConnectSuccessMessage] = useState<string | null>(null);

  // --- Room state ---
  const [roomSubTab, setRoomSubTab] = useState<'create' | 'join'>('create');
  const [roomName, setRoomName] = useState('');
  const [roomMaxMembers, setRoomMaxMembers] = useState(10);
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

  // Listen for socket events while waiting for room approval
  useEffect(() => {
    if (!waitingRoomState) return;
    let active = true;

    connectSocket().then((socket) => {
      if (!active) return;
      socket.on('room:join_accepted', (evt: any) => {
        if (evt.roomId === waitingRoomState.roomId) {
          setJoinAcceptedBanner(`✓ Joined ${evt.roomName}! Entering room...`);
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

  // --- Username-search flow ---
  const [usernameQuery, setUsernameQuery] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResponse | 'not-found' | null>(null);
  const [searching, setSearching] = useState(false);
  const searchRequestIdRef = useRef(0);

  const normalizedQuery = normalizeUsername(usernameQuery);
  const queryValidation = validateUsername(normalizedQuery);

  useEffect(() => {
    setSearchResult(null);
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

  const [startChatError, setStartChatError] = useState<string | null>(null);
  const [confirmingStartChat, setConfirmingStartChat] = useState(false);
  async function handleStartChat(nextMode: 'create' | 'enter') {
    setStartChatError(null);
    setConfirmingStartChat(true);
    try {
      const result = await api<SearchResponse>(`/api/users/search?username=${encodeURIComponent(normalizedQuery)}`);
      if (!result.user) {
        setStartChatError('This account is no longer available to chat with.');
        setSearchResult('not-found');
        return;
      }
      setMode(nextMode);
    } catch {
      setStartChatError('Could not confirm this account right now. Please try again.');
    } finally {
      setConfirmingStartChat(false);
    }
  }

  // --- Temporary code flow ---
  const [duration, setDuration] = useState<number | null>(900);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [generatedPairingId, setGeneratedPairingId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [digits, setDigits] = useState('');
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  async function handleCreate() {
    setCreateError(null);
    try {
      const result = await api<{ pairingId: string; code: string }>('/api/pairing/create', {
        method: 'POST',
        body: { durationSeconds: duration },
      });
      setGeneratedCode(result.code);
      setGeneratedPairingId(result.pairingId);
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : 'Could not create a code. Please try again.');
    }
  }

  async function handleCancelCode() {
    if (!generatedPairingId) return;
    setCancelling(true);
    try {
      await api(`/api/pairing/${generatedPairingId}`, { method: 'DELETE' });
      setGeneratedCode(null);
      setGeneratedPairingId(null);
    } catch {
      setCreateError('Could not cancel the code. Please try again.');
    } finally {
      setCancelling(false);
    }
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
    if (roomMaxMembers < 2 || roomMaxMembers > 100) {
      setCreateRoomError('Maximum members must be between 2 and 100.');
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
          maxMembers: roomMaxMembers,
          joinPolicy: roomJoinPolicy,
        },
      });

      // Generate local room key and store in IDB
      const rKey = generateRoomKey();
      await saveRoomKey(res.room.id, 1, rKey);

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
          <div className="flex p-1 bg-surface-2/70 rounded-xl max-w-md mx-auto w-full border border-glass-border/40 shadow-inner">
            <button
              type="button"
              onClick={() => { setConnectTab('person'); setMode('choose'); }}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                connectTab === 'person' ? 'bg-surface text-ink shadow-sm' : 'text-ink-dim hover:text-ink'
              }`}
            >
              Person (1-on-1)
            </button>
            <button
              type="button"
              onClick={() => { setConnectTab('room'); setCreatedRoomInfo(null); setWaitingRoomState(null); }}
              className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${
                connectTab === 'room' ? 'bg-surface text-ink shadow-sm' : 'text-ink-dim hover:text-ink'
              }`}
            >
              Chat Room (Group)
            </button>
          </div>

          {/* ============================================================== */}
          {/* TAB 1: 1-to-1 PERSON CONNECT                                   */}
          {/* ============================================================== */}
          {connectTab === 'person' && (
            <>
              {mode === 'choose' && (
                <div className="flex flex-col gap-5">
                  {/* Section 1: Forever Code */}
                  <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
                    <div>
                      <h2 className="text-base font-bold text-ink">Your Forever Code</h2>
                      <p className="mt-0.5 text-xs text-ink-dim">
                        This code never changes until you delete it. Share it with friends to connect anytime.
                      </p>
                    </div>

                    {loadingForeverCode ? (
                      <div className="py-4 text-center text-xs text-ink-dim">Loading your Forever Code…</div>
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
                            {copiedForeverCode ? 'Copied!' : 'Copy'}
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
                          className="w-full"
                          onClick={handleCreateForeverCode}
                          disabled={foreverCodeAction === 'creating'}
                        >
                          {foreverCodeAction === 'creating' ? 'Creating…' : 'Create Forever Code'}
                        </Button>
                      </div>
                    )}
                  </NeoSurface>

                  {/* Section 2: Enter Partner's Code */}
                  <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
                    <div>
                      <h2 className="text-base font-bold text-ink">Enter a Code to Connect</h2>
                      <p className="mt-0.5 text-xs text-ink-dim">
                        Enter a friend&apos;s Forever Code or temporary pairing code.
                      </p>
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
                        className="neo-pressed w-full rounded-xl py-3.5 px-4 text-center font-mono text-xl sm:text-2xl tracking-widest text-ink placeholder:text-ink-dim/40 placeholder:tracking-normal focus:outline-none"
                      />

                      {connectSuccessMessage && (
                        <div role="status" className="flex items-center gap-2 rounded-xl bg-accent/15 border border-accent/30 p-3 text-xs font-semibold text-accent">
                          <span>✓</span>
                          <span>{connectSuccessMessage}</span>
                        </div>
                      )}

                      {redeemError && (
                        <div role="alert" className="flex items-center gap-2 rounded-xl bg-danger/15 border border-danger/30 p-3 text-xs font-semibold text-danger">
                          <span>✕</span>
                          <span>{redeemError}</span>
                        </div>
                      )}

                      <Button
                        variant="glass"
                        accent="info"
                        className="w-full font-bold"
                        onClick={handleRedeem}
                        disabled={redeeming || !digits.trim()}
                      >
                        {redeeming ? 'Connecting…' : 'Connect'}
                      </Button>
                    </div>
                  </NeoSurface>

                  {/* Section 3: More options */}
                  <div className="flex flex-col gap-2 pt-1">
                    <Button variant="ghost" className="w-full text-xs text-ink-dim hover:text-ink" onClick={() => setMode('create')}>
                      Generate a temporary code (15m, 1h, 7d)
                    </Button>
                    <Button variant="ghost" className="w-full text-xs text-ink-dim hover:text-ink" onClick={() => setMode('username')}>
                      Find someone by username
                    </Button>
                  </div>
                </div>
              )}

              {mode === 'create' && (
                <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
                  {!generatedCode ? (
                    <>
                      <div className="text-sm text-ink-dim">Expires in</div>
                      <div className="flex flex-wrap gap-2">
                        {DURATIONS.map((d) => (
                          <button
                            key={d.label}
                            onClick={() => setDuration(d.seconds)}
                            className={`rounded-full px-4 py-2 text-xs font-semibold ${
                              duration === d.seconds ? 'neo-pressed text-ink' : 'neo-raised text-ink-dim'
                            }`}
                          >
                            {d.label}
                          </button>
                        ))}
                      </div>
                      {duration === null && (
                        <div className="rounded-lg bg-surface-2 p-3 text-xs text-ink-dim">
                          Codes that never expire are a larger long-term target.
                        </div>
                      )}
                      {createError && <div className="text-sm text-danger">{createError}</div>}
                      <Button variant="glass" accent="info" className="w-full" onClick={handleCreate}>
                        Generate code
                      </Button>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-center gap-2 font-mono text-3xl font-medium tracking-widest">
                        {generatedCode}
                      </div>
                      <p className="text-center text-xs text-ink-dim">
                        Share this with the one person you want to connect with.
                      </p>
                      <Button variant="ghost" accent="danger" onClick={handleCancelCode} disabled={cancelling}>
                        {cancelling ? 'Cancelling…' : 'Cancel code'}
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" className="text-xs" onClick={() => setMode('choose')}>
                    ← Back
                  </Button>
                </NeoSurface>
              )}

              {mode === 'username' && (
                <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
                  <div>
                    <h2 className="text-base font-bold text-ink">Find by Username</h2>
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Search for an exact username to establish a private chat.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-semibold text-ink">Username</label>
                    <NeoInput
                      value={usernameQuery}
                      onChange={(e) => setUsernameQuery(e.target.value)}
                      placeholder="alice"
                      spellCheck={false}
                      autoCapitalize="none"
                    />
                    <p className="text-[11px] text-ink-dim">Enter handle without @</p>
                  </div>
                  {searching && <div className="text-xs text-ink-dim">Searching…</div>}
                  {searchResult && searchResult !== 'not-found' && searchResult.user && (
                    <div className="p-3 bg-surface-2 rounded-xl text-xs flex items-center justify-between">
                      <span className="font-semibold text-ink">@{searchResult.user.username}</span>
                      <Button variant="raised" accent="info" onClick={() => handleStartChat('enter')} disabled={confirmingStartChat} className="text-xs !py-1 !px-3">
                        Connect
                      </Button>
                    </div>
                  )}
                  {searchResult === 'not-found' && (
                    <div className="text-xs text-ink-dim">No user found with that username.</div>
                  )}
                  {startChatError && <div className="text-xs text-danger">{startChatError}</div>}
                  <Button variant="ghost" className="text-xs" onClick={() => setMode('choose')}>
                    ← Back
                  </Button>
                </NeoSurface>
              )}
            </>
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
                  className="flex-1 text-xs"
                  onClick={() => { setRoomSubTab('create'); setCreatedRoomInfo(null); }}
                >
                  Create Room
                </Button>
                <Button
                  variant={roomSubTab === 'join' ? 'raised' : 'ghost'}
                  accent={roomSubTab === 'join' ? 'info' : undefined}
                  className="flex-1 text-xs"
                  onClick={() => { setRoomSubTab('join'); setWaitingRoomState(null); }}
                >
                  Join with Code
                </Button>
              </div>

              {/* Sub-view: Create Room */}
              {roomSubTab === 'create' && (
                <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
                  {!createdRoomInfo ? (
                    <form onSubmit={handleCreateRoom} className="flex flex-col gap-4">
                      <div>
                        <h2 className="text-base font-bold text-ink">Create Chat Room</h2>
                        <p className="mt-0.5 text-xs text-ink-dim">
                          You will be the Room Owner and administrator.
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold text-ink">Room Name</label>
                        <input
                          type="text"
                          value={roomName}
                          onChange={(e) => setRoomName(e.target.value)}
                          placeholder="e.g. Design Team, Family Hangout"
                          maxLength={50}
                          required
                          className="w-full bg-surface-2 text-xs sm:text-sm text-ink placeholder:text-ink-dim rounded-xl px-3.5 py-2.5 border border-glass-border/40 focus:outline-none focus:ring-1 focus:ring-info/60"
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <label className="font-semibold text-ink">Maximum Members</label>
                          <span className="text-ink-dim font-bold">{roomMaxMembers} members</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {[5, 10, 25, 50, 100].map((count) => (
                            <button
                              type="button"
                              key={count}
                              onClick={() => setRoomMaxMembers(count)}
                              className={`rounded-lg px-3 py-1.5 text-xs font-semibold border transition-all ${
                                roomMaxMembers === count
                                  ? 'bg-info text-white border-info shadow-sm'
                                  : 'bg-surface-2 text-ink-dim hover:text-ink border-glass-border/40'
                              }`}
                            >
                              {count}
                            </button>
                          ))}
                        </div>
                        <p className="text-[11px] text-ink-dim">
                          Members: 1 / {roomMaxMembers} (Owner counts as 1 member)
                        </p>
                      </div>

                      <div className="space-y-2 pt-1">
                        <label className="text-xs font-semibold text-ink">Join Permission</label>
                        <div className="space-y-2 text-xs">
                          <label className="flex items-start gap-2.5 cursor-pointer p-2.5 rounded-xl hover:bg-surface-2 transition-colors">
                            <input
                              type="radio"
                              name="joinPolicy"
                              checked={roomJoinPolicy === 'OPEN'}
                              onChange={() => setRoomJoinPolicy('OPEN')}
                              className="mt-0.5 text-info"
                            />
                            <div>
                              <div className="font-semibold text-ink">Anyone with the code can join</div>
                              <div className="text-[11px] text-ink-dim">Users join immediately when entering the code.</div>
                            </div>
                          </label>

                          <label className="flex items-start gap-2.5 cursor-pointer p-2.5 rounded-xl hover:bg-surface-2 transition-colors">
                            <input
                              type="radio"
                              name="joinPolicy"
                              checked={roomJoinPolicy === 'APPROVAL_REQUIRED'}
                              onChange={() => setRoomJoinPolicy('APPROVAL_REQUIRED')}
                              className="mt-0.5 text-info"
                            />
                            <div>
                              <div className="font-semibold text-ink">Approval required (Recommended)</div>
                              <div className="text-[11px] text-ink-dim">You must accept join requests from the queue.</div>
                            </div>
                          </label>
                        </div>
                      </div>

                      {createRoomError && (
                        <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger">
                          {createRoomError}
                        </div>
                      )}

                      <Button
                        type="submit"
                        variant="raised"
                        accent="info"
                        disabled={creatingRoom || !roomName.trim()}
                        className="w-full mt-2 font-bold"
                      >
                        {creatingRoom ? 'Creating Room…' : 'Create Chat Room'}
                      </Button>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-4 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-info/10 text-info flex items-center justify-center mx-auto text-xl border border-info/20 shadow-sm">
                        ✓
                      </div>
                      <div>
                        <h2 className="text-lg font-bold text-ink">Room Created!</h2>
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
                          {copiedCreatedRoomCode ? 'Copied!' : 'Copy'}
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
                <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
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
                        className="neo-pressed w-full rounded-xl py-3.5 px-4 text-center font-mono text-xl sm:text-2xl tracking-widest text-ink placeholder:text-ink-dim/40 placeholder:tracking-normal focus:outline-none"
                      />

                      {joinRoomError && (
                        <div className="p-3 rounded-xl bg-danger/15 border border-danger/30 text-xs text-danger">
                          {joinRoomError}
                        </div>
                      )}

                      <Button
                        type="submit"
                        variant="raised"
                        accent="info"
                        disabled={joiningRoom || !roomCodeInput.trim()}
                        className="w-full font-bold"
                      >
                        {joiningRoom ? 'Joining…' : 'Join Room'}
                      </Button>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-4 text-center py-4">
                      <div className="w-12 h-12 rounded-2xl bg-info/10 text-info flex items-center justify-center mx-auto text-xl animate-pulse border border-info/20 shadow-sm">
                        ⏳
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
