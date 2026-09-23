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
  const [mode, setMode] = useState<'choose' | 'create' | 'enter' | 'username'>('choose');

  // --- Forever Code state ---
  const [foreverCode, setForeverCode] = useState<string | null>(null);
  const [loadingForeverCode, setLoadingForeverCode] = useState(true);
  const [foreverCodeAction, setForeverCodeAction] = useState<'creating' | 'deleting' | null>(null);
  const [foreverCodeError, setForeverCodeError] = useState<string | null>(null);
  const [copiedForeverCode, setCopiedForeverCode] = useState(false);
  const [connectSuccessMessage, setConnectSuccessMessage] = useState<string | null>(null);

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
    } catch {
      // Clipboard fallback
    }
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

  // --- Create-code flow (Temporary codes) ---
  const [duration, setDuration] = useState<number | null>(900);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [generatedPairingId, setGeneratedPairingId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // --- Enter-code flow ---
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

  // Leaves the page entirely — distinct from the existing "← Back" control
  // further down, which only resets the in-page step (create/enter/
  // username -> choose) and is left untouched. `history.length > 1` is a
  // pragmatic signal for "there's somewhere in-app to return to"; Next's
  // router has no reliable way to know whether the previous entry was
  // actually within this app, so a direct link to /connect (history
  // length 1, e.g. opened in a new tab) falls back to the main screen
  // instead of leaving the user on a blank back-navigation.
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
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Button>
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-ink">Connect</h1>
              <p className="mt-0.5 text-xs text-ink-dim">Pair end-to-end with another person or device</p>
            </div>
          </header>

      {mode === 'choose' && (
        <div className="flex flex-col gap-5">
          {/* Section 1: Your Forever Code */}
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

          {/* Section 2: Connect With Someone */}
          <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
            <div>
              <h2 className="text-base font-bold text-ink">Connect With Someone</h2>
              <p className="mt-0.5 text-xs text-ink-dim">
                Enter another person&apos;s Forever Code or 6-digit code.
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <input
                value={digits}
                onChange={(e) => setDigits(e.target.value.toUpperCase())}
                placeholder="ABC123XYZ"
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
                  Codes that never expire are a larger long-term target. Rate limiting still applies either way, but a
                  shorter duration is safer.
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
                Share this with the one person you want to connect with. It works once.
              </p>
              {createError && <div className="text-center text-sm text-danger">{createError}</div>}
              <Button variant="raised" className="w-full" onClick={() => router.push('/chat')}>
                Done
              </Button>
              <Button variant="ghost" accent="danger" className="w-full" onClick={handleCancelCode} disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Cancel this code'}
              </Button>
            </>
          )}
        </NeoSurface>
      )}

      {mode === 'username' && (
        <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-sm text-ink-dim">@</span>
            <NeoInput
              type="text"
              placeholder="username"
              value={usernameQuery}
              onChange={(e) => setUsernameQuery(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className="pl-8"
            />
          </div>

          {usernameQuery.length > 0 && !queryValidation.valid && (
            <div className="text-xs text-ink-dim">{queryValidation.error}</div>
          )}
          {searching && <div className="text-xs text-ink-dim">Searching…</div>}

          {searchResult === 'not-found' && !searching && <div className="text-sm text-ink-dim">User not found.</div>}

          {searchResult && searchResult !== 'not-found' && searchResult.isSelf && (
            <div className="text-sm text-ink-dim">This is your username.</div>
          )}

          {searchResult && searchResult !== 'not-found' && searchResult.user && !searchResult.isSelf && (
            <NeoSurface variant="pressed" className="flex flex-col gap-3 p-4">
              <div>
                <div className="text-sm font-semibold">@{searchResult.user.username}</div>
                {searchResult.user.displayName && <div className="text-xs text-ink-dim">{searchResult.user.displayName}</div>}
              </div>
              <p className="text-xs text-ink-dim">
                To start an encrypted chat, generate a code to share with them, or enter a code they&apos;ve shared with
                you.
              </p>
              {startChatError && <div className="text-xs text-danger">{startChatError}</div>}
              <div className="flex flex-col gap-2">
                <Button variant="glass" accent="info" className="w-full" onClick={() => handleStartChat('create')} disabled={confirmingStartChat}>
                  Generate a code to share
                </Button>
                <Button variant="raised" className="w-full" onClick={() => handleStartChat('enter')} disabled={confirmingStartChat}>
                  Enter their code
                </Button>
              </div>
            </NeoSurface>
          )}
        </NeoSurface>
      )}

      {mode === 'enter' && (
        <NeoSurface variant="raised" className="flex flex-col gap-4 p-5">
          <h2 className="text-base font-bold text-ink">Enter Code</h2>
          <input
            value={digits}
            onChange={(e) => setDigits(e.target.value.toUpperCase())}
            placeholder="ABC123XYZ or 000000"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="neo-pressed w-full rounded-xl py-3.5 px-4 text-center font-mono text-xl sm:text-2xl tracking-widest text-ink focus:outline-none"
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
          <Button variant="glass" accent="info" className="w-full font-bold" onClick={handleRedeem} disabled={redeeming || !digits.trim()}>
            {redeeming ? 'Connecting…' : 'Connect'}
          </Button>
        </NeoSurface>
      )}

      {mode !== 'choose' && (
        <button className="text-center text-xs text-ink-dim" onClick={() => setMode('choose')}>
          ← Back
        </button>
      )}
        </div>
      </main>

      <TabBar active="Connect" />
    </div>
  );
}
