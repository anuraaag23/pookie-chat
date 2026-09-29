import { api } from '../api/client.ts';

export function isPushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'Notification' in window;
}

export function getNotificationPermission(): NotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'default';
  }
  return Notification.permission;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    return registration;
  } catch (err) {
    console.warn('Service worker registration failed:', err);
    return null;
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    await registerServiceWorker();
  }
  return permission;
}

export async function registerPushToken(token: string): Promise<void> {
  try {
    await api('/api/notifications/push-token', {
      method: 'POST',
      body: { pushToken: token },
    });
  } catch (err) {
    console.warn('Could not sync push token with server:', err);
  }
}

export async function sendLocalNotification(title: string, options: { body: string; icon?: string; badge?: string; url?: string }): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  // Use ServiceWorker registration.showNotification when available
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    if (reg && 'showNotification' in reg) {
      await reg.showNotification(title, {
        body: options.body,
        icon: options.icon || '/icon-192.png',
        badge: options.badge || '/badge.png',
        data: { url: options.url || '/chat' },
      });
      return;
    }
  }

  // Fallback to standard window Notification
  try {
    new Notification(title, {
      body: options.body,
      icon: options.icon || '/icon-192.png',
      badge: options.badge || '/badge.png',
    });
  } catch {
    // Best-effort
  }
}
