'use client';

import React, { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthContext';
import { api, ApiError } from '@/lib/api/client';
import { PookieLogo } from '@/components/ui/PookieLogo';
import { Button } from '@/components/ui/Button';
import { ThemeToggle } from '@/components/ui/ThemeToggle';

// --- Type Definitions ---
interface AdminMetrics {
  overview: {
    totalUsers: number;
    activeUsers24h: number;
    activeUsers7d: number;
    activeUsers30d: number;
    bannedUsers: number;
    lockedUsers: number;
    verifiedEmailUsers: number;
    totalRooms: number;
    activeRooms: number;
    closedRooms: number;
    lockedRooms: number;
    totalConversations: number;
    totalMessages: number;
    messages24h: number;
    totalAttachments: number;
    totalStorageBytes: number;
    securityEvents24h: number;
  };
  system: {
    uptimeSeconds: number;
    dbLatencyMs: number;
    nodeVersion: string;
    platform: string;
    memory: {
      heapUsedMb: number;
      heapTotalMb: number;
      rssMb: number;
    };
  };
  activityTimeline: Array<{
    date: string;
    signups: number;
    messages: number;
  }>;
  recentSecurityEvents: Array<{
    id: string;
    eventType: string;
    metadata: any;
    createdAt: string;
    user: { id: string; username: string; email: string | null } | null;
  }>;
  recentAuditLogs: Array<{
    id: string;
    action: string;
    targetType: string;
    targetId: string | null;
    details: any;
    ipAddress: string | null;
    createdAt: string;
    admin: { id: string; username: string; email: string | null };
  }>;
}

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  status: 'ACTIVE' | 'DELETED';
  role: 'USER' | 'ADMIN' | 'SUPERADMIN';
  isLocked: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  emailVerified: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  devicesCount: number;
  roomsCount: number;
  messagesCount: number;
}

interface AdminUserDetail {
  user: AdminUser & {
    stats: {
      totalDirectConversations: number;
      totalDirectMessages: number;
      totalRoomMessages: number;
      roomsOwned: number;
      roomsJoined: number;
      activeDevices: number;
    };
  };
  devices: Array<{
    id: string;
    deviceName: string | null;
    platform: string;
    lastSeenAt: string;
    revokedAt: string | null;
    createdAt: string;
  }>;
  sessions: Array<{
    id: string;
    deviceId: string;
    userAgent: string | null;
    ipHash: string | null;
    expiresAt: string;
    revokedAt: string | null;
    createdAt: string;
  }>;
  securityEvents: Array<{
    id: string;
    eventType: string;
    metadata: any;
    createdAt: string;
  }>;
  rooms: Array<{
    roomId: string;
    name: string;
    role: string;
    joinedAt: string;
    status: string;
    joinLocked: boolean;
  }>;
}

interface AdminRoom {
  id: string;
  name: string;
  status: 'ACTIVE' | 'CLOSED' | 'DELETED';
  joinPolicy: 'OPEN' | 'APPROVAL_REQUIRED';
  joinLocked: boolean;
  maxMembers: number;
  keyEpoch: number;
  createdAt: string;
  owner: { id: string; username: string; email: string | null };
  membersCount: number;
  messagesCount: number;
  pendingRequestsCount: number;
}

interface AdminRoomDetail {
  room: AdminRoom;
  members: Array<{
    id: string;
    userId: string;
    username: string;
    email: string | null;
    status: string;
    role: string;
    joinedAt: string;
  }>;
  joinRequests: Array<{
    id: string;
    requester: { id: string; username: string; email: string | null };
    status: string;
    createdAt: string;
    reviewedAt: string | null;
  }>;
}

type TabType = 'overview' | 'users' | 'rooms' | 'security' | 'system';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

export default function AdminPage() {
  const router = useRouter();
  const { userId, username, role, isAdmin, loading: authLoading } = useAuth();

  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(true);

  // Users State
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userSearch, setUserSearch] = useState('');
  const [userFilter, setUserFilter] = useState<'all' | 'active' | 'locked' | 'banned' | 'admins'>('all');
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [inspectUser, setInspectUser] = useState<AdminUserDetail | null>(null);
  const [loadingInspect, setLoadingInspect] = useState(false);

  // Rooms State
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [roomTotal, setRoomTotal] = useState(0);
  const [roomPage, setRoomPage] = useState(1);
  const [roomSearch, setRoomSearch] = useState('');
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [inspectRoom, setInspectRoom] = useState<AdminRoomDetail | null>(null);

  // Security Events & Audit Logs State
  const [securityEvents, setSecurityEvents] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [securityTab, setSecurityTab] = useState<'events' | 'audits'>('events');
  const [loadingSecurity, setLoadingSecurity] = useState(false);

  // Action status & message banners
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  // Bootstrap tool state
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [bootstrapTarget, setBootstrapTarget] = useState('');
  const [bootstrapMsg, setBootstrapMsg] = useState<string | null>(null);

  // Clear feedback after 5 seconds
  useEffect(() => {
    if (!feedbackMsg) return;
    const t = setTimeout(() => setFeedbackMsg(null), 5000);
    return () => clearTimeout(t);
  }, [feedbackMsg]);

  // Load metrics
  const loadMetrics = async () => {
    try {
      setLoadingMetrics(true);
      const data = await api<AdminMetrics>('/api/admin/metrics');
      setMetrics(data);
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to load platform metrics.' });
    } finally {
      setLoadingMetrics(false);
    }
  };

  // Load users
  const loadUsers = async () => {
    try {
      setLoadingUsers(true);
      const params = new URLSearchParams({
        page: String(userPage),
        limit: '15',
      });
      if (userSearch.trim()) params.set('search', userSearch.trim());
      if (userFilter === 'active') params.set('status', 'ACTIVE');
      if (userFilter === 'banned') params.set('status', 'DELETED');
      if (userFilter === 'locked') params.set('isLocked', 'true');
      if (userFilter === 'admins') params.set('role', 'ADMIN');

      const res = await api<{ users: AdminUser[]; total: number }>(`/api/admin/users?${params.toString()}`);
      setUsers(res.users);
      setUserTotal(res.total);
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to fetch users.' });
    } finally {
      setLoadingUsers(false);
    }
  };

  // Load rooms
  const loadRooms = async () => {
    try {
      setLoadingRooms(true);
      const params = new URLSearchParams({
        page: String(roomPage),
        limit: '15',
      });
      if (roomSearch.trim()) params.set('search', roomSearch.trim());
      const res = await api<{ rooms: AdminRoom[]; total: number }>(`/api/admin/rooms?${params.toString()}`);
      setRooms(res.rooms);
      setRoomTotal(res.total);
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to fetch rooms.' });
    } finally {
      setLoadingRooms(false);
    }
  };

  // Load security events & audits
  const loadSecurity = async () => {
    try {
      setLoadingSecurity(true);
      const [eventsRes, auditsRes] = await Promise.all([
        api<{ events: any[] }>('/api/admin/security/events?limit=30'),
        api<{ logs: any[] }>('/api/admin/security/audit-logs?limit=30'),
      ]);
      setSecurityEvents(eventsRes.events);
      setAuditLogs(auditsRes.logs);
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to load security logs.' });
    } finally {
      setLoadingSecurity(false);
    }
  };

  // Initial load when admin confirmed
  useEffect(() => {
    if (!authLoading && isAdmin) {
      loadMetrics();
    }
  }, [authLoading, isAdmin]);

  // Tab change effects
  useEffect(() => {
    if (!isAdmin) return;
    if (activeTab === 'users') loadUsers();
    if (activeTab === 'rooms') loadRooms();
    if (activeTab === 'security') loadSecurity();
    if (activeTab === 'overview' && !metrics) loadMetrics();
  }, [activeTab, userPage, userFilter, roomPage]);

  // Handle User Action: Ban / Unban
  const handleToggleUserStatus = async (user: AdminUser) => {
    const isBan = user.status === 'ACTIVE';
    const confirmText = isBan
      ? `Are you sure you want to ban @${user.username}? This will immediately terminate all active devices and sessions.`
      : `Reactivate account @${user.username}?`;
    if (!window.confirm(confirmText)) return;

    try {
      setActionInProgress(user.id);
      await api(`/api/admin/users/${user.id}/status`, {
        method: 'PATCH',
        body: { status: isBan ? 'DELETED' : 'ACTIVE', reason: 'Admin dashboard action' },
      });
      setFeedbackMsg({
        type: 'success',
        text: `User @${user.username} has been ${isBan ? 'banned and revoked' : 'reactivated'}.`,
      });
      loadUsers();
      if (inspectUser && inspectUser.user.id === user.id) {
        handleInspectUser(user.id);
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to update user status.' });
    } finally {
      setActionInProgress(null);
    }
  };

  // Handle User Action: Unlock Account
  const handleUnlockUser = async (user: AdminUser) => {
    try {
      setActionInProgress(user.id);
      await api(`/api/admin/users/${user.id}/unlock`, { method: 'POST' });
      setFeedbackMsg({ type: 'success', text: `Account @${user.username} has been unlocked.` });
      loadUsers();
      if (inspectUser && inspectUser.user.id === user.id) {
        handleInspectUser(user.id);
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to unlock user.' });
    } finally {
      setActionInProgress(null);
    }
  };

  // Handle User Action: Revoke All Sessions
  const handleRevokeSessions = async (user: AdminUser) => {
    if (!window.confirm(`Force terminate all active sessions and devices for @${user.username}?`)) return;
    try {
      setActionInProgress(user.id);
      await api(`/api/admin/users/${user.id}/revoke-sessions`, { method: 'POST' });
      setFeedbackMsg({ type: 'success', text: `All active sessions revoked for @${user.username}.` });
      loadUsers();
      if (inspectUser && inspectUser.user.id === user.id) {
        handleInspectUser(user.id);
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to revoke user sessions.' });
    } finally {
      setActionInProgress(null);
    }
  };

  // Handle User Action: Change Role (Superadmin only)
  const handleChangeRole = async (user: AdminUser, newRole: 'USER' | 'ADMIN' | 'SUPERADMIN') => {
    if (!window.confirm(`Change role of @${user.username} to ${newRole}?`)) return;
    try {
      setActionInProgress(user.id);
      await api(`/api/admin/users/${user.id}/role`, {
        method: 'PATCH',
        body: { role: newRole },
      });
      setFeedbackMsg({ type: 'success', text: `Updated @${user.username}'s role to ${newRole}.` });
      loadUsers();
      if (inspectUser && inspectUser.user.id === user.id) {
        handleInspectUser(user.id);
      }
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to update user role.' });
    } finally {
      setActionInProgress(null);
    }
  };

  // Inspect User Diagnostics
  const handleInspectUser = async (userId: string) => {
    try {
      setLoadingInspect(true);
      const detail = await api<AdminUserDetail>(`/api/admin/users/${userId}`);
      setInspectUser(detail);
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Could not load user diagnostics.' });
    } finally {
      setLoadingInspect(false);
    }
  };

  // Inspect Room
  const handleInspectRoom = async (roomId: string) => {
    try {
      const detail = await api<AdminRoomDetail>(`/api/admin/rooms/${roomId}`);
      setInspectRoom(detail);
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Could not load room details.' });
    }
  };

  // Room Toggle Join Lock
  const handleToggleJoinLock = async (room: AdminRoom) => {
    try {
      await api(`/api/admin/rooms/${room.id}`, {
        method: 'PATCH',
        body: { joinLocked: !room.joinLocked },
      });
      setFeedbackMsg({
        type: 'success',
        text: `Room "${room.name}" joins are now ${!room.joinLocked ? 'LOCKED' : 'UNLOCKED'}.`,
      });
      loadRooms();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to update room.' });
    }
  };

  // Trigger System Sweep
  const handleTriggerSweep = async (type: 'messages' | 'attachments' | 'all') => {
    try {
      setActionInProgress(`sweep-${type}`);
      const res = await api<{
        ok: boolean;
        sweepResult: { expiredMessagesSwept: number; expiredTemporaryChatsSwept: number; orphanedAttachmentsSwept: number };
      }>('/api/admin/system/sweep', {
        method: 'POST',
        body: { type },
      });
      const r = res.sweepResult;
      setFeedbackMsg({
        type: 'success',
        text: `Maintenance sweep completed! Expired messages cleared: ${r.expiredMessagesSwept}, Temporary chats purged: ${r.expiredTemporaryChatsSwept}, Orphan attachments deleted: ${r.orphanedAttachmentsSwept}.`,
      });
      loadMetrics();
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Maintenance sweep failed.' });
    } finally {
      setActionInProgress(null);
    }
  };

  // Bootstrap initial Superadmin
  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bootstrapSecret.trim() || !bootstrapTarget.trim()) return;
    try {
      setBootstrapMsg(null);
      const res = await api<{ ok: boolean; user: { username: string; role: string } }>('/api/admin/bootstrap', {
        method: 'POST',
        authenticated: false,
        body: { secret: bootstrapSecret.trim(), identifier: bootstrapTarget.trim() },
      });
      setBootstrapMsg(`Success: @${res.user.username} is now promoted to ${res.user.role}!`);
      setBootstrapSecret('');
      setBootstrapTarget('');
      loadUsers();
    } catch (err: any) {
      setBootstrapMsg(`Error: ${err?.message || 'Bootstrap failed.'}`);
    }
  };

  // Access Denied Screen if user is not admin
  if (authLoading) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-surface gap-3">
        <PookieLogo size="md" className="animate-pulse" />
        <span className="text-sm font-semibold text-ink-dim">Checking authorization credentials...</span>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center bg-surface px-4 text-center">
        <div className="neo-raised flex flex-col items-center max-w-md w-full p-8 rounded-2xl bg-surface-2/40 border border-glass-border">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/10 text-danger mb-4">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h1 className="text-xl font-bold tracking-tight text-ink mb-1">Access Restricted</h1>
          <p className="text-sm text-ink-dim mb-6">
            The Pookie Administration Console requires elevated privileges. Your account (@{username || 'guest'}) is not registered as an administrator.
          </p>
          <div className="flex gap-3 w-full">
            <Button variant="primary" className="flex-1" onClick={() => router.push('/chat')}>
              Return to Chat
            </Button>
            <Button variant="ghost" className="flex-1" onClick={() => router.push('/settings')}>
              Settings
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col select-none-safe text-ink">
      {/* Top Admin Header */}
      <header className="neo-raised sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-glass-border/40 bg-surface px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Link href="/chat" className="flex items-center gap-2 group">
            <PookieLogo size="sm" className="!h-8 !w-8" />
            <div className="flex flex-col">
              <span className="text-sm font-extrabold tracking-tight text-ink group-hover:text-info transition-colors">
                Pookie Admin
              </span>
              <span className="text-[10px] uppercase font-bold tracking-wider text-ink-dim">
                Platform Console
              </span>
            </div>
          </Link>

          {/* Health status pill */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full neo-pressed bg-surface-2/60 text-[11px] font-semibold text-positive border border-positive/20">
            <span className="h-2 w-2 rounded-full bg-positive animate-pulse" />
            <span>Online · {metrics?.system.dbLatencyMs ?? 0}ms latency</span>
          </div>
        </div>

        {/* Right actions: admin tag, refresh, exit */}
        <div className="flex items-center gap-2.5">
          <div className="hidden md:flex items-center gap-1.5 px-3 py-1 neo-pressed rounded-xl bg-surface-2/40 text-xs font-semibold">
            <span className="text-ink-dim">Logged as</span>
            <span className="text-ink font-bold">@{username}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-info/10 text-info border border-info/30">
              {role}
            </span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              loadMetrics();
              if (activeTab === 'users') loadUsers();
              if (activeTab === 'rooms') loadRooms();
              if (activeTab === 'security') loadSecurity();
            }}
            title="Refresh current view"
            className="!h-9 !px-2.5"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span className="hidden sm:inline ml-1 text-xs font-bold">Refresh</span>
          </Button>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => router.push('/chat')}
            className="!h-9 text-xs font-bold"
          >
            Back to Chat
          </Button>

          <ThemeToggle />
        </div>
      </header>

      {/* Notification Banner */}
      {feedbackMsg && (
        <div
          className={`flex items-center justify-between px-6 py-2.5 text-xs font-semibold border-b ${
            feedbackMsg.type === 'success'
              ? 'bg-positive/10 text-positive border-positive/20'
              : 'bg-danger/10 text-danger border-danger/20'
          }`}
        >
          <span>{feedbackMsg.text}</span>
          <button onClick={() => setFeedbackMsg(null)} className="text-current hover:opacity-75">
            ✕
          </button>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="border-b border-glass-border/30 bg-surface-2/20 px-4 sm:px-6">
        <nav className="flex space-x-1 sm:space-x-2 overflow-x-auto py-2.5 scrollbar-none">
          {[
            { id: 'overview', label: 'Dashboard & Metrics', icon: '📊' },
            { id: 'users', label: 'User Directory', icon: '👥' },
            { id: 'rooms', label: 'Communities & Rooms', icon: '💬' },
            { id: 'security', label: 'Security & Audits', icon: '🛡️' },
            { id: 'system', label: 'System & Maintenance', icon: '⚙️' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as TabType)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition-all shrink-0 ${
                activeTab === tab.id
                  ? 'neo-raised bg-surface text-ink shadow-sm border border-glass-border/60'
                  : 'text-ink-dim hover:text-ink hover:bg-surface-2/40'
              }`}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">
        {/* TAB 1: OVERVIEW & DASHBOARD */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* KPI Cards Grid */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {/* Users KPI */}
              <div className="neo-raised p-4 sm:p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40">
                <div className="flex items-center justify-between text-ink-dim mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider">Registered Accounts</span>
                  <span className="text-lg">👥</span>
                </div>
                <div className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
                  {metrics?.overview.totalUsers.toLocaleString() ?? '—'}
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-positive">
                  <span>● {metrics?.overview.activeUsers24h ?? 0} active today</span>
                  <span className="text-ink-dim">· {metrics?.overview.lockedUsers ?? 0} locked</span>
                </div>
              </div>

              {/* Messages KPI */}
              <div className="neo-raised p-4 sm:p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40">
                <div className="flex items-center justify-between text-ink-dim mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider">Encrypted Messages</span>
                  <span className="text-lg">✉️</span>
                </div>
                <div className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
                  {metrics?.overview.totalMessages.toLocaleString() ?? '—'}
                </div>
                <div className="mt-2 text-[11px] font-semibold text-info">
                  <span>+{metrics?.overview.messages24h ?? 0} sent in last 24h</span>
                </div>
              </div>

              {/* Rooms & Chats KPI */}
              <div className="neo-raised p-4 sm:p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40">
                <div className="flex items-center justify-between text-ink-dim mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider">Chat Rooms & Pairs</span>
                  <span className="text-lg">💬</span>
                </div>
                <div className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
                  {metrics?.overview.totalRooms.toLocaleString() ?? '—'}
                </div>
                <div className="mt-2 text-[11px] font-semibold text-ink-dim">
                  <span>{metrics?.overview.totalConversations ?? 0} 1-on-1 pairs</span>
                  <span className="ml-1 text-positive">· {metrics?.overview.activeRooms ?? 0} active</span>
                </div>
              </div>

              {/* Storage KPI */}
              <div className="neo-raised p-4 sm:p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40">
                <div className="flex items-center justify-between text-ink-dim mb-2">
                  <span className="text-xs font-bold uppercase tracking-wider">Encrypted Storage</span>
                  <span className="text-lg">💾</span>
                </div>
                <div className="text-2xl sm:text-3xl font-black text-ink tracking-tight">
                  {metrics ? formatBytes(metrics.overview.totalStorageBytes) : '—'}
                </div>
                <div className="mt-2 text-[11px] font-semibold text-ink-dim">
                  <span>{metrics?.overview.totalAttachments ?? 0} uploaded media files</span>
                </div>
              </div>
            </div>

            {/* 14-Day Activity Sparkline Visualizer */}
            <div className="neo-raised p-5 sm:p-6 rounded-2xl bg-surface-2/30 border border-glass-border/40">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wider text-ink">14-Day Activity Trend</h2>
                  <p className="text-xs text-ink-dim">Platform-wide daily signups and encrypted message volume</p>
                </div>
                <div className="flex items-center gap-3 text-xs font-semibold">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-info" /> Messages
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-positive" /> Signups
                  </span>
                </div>
              </div>

              {/* Bar visualization */}
              <div className="grid grid-cols-14 gap-1.5 sm:gap-2 h-44 items-end pt-4 border-b border-glass-border/40">
                {metrics?.activityTimeline.map((item, idx) => {
                  const maxMsg = Math.max(...(metrics.activityTimeline.map((t) => t.messages) || [1]), 10);
                  const msgHeight = Math.max(Math.min((item.messages / maxMsg) * 100, 100), 6);
                  return (
                    <div key={idx} className="flex flex-col items-center h-full justify-end group relative">
                      {/* Tooltip */}
                      <div className="absolute -top-12 z-20 hidden group-hover:flex flex-col items-center px-2 py-1 bg-surface neo-raised rounded-md border border-glass-border text-[10px] whitespace-nowrap shadow-lg">
                        <span className="font-bold text-ink">{item.date}</span>
                        <span className="text-info font-medium">{item.messages} msgs · {item.signups} signups</span>
                      </div>
                      <div
                        style={{ height: `${msgHeight}%` }}
                        className="w-full rounded-t-md bg-info/70 group-hover:bg-info transition-all flex items-end justify-center"
                      >
                        {item.signups > 0 && (
                          <div className="w-full h-1.5 bg-positive rounded-t-sm" />
                        )}
                      </div>
                      <span className="text-[9px] font-bold text-ink-dim mt-2 truncate w-full text-center">
                        {item.date.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Two Column: Recent Threat Alerts & Quick Maintenance */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Security Alerts Stream */}
              <div className="neo-raised p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold uppercase tracking-wider text-ink flex items-center gap-2">
                    <span>🛡️</span> Recent Security Alerts
                  </h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setActiveTab('security')}
                    className="!h-7 text-xs font-bold text-info"
                  >
                    View All
                  </Button>
                </div>

                <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                  {metrics?.recentSecurityEvents.length === 0 ? (
                    <div className="text-center py-8 text-xs text-ink-dim">No security incidents logged.</div>
                  ) : (
                    metrics?.recentSecurityEvents.map((evt) => (
                      <div
                        key={evt.id}
                        className="neo-pressed p-2.5 rounded-xl bg-surface-2/40 flex items-center justify-between text-xs border border-glass-border/20"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="px-1.5 py-0.5 rounded font-black text-[10px] uppercase tracking-wider bg-danger/10 text-danger border border-danger/20">
                            {evt.eventType}
                          </span>
                          <span className="font-bold text-ink truncate">
                            {evt.user ? `@${evt.user.username}` : 'System'}
                          </span>
                        </div>
                        <span className="text-[11px] text-ink-dim shrink-0">
                          {new Date(evt.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Maintenance & Quick Actions */}
              <div className="neo-raised p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40 flex flex-col justify-between">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wider text-ink flex items-center gap-2 mb-1">
                    <span>⚙️</span> Maintenance & Sweeps
                  </h2>
                  <p className="text-xs text-ink-dim mb-4">
                    Trigger background sweeps on demand to purge expired temporary chats, disappearing messages, and orphaned file uploads.
                  </p>

                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <Button
                      variant="secondary"
                      onClick={() => handleTriggerSweep('messages')}
                      disabled={!!actionInProgress}
                      className="text-xs font-bold !py-3 flex flex-col items-center gap-1"
                    >
                      <span>💬 Expired Messages</span>
                      <span className="text-[10px] text-ink-dim">Disappearing message sweep</span>
                    </Button>

                    <Button
                      variant="secondary"
                      onClick={() => handleTriggerSweep('attachments')}
                      disabled={!!actionInProgress}
                      className="text-xs font-bold !py-3 flex flex-col items-center gap-1"
                    >
                      <span>📦 Orphan Uploads</span>
                      <span className="text-[10px] text-ink-dim">Purge abandoned files</span>
                    </Button>
                  </div>
                </div>

                <div className="neo-pressed p-3 rounded-xl bg-surface-2/50 text-xs text-ink-dim flex items-center justify-between">
                  <div>
                    <span className="font-bold text-ink">Server Health: </span>
                    <span>Node {metrics?.system.nodeVersion} · Uptime {formatDuration(metrics?.system.uptimeSeconds ?? 0)}</span>
                  </div>
                  <span className="font-bold text-positive">● Healthy</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: USER DIRECTORY */}
        {activeTab === 'users' && (
          <div className="space-y-4">
            {/* Search and Filters */}
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              <div className="relative flex-1">
                <input
                  type="text"
                  placeholder="Search by username, email, or display name..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') loadUsers();
                  }}
                  className="w-full neo-pressed bg-surface-2/40 border border-glass-border/40 rounded-xl px-3.5 py-2 text-xs text-ink placeholder:text-ink-dim focus:outline-none focus:border-info"
                />
                <button
                  onClick={loadUsers}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-bold text-info px-2 py-0.5 rounded hover:bg-info/10"
                >
                  Search
                </button>
              </div>

              {/* Filter Pills */}
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                {(['all', 'active', 'locked', 'banned', 'admins'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => {
                      setUserFilter(f);
                      setUserPage(1);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                      userFilter === f
                        ? 'neo-raised bg-surface text-ink border border-glass-border/60'
                        : 'text-ink-dim hover:text-ink'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* Users Data Table */}
            <div className="neo-raised rounded-2xl bg-surface-2/20 border border-glass-border/40 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-ink">
                  <thead className="bg-surface-2/50 border-b border-glass-border/30 text-[11px] font-bold uppercase tracking-wider text-ink-dim">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Role</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Registered / Last Active</th>
                      <th className="px-4 py-3">Devices</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-glass-border/20">
                    {loadingUsers ? (
                      <tr>
                        <td colSpan={6} className="text-center py-12 text-ink-dim">
                          Loading users directory...
                        </td>
                      </tr>
                    ) : users.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-12 text-ink-dim">
                          No users found matching query.
                        </td>
                      </tr>
                    ) : (
                      users.map((u) => (
                        <tr key={u.id} className="hover:bg-surface-2/30 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-info/10 text-info font-black text-xs shrink-0">
                                {u.username.charAt(0).toUpperCase()}
                              </div>
                              <div className="min-w-0">
                                <div className="font-bold text-ink truncate">@{u.username}</div>
                                <div className="text-[11px] text-ink-dim truncate">
                                  {u.email ?? 'No email bound'}
                                  {u.emailVerified && <span className="ml-1 text-positive">✓</span>}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider border ${
                                u.role === 'SUPERADMIN'
                                  ? 'bg-purple-500/10 text-purple-400 border-purple-500/30'
                                  : u.role === 'ADMIN'
                                  ? 'bg-info/10 text-info border-info/30'
                                  : 'bg-surface-2 text-ink-dim border-glass-border'
                              }`}
                            >
                              {u.role}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {u.status === 'DELETED' ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-danger/10 text-danger border border-danger/20">
                                Banned
                              </span>
                            ) : u.isLocked ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-amber-500/10 text-amber-500 border border-amber-500/20">
                                Locked ({u.failedLoginCount} fails)
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-positive/10 text-positive border border-positive/20">
                                Active
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-ink-dim text-[11px]">
                            <div>Created: {new Date(u.createdAt).toLocaleDateString()}</div>
                            <div>
                              Last: {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : 'Never'}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-ink-dim">
                            {u.devicesCount} active
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleInspectUser(u.id)}
                                className="!h-7 text-xs font-bold"
                              >
                                Inspect
                              </Button>

                              {u.isLocked && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => handleUnlockUser(u)}
                                  className="!h-7 text-xs font-bold text-amber-500"
                                >
                                  Unlock
                                </Button>
                              )}

                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleToggleUserStatus(u)}
                                disabled={actionInProgress === u.id || u.id === userId}
                                className={`!h-7 text-xs font-bold ${
                                  u.status === 'ACTIVE' ? 'text-danger hover:bg-danger/10' : 'text-positive hover:bg-positive/10'
                                }`}
                              >
                                {u.status === 'ACTIVE' ? 'Ban' : 'Unban'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between px-4 py-3 border-t border-glass-border/30 bg-surface-2/30 text-xs text-ink-dim font-semibold">
                <span>
                  Showing {users.length} of {userTotal} accounts
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={userPage <= 1}
                    onClick={() => setUserPage((p) => Math.max(p - 1, 1))}
                    className="!h-7 text-xs font-bold"
                  >
                    Previous
                  </Button>
                  <span className="font-bold text-ink">Page {userPage}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={users.length < 15}
                    onClick={() => setUserPage((p) => p + 1)}
                    className="!h-7 text-xs font-bold"
                  >
                    Next
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: COMMUNITIES & ROOMS */}
        {activeTab === 'rooms' && (
          <div className="space-y-4">
            <div className="flex gap-3 items-center justify-between">
              <input
                type="text"
                placeholder="Search rooms by name..."
                value={roomSearch}
                onChange={(e) => setRoomSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadRooms();
                }}
                className="max-w-md w-full neo-pressed bg-surface-2/40 border border-glass-border/40 rounded-xl px-3.5 py-2 text-xs text-ink placeholder:text-ink-dim focus:outline-none focus:border-info"
              />
              <Button variant="secondary" size="sm" onClick={loadRooms} className="text-xs font-bold">
                Refresh Rooms
              </Button>
            </div>

            <div className="neo-raised rounded-2xl bg-surface-2/20 border border-glass-border/40 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs text-ink">
                  <thead className="bg-surface-2/50 border-b border-glass-border/30 text-[11px] font-bold uppercase tracking-wider text-ink-dim">
                    <tr>
                      <th className="px-4 py-3">Room Name</th>
                      <th className="px-4 py-3">Owner</th>
                      <th className="px-4 py-3">Members</th>
                      <th className="px-4 py-3">Join Policy</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Moderation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-glass-border/20">
                    {loadingRooms ? (
                      <tr>
                        <td colSpan={6} className="text-center py-12 text-ink-dim">
                          Loading communities...
                        </td>
                      </tr>
                    ) : rooms.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-12 text-ink-dim">
                          No rooms found.
                        </td>
                      </tr>
                    ) : (
                      rooms.map((r) => (
                        <tr key={r.id} className="hover:bg-surface-2/30 transition-colors">
                          <td className="px-4 py-3">
                            <div className="font-bold text-ink">{r.name}</div>
                            <div className="text-[10px] text-ink-dim">ID: {r.id.slice(0, 13)}…</div>
                          </td>
                          <td className="px-4 py-3 font-semibold text-ink">
                            @{r.owner.username}
                          </td>
                          <td className="px-4 py-3 text-ink-dim font-semibold">
                            {r.membersCount} / {r.maxMembers}
                          </td>
                          <td className="px-4 py-3">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-surface-2 text-ink-dim border border-glass-border">
                              {r.joinPolicy}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            {r.status === 'ACTIVE' ? (
                              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-positive/10 text-positive border border-positive/20">
                                Active {r.joinLocked && '· Joins Locked'}
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-danger/10 text-danger border border-danger/20">
                                {r.status}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleInspectRoom(r.id)}
                                className="!h-7 text-xs font-bold"
                              >
                                View
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleToggleJoinLock(r)}
                                className="!h-7 text-xs font-bold"
                              >
                                {r.joinLocked ? 'Unlock Joins' : 'Lock Joins'}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: SECURITY & AUDIT LOGS */}
        {activeTab === 'security' && (
          <div className="space-y-4">
            <div className="flex gap-2 border-b border-glass-border/40 pb-2">
              <button
                onClick={() => setSecurityTab('events')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  securityTab === 'events' ? 'neo-raised bg-surface text-ink' : 'text-ink-dim hover:text-ink'
                }`}
              >
                Security Incidents Feed
              </button>
              <button
                onClick={() => setSecurityTab('audits')}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  securityTab === 'audits' ? 'neo-raised bg-surface text-ink' : 'text-ink-dim hover:text-ink'
                }`}
              >
                Admin Audit Trail
              </button>
            </div>

            {securityTab === 'events' ? (
              <div className="neo-raised rounded-2xl bg-surface-2/20 border border-glass-border/40 overflow-hidden">
                <div className="divide-y divide-glass-border/20">
                  {loadingSecurity ? (
                    <div className="text-center py-12 text-xs text-ink-dim">Loading security stream...</div>
                  ) : securityEvents.length === 0 ? (
                    <div className="text-center py-12 text-xs text-ink-dim">No security events recorded.</div>
                  ) : (
                    securityEvents.map((evt) => (
                      <div key={evt.id} className="p-4 flex items-center justify-between text-xs hover:bg-surface-2/30">
                        <div className="flex items-center gap-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-danger/10 text-danger border border-danger/30">
                            {evt.eventType}
                          </span>
                          <div>
                            <div className="font-bold text-ink">
                              {evt.user ? `@${evt.user.username}` : 'System'} · {evt.user?.email || 'No email'}
                            </div>
                            <div className="text-[11px] text-ink-dim font-mono mt-0.5">
                              {evt.metadata ? JSON.stringify(evt.metadata) : 'No metadata'}
                            </div>
                          </div>
                        </div>
                        <span className="text-[11px] text-ink-dim shrink-0">
                          {new Date(evt.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="neo-raised rounded-2xl bg-surface-2/20 border border-glass-border/40 overflow-hidden">
                <div className="divide-y divide-glass-border/20">
                  {auditLogs.length === 0 ? (
                    <div className="text-center py-12 text-xs text-ink-dim">No administrative audit logs.</div>
                  ) : (
                    auditLogs.map((log) => (
                      <div key={log.id} className="p-4 flex items-center justify-between text-xs hover:bg-surface-2/30">
                        <div className="flex items-center gap-3">
                          <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-info/10 text-info border border-info/30">
                            {log.action}
                          </span>
                          <div>
                            <div className="font-bold text-ink">
                              Admin @{log.admin.username} → {log.targetType} {log.targetId ? `(${log.targetId.slice(0, 8)}…)` : ''}
                            </div>
                            <div className="text-[11px] text-ink-dim font-mono mt-0.5">
                              {log.details ? JSON.stringify(log.details) : 'None'} · IP: {log.ipAddress || 'Internal'}
                            </div>
                          </div>
                        </div>
                        <span className="text-[11px] text-ink-dim shrink-0">
                          {new Date(log.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 5: SYSTEM & MAINTENANCE */}
        {activeTab === 'system' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Telemetry card */}
              <div className="neo-raised p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40">
                <h2 className="text-sm font-bold uppercase tracking-wider text-ink mb-3 flex items-center gap-2">
                  <span>🖥️</span> Runtime Telemetry
                </h2>
                <div className="space-y-3 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-glass-border/20">
                    <span className="text-ink-dim font-medium">Node Environment</span>
                    <span className="font-bold text-ink">{process.env.NODE_ENV || 'production'}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-glass-border/20">
                    <span className="text-ink-dim font-medium">Node Version</span>
                    <span className="font-bold text-ink">{metrics?.system.nodeVersion}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-glass-border/20">
                    <span className="text-ink-dim font-medium">OS Platform</span>
                    <span className="font-bold text-ink">{metrics?.system.platform}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-glass-border/20">
                    <span className="text-ink-dim font-medium">Process Uptime</span>
                    <span className="font-bold text-ink">{formatDuration(metrics?.system.uptimeSeconds ?? 0)}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-glass-border/20">
                    <span className="text-ink-dim font-medium">Memory Heap (Used / Total)</span>
                    <span className="font-bold text-ink">
                      {metrics?.system.memory.heapUsedMb} MB / {metrics?.system.memory.heapTotalMb} MB
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5">
                    <span className="text-ink-dim font-medium">Database Latency</span>
                    <span className="font-bold text-positive">{metrics?.system.dbLatencyMs} ms</span>
                  </div>
                </div>
              </div>

              {/* Maintenance Sweeps Card */}
              <div className="neo-raised p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40 flex flex-col justify-between">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wider text-ink mb-1 flex items-center gap-2">
                    <span>🧹</span> Maintenance Control
                  </h2>
                  <p className="text-xs text-ink-dim mb-4">
                    Instantly purge data marked for destruction per the E2EE privacy agreement.
                  </p>

                  <div className="space-y-2.5">
                    <Button
                      variant="primary"
                      onClick={() => handleTriggerSweep('all')}
                      disabled={!!actionInProgress}
                      className="w-full text-xs font-bold !py-2.5"
                    >
                      {actionInProgress === 'sweep-all' ? 'Running full sweep…' : 'Execute Full System Sweep (All)'}
                    </Button>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => handleTriggerSweep('messages')}
                        disabled={!!actionInProgress}
                        className="text-xs font-bold"
                      >
                        Sweep Expired Messages
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => handleTriggerSweep('attachments')}
                        disabled={!!actionInProgress}
                        className="text-xs font-bold"
                      >
                        Sweep Orphan Uploads
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="mt-4 p-3 rounded-xl neo-pressed bg-surface-2/40 text-[11px] text-ink-dim">
                  Sweeps are also triggered automatically on the backend timer. Manual execution helps verify system responsiveness.
                </div>
              </div>
            </div>

            {/* Superadmin Bootstrap Card */}
            {role === 'SUPERADMIN' && (
              <div className="neo-raised p-5 rounded-2xl bg-surface-2/30 border border-glass-border/40">
                <h2 className="text-sm font-bold uppercase tracking-wider text-ink mb-1 flex items-center gap-2">
                  <span>👑</span> Superadmin Promotion Utility
                </h2>
                <p className="text-xs text-ink-dim mb-3">
                  Promote any user account to Superadmin directly using the server secret key.
                </p>

                <form onSubmit={handleBootstrap} className="flex flex-col sm:flex-row gap-3">
                  <input
                    type="password"
                    placeholder="Bootstrap Secret Key"
                    value={bootstrapSecret}
                    onChange={(e) => setBootstrapSecret(e.target.value)}
                    className="flex-1 neo-pressed bg-surface-2/40 border border-glass-border/40 rounded-xl px-3.5 py-2 text-xs text-ink focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Target Username or Email"
                    value={bootstrapTarget}
                    onChange={(e) => setBootstrapTarget(e.target.value)}
                    className="flex-1 neo-pressed bg-surface-2/40 border border-glass-border/40 rounded-xl px-3.5 py-2 text-xs text-ink focus:outline-none"
                  />
                  <Button type="submit" variant="primary" className="text-xs font-bold shrink-0">
                    Promote Account
                  </Button>
                </form>

                {bootstrapMsg && (
                  <div className="mt-3 text-xs font-semibold text-info">{bootstrapMsg}</div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* USER DIAGNOSTICS MODAL (SLIDE-OVER / DRAWER) */}
      {inspectUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="neo-raised max-w-2xl w-full rounded-2xl bg-surface p-6 border border-glass-border max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between pb-3 border-b border-glass-border/30 mb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-info/10 text-info font-black text-sm">
                  {inspectUser.user.username.charAt(0).toUpperCase()}
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink">@{inspectUser.user.username}</h3>
                  <span className="text-xs text-ink-dim font-mono">{inspectUser.user.id}</span>
                </div>
              </div>
              <button
                onClick={() => setInspectUser(null)}
                className="text-ink-dim hover:text-ink text-sm font-bold px-2 py-1"
              >
                ✕ Close
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-5 text-xs pr-1">
              {/* Account Stats */}
              <div className="grid grid-cols-3 gap-2.5">
                <div className="neo-pressed p-2.5 rounded-xl bg-surface-2/40 text-center">
                  <div className="text-[10px] uppercase font-bold text-ink-dim">Direct Messages</div>
                  <div className="text-base font-black text-ink">{inspectUser.user.stats.totalDirectMessages}</div>
                </div>
                <div className="neo-pressed p-2.5 rounded-xl bg-surface-2/40 text-center">
                  <div className="text-[10px] uppercase font-bold text-ink-dim">Rooms Joined</div>
                  <div className="text-base font-black text-ink">{inspectUser.user.stats.roomsJoined}</div>
                </div>
                <div className="neo-pressed p-2.5 rounded-xl bg-surface-2/40 text-center">
                  <div className="text-[10px] uppercase font-bold text-ink-dim">Active Devices</div>
                  <div className="text-base font-black text-positive">{inspectUser.user.stats.activeDevices}</div>
                </div>
              </div>

              {/* Registered Devices */}
              <div>
                <h4 className="font-bold uppercase tracking-wider text-ink-dim mb-2 text-[11px]">
                  Registered Cryptographic Devices ({inspectUser.devices.length})
                </h4>
                <div className="space-y-1.5">
                  {inspectUser.devices.map((d) => (
                    <div
                      key={d.id}
                      className="p-2 rounded-xl neo-pressed bg-surface-2/40 flex items-center justify-between text-[11px]"
                    >
                      <div>
                        <span className="font-bold text-ink">{d.deviceName || 'Unnamed Device'}</span>
                        <span className="ml-2 text-ink-dim uppercase">[{d.platform}]</span>
                        <div className="text-[10px] text-ink-dim font-mono">ID: {d.id}</div>
                      </div>
                      <span className="text-ink-dim">
                        {d.revokedAt ? (
                          <span className="text-danger font-bold">REVOKED</span>
                        ) : (
                          <span className="text-positive font-bold">ACTIVE</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Active Sessions */}
              <div>
                <h4 className="font-bold uppercase tracking-wider text-ink-dim mb-2 text-[11px]">
                  Active Authentication Sessions ({inspectUser.sessions.length})
                </h4>
                <div className="space-y-1.5 max-h-36 overflow-y-auto">
                  {inspectUser.sessions.map((s) => (
                    <div
                      key={s.id}
                      className="p-2 rounded-xl neo-pressed bg-surface-2/40 flex items-center justify-between text-[10px]"
                    >
                      <div className="truncate max-w-xs">
                        <span className="text-ink font-semibold">{s.userAgent || 'Unknown Agent'}</span>
                        <div className="text-ink-dim">Expires: {new Date(s.expiresAt).toLocaleDateString()}</div>
                      </div>
                      <span className={s.revokedAt ? 'text-danger font-bold' : 'text-positive font-bold'}>
                        {s.revokedAt ? 'Revoked' : 'Active'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick Actions Bar */}
              <div className="pt-3 border-t border-glass-border/30 flex flex-wrap gap-2 items-center justify-between">
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleRevokeSessions(inspectUser.user)}
                    className="text-xs font-bold"
                  >
                    Kill All Sessions
                  </Button>
                  {inspectUser.user.isLocked && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleUnlockUser(inspectUser.user)}
                      className="text-xs font-bold text-amber-500"
                    >
                      Unlock Account
                    </Button>
                  )}
                </div>

                <div className="flex gap-2">
                  {role === 'SUPERADMIN' && (
                    <select
                      value={inspectUser.user.role}
                      onChange={(e) => handleChangeRole(inspectUser.user, e.target.value as any)}
                      className="neo-pressed bg-surface-2/60 border border-glass-border/40 rounded-lg px-2 py-1 text-xs text-ink font-bold"
                    >
                      <option value="USER">Role: USER</option>
                      <option value="ADMIN">Role: ADMIN</option>
                      <option value="SUPERADMIN">Role: SUPERADMIN</option>
                    </select>
                  )}

                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleToggleUserStatus(inspectUser.user)}
                    className={`text-xs font-bold ${
                      inspectUser.user.status === 'ACTIVE' ? '!bg-danger text-white' : '!bg-positive text-white'
                    }`}
                  >
                    {inspectUser.user.status === 'ACTIVE' ? 'Ban User' : 'Reactivate User'}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ROOM DETAIL MODAL */}
      {inspectRoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="neo-raised max-w-xl w-full rounded-2xl bg-surface p-6 border border-glass-border max-h-[85vh] flex flex-col text-xs">
            <div className="flex items-center justify-between pb-3 border-b border-glass-border/30 mb-4">
              <div>
                <h3 className="text-base font-bold text-ink">{inspectRoom.room.name}</h3>
                <span className="text-[11px] text-ink-dim">Owner: @{inspectRoom.room.owner.username}</span>
              </div>
              <button
                onClick={() => setInspectRoom(null)}
                className="text-ink-dim hover:text-ink text-sm font-bold px-2 py-1"
              >
                ✕ Close
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4">
              <div>
                <h4 className="font-bold uppercase tracking-wider text-ink-dim mb-2 text-[11px]">
                  Room Members ({inspectRoom.members.length})
                </h4>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {inspectRoom.members.map((m) => (
                    <div
                      key={m.id}
                      className="p-2 rounded-xl neo-pressed bg-surface-2/40 flex items-center justify-between"
                    >
                      <span className="font-bold text-ink">@{m.username}</span>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-black uppercase tracking-wider bg-surface-2 text-ink-dim border border-glass-border">
                        {m.role}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {inspectRoom.joinRequests.length > 0 && (
                <div>
                  <h4 className="font-bold uppercase tracking-wider text-ink-dim mb-2 text-[11px]">
                    Pending Join Requests ({inspectRoom.joinRequests.length})
                  </h4>
                  <div className="space-y-1.5">
                    {inspectRoom.joinRequests.map((req) => (
                      <div
                        key={req.id}
                        className="p-2 rounded-xl neo-pressed bg-surface-2/40 flex items-center justify-between"
                      >
                        <span className="font-bold text-ink">@{req.requester.username}</span>
                        <span className="text-[10px] text-amber-500 font-bold uppercase">{req.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
