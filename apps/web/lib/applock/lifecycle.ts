import {
  isAppLockEnabled,
  isAppLocked,
  setAppLocked,
  getAppLockTimeoutSeconds,
  getAppLockVerifier,
  getLastActiveAt,
  recordActivity,
  resolveUserId,
} from './state.ts';
import { checkLocalSecret } from '../localauth/localSecret.ts';

export type AppLockState = 'disabled' | 'unlocked' | 'pending-departure' | 'locked';

export interface AppLockStorageAdapter {
  isAppLockEnabled: (userId?: string | null) => Promise<boolean>;
  isAppLocked: (userId?: string | null) => Promise<boolean>;
  setAppLocked: (locked: boolean, userId?: string | null) => Promise<void>;
  getAppLockTimeoutSeconds: (userId?: string | null) => Promise<number>;
  getAppLockVerifier: (userId?: string | null) => Promise<string | null>;
  getLastActiveAt: (userId?: string | null) => Promise<number>;
  recordActivity: (userId?: string | null, now?: number) => Promise<void>;
  checkLocalSecret: (input: string, storedVerifier: string | null) => Promise<boolean>;
}

export const defaultStorageAdapter: AppLockStorageAdapter = {
  isAppLockEnabled,
  isAppLocked,
  setAppLocked,
  getAppLockTimeoutSeconds,
  getAppLockVerifier,
  getLastActiveAt,
  recordActivity,
  checkLocalSecret,
};

export class AppLockStateMachine {
  private state: AppLockState = 'disabled';
  private userId: string | null = null;
  private departureStartedAt = 0;
  private departureTimer: any = null;
  private gracePeriodMs: number;
  private storage: AppLockStorageAdapter;
  private onStateChange?: (state: AppLockState) => void;

  constructor(options?: {
    gracePeriodMs?: number;
    storage?: AppLockStorageAdapter;
    onStateChange?: (state: AppLockState) => void;
  }) {
    this.gracePeriodMs = options?.gracePeriodMs ?? 1500;
    this.storage = options?.storage ?? defaultStorageAdapter;
    this.onStateChange = options?.onStateChange;
  }

  getState(): AppLockState {
    return this.state;
  }

  getUserId(): string | null {
    return this.userId;
  }

  private transition(next: AppLockState): void {
    if (this.state !== next) {
      this.state = next;
      this.onStateChange?.(next);
    }
  }

  private clearDepartureTimer(): void {
    if (this.departureTimer) {
      clearTimeout(this.departureTimer);
      this.departureTimer = null;
    }
  }

  async init(isProtected: boolean, userId: string | null, now = Date.now()): Promise<AppLockState> {
    this.clearDepartureTimer();
    this.userId = userId;

    if (!isProtected || !userId) {
      this.transition('disabled');
      return 'disabled';
    }

    const enabled = await this.storage.isAppLockEnabled(userId);
    if (!enabled) {
      this.transition('disabled');
      return 'disabled';
    }

    const locked = await this.storage.isAppLocked(userId);
    if (locked) {
      this.transition('locked');
      return 'locked';
    }

    const timeoutSeconds = await this.storage.getAppLockTimeoutSeconds(userId);
    const lastActiveAt = await this.storage.getLastActiveAt(userId);

    // Initial load: check if expired
    if (lastActiveAt > 0) {
      const elapsed = now - lastActiveAt;
      if (timeoutSeconds === 0) {
        if (elapsed >= this.gracePeriodMs) {
          await this.storage.setAppLocked(true, userId);
          this.transition('locked');
          return 'locked';
        }
      } else if (elapsed >= timeoutSeconds * 1000) {
        await this.storage.setAppLocked(true, userId);
        this.transition('locked');
        return 'locked';
      }
    }

    this.transition('unlocked');
    return 'unlocked';
  }

  async handleDeparture(source: 'hidden' | 'blur' | 'pagehide', now = Date.now()): Promise<void> {
    if (this.state !== 'unlocked') return;

    const timeout = await this.storage.getAppLockTimeoutSeconds(this.userId);
    if (this.state !== 'unlocked') return;

    if (timeout === 0) {
      this.departureStartedAt = now;
      this.transition('pending-departure');
      this.clearDepartureTimer();
      this.departureTimer = setTimeout(async () => {
        if (this.state === 'pending-departure') {
          await this.storage.setAppLocked(true, this.userId);
          this.transition('locked');
        }
      }, this.gracePeriodMs);
    }
  }

  async handleReturn(source: 'visible' | 'focus' | 'pageshow', now = Date.now()): Promise<AppLockState> {
    // 1. If already locked, return events NEVER unlock
    if (this.state === 'locked') {
      return 'locked';
    }

    // 2. If in pending departure (Immediately mode):
    if (this.state === 'pending-departure') {
      this.clearDepartureTimer();
      const elapsed = now - this.departureStartedAt;
      if (elapsed < this.gracePeriodMs) {
        // Transient blur/visibilitychange — cancel lock
        this.transition('unlocked');
        return 'unlocked';
      } else {
        // Departure lasted longer than grace period — commit lock
        await this.storage.setAppLocked(true, this.userId);
        this.transition('locked');
        return 'locked';
      }
    }

    // 3. If unlocked in timed mode, evaluate whether timeout elapsed while away
    if (this.state === 'unlocked' && this.userId) {
      const timeout = await this.storage.getAppLockTimeoutSeconds(this.userId);
      if (timeout > 0) {
        const lastActiveAt = await this.storage.getLastActiveAt(this.userId);
        if (lastActiveAt > 0 && now - lastActiveAt >= timeout * 1000) {
          await this.storage.setAppLocked(true, this.userId);
          this.transition('locked');
          return 'locked';
        }
      }
    }

    return this.state;
  }

  async handleUserActivity(now = Date.now()): Promise<void> {
    if (this.state === 'unlocked' && this.userId) {
      await this.storage.recordActivity(this.userId, now);
    }
  }

  async checkInactivity(now = Date.now()): Promise<AppLockState> {
    if (this.state === 'unlocked' && this.userId) {
      const timeout = await this.storage.getAppLockTimeoutSeconds(this.userId);
      if (timeout > 0) {
        const lastActiveAt = await this.storage.getLastActiveAt(this.userId);
        if (lastActiveAt > 0 && now - lastActiveAt >= timeout * 1000) {
          await this.storage.setAppLocked(true, this.userId);
          this.transition('locked');
          return 'locked';
        }
      }
    }
    return this.state;
  }

  async attemptUnlock(pin: string, now = Date.now()): Promise<boolean> {
    if (this.state !== 'locked') return true;
    if (!this.userId) return false;

    const verifier = await this.storage.getAppLockVerifier(this.userId);
    const ok = await this.storage.checkLocalSecret(pin, verifier);

    if (ok) {
      await this.storage.setAppLocked(false, this.userId);
      await this.storage.recordActivity(this.userId, now);
      this.transition('unlocked');
      return true;
    }
    return false;
  }

  async handleLogout(): Promise<void> {
    this.clearDepartureTimer();
    if (this.userId) {
      const enabled = await this.storage.isAppLockEnabled(this.userId);
      if (enabled) {
        await this.storage.setAppLocked(true, this.userId);
      }
    }
    this.userId = null;
    this.transition('disabled');
  }

  async handleLogin(newUserId: string, isProtected = true, now = Date.now()): Promise<AppLockState> {
    return this.init(isProtected, newUserId, now);
  }

  destroy(): void {
    this.clearDepartureTimer();
  }
}
