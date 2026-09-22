import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';

@Injectable()
export class ConnectionRegistryService {
  private readonly connections = new Map<string, Set<Socket>>();
  // Same sockets, indexed a second way: pushToUser/isOnline answer "is this
  // person reachable at all" (used for message delivery); pushToDevice/
  // isDeviceOnline/disconnectDevice answer "is THIS specific device
  // reachable" (used for the Devices & Sessions UI and remote logout,
  // which must never affect the caller's own other tabs of the same
  // device, let alone the user's other devices).
  private readonly deviceConnections = new Map<string, Set<Socket>>();

  // In-memory, single-process — same accepted trade-off as the HTTP
  // ThrottlerGuard (docs/05-ROADMAP.md's security-hardening phase covers
  // a production-grade distributed version for both, including this
  // registry: in a multi-instance deployment, online status and remote
  // disconnect would both need a shared store instead of this process's
  // own memory). Neither of these existed at all before: handleConnection
  // had no cap, and onTyping had no rate limit, despite requiring only a
  // valid access token to reach.
  private readonly MAX_SOCKETS_PER_USER = 8;
  private readonly typingWindows = new Map<string, { count: number; windowStart: number }>();
  private readonly TYPING_WINDOW_MS = 10_000;
  private readonly TYPING_MAX_PER_WINDOW = 30; // generous — far more than a human typing indicator could naturally trigger

  /** False means the cap was hit — the caller must disconnect the socket rather than register it. */
  register(userId: string, deviceId: string, socket: Socket): boolean {
    const existing = this.connections.get(userId) ?? new Set<Socket>();
    if (existing.size >= this.MAX_SOCKETS_PER_USER) return false;
    if (!this.connections.has(userId)) this.connections.set(userId, existing);
    existing.add(socket);
    const deviceExisting = this.deviceConnections.get(deviceId) ?? new Set<Socket>();
    if (!this.deviceConnections.has(deviceId)) this.deviceConnections.set(deviceId, deviceExisting);
    deviceExisting.add(socket);
    return true;
  }

  unregister(userId: string, deviceId: string, socket: Socket) {
    this.connections.get(userId)?.delete(socket);
    this.deviceConnections.get(deviceId)?.delete(socket);
  }

  /** Fixed 10s window, reset on the first call after it elapses. Returns false if the caller should drop this typing event rather than relay it. */
  allowTyping(userId: string): boolean {
    const now = Date.now();
    const window = this.typingWindows.get(userId);
    if (!window || now - window.windowStart > this.TYPING_WINDOW_MS) {
      this.typingWindows.set(userId, { count: 1, windowStart: now });
      return true;
    }
    if (window.count >= this.TYPING_MAX_PER_WINDOW) return false;
    window.count += 1;
    return true;
  }

  /** Returns true if at least one socket actually received it — the caller uses this to decide whether to stamp deliveredAt immediately or leave it for offline sync. */
  pushToUser(userId: string, event: string, payload: unknown): boolean {
    const sockets = this.connections.get(userId);
    if (!sockets || sockets.size === 0) return false;
    for (const socket of sockets) socket.emit(event, payload);
    return true;
  }

  /** Same as pushToUser but scoped to one device — used for SESSION_REVOKED, which must reach only the device being logged out. */
  pushToDevice(deviceId: string, event: string, payload: unknown): boolean {
    const sockets = this.deviceConnections.get(deviceId);
    if (!sockets || sockets.size === 0) return false;
    for (const socket of sockets) socket.emit(event, payload);
    return true;
  }

  /** Forcibly closes every live socket for one device — the actual mechanism behind "immediately disconnect the revoked device," not just marking it revoked in the database and waiting for it to notice. */
  disconnectDevice(deviceId: string) {
    const sockets = this.deviceConnections.get(deviceId);
    if (!sockets) return;
    for (const socket of sockets) socket.disconnect(true);
    // handleDisconnect's own unregister() call will clean these entries up
    // as each socket's disconnect event fires; not deleted eagerly here so
    // a socket that fails to close cleanly doesn't silently vanish from
    // bookkeeping before it's actually gone.
  }

  /**
   * SECURITY AUDIT F5: Forcibly closes every live socket for a user.
   * Invoked during account deletion to immediately terminate all active
   * WebSocket connections across all of that user's devices.
   */
  disconnectUser(userId: string) {
    const sockets = this.connections.get(userId);
    if (!sockets) return;
    for (const socket of Array.from(sockets)) socket.disconnect(true);
  }

  isOnline(userId: string): boolean {
    return (this.connections.get(userId)?.size ?? 0) > 0;
  }

  isDeviceOnline(deviceId: string): boolean {
    return (this.deviceConnections.get(deviceId)?.size ?? 0) > 0;
  }
}
