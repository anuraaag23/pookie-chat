import { idbGet, idbSet } from '../storage/localDb';

export interface ScheduledAttachment {
  ciphertextB64: string;
  dekB64: string;
  mimeTypeHint: 'image' | 'file';
  filename: string;
  originalSize: number;
  viewOnce?: boolean;
  caption?: string;
}

export interface ScheduledMessageItem {
  id: string;
  conversationId: string;
  isRoom?: boolean;
  text: string;
  attachment?: ScheduledAttachment;
  scheduledFor: number; // Unix timestamp in ms
  createdAt: number;
}

function getStoreKey(userId: string): string {
  return `scheduled_messages:${userId}`;
}

export async function getScheduledMessages(
  userId: string,
  conversationId?: string,
): Promise<ScheduledMessageItem[]> {
  try {
    const list = (await idbGet<ScheduledMessageItem[]>(getStoreKey(userId))) ?? [];
    if (conversationId) {
      return list.filter((m) => m.conversationId === conversationId);
    }
    return list;
  } catch {
    return [];
  }
}

export async function saveScheduledMessage(
  userId: string,
  item: ScheduledMessageItem,
): Promise<void> {
  const current = await getScheduledMessages(userId);
  const updated = [...current.filter((m) => m.id !== item.id), item];
  await idbSet(getStoreKey(userId), updated);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('scheduled-messages-changed', { detail: { conversationId: item.conversationId } }));
  }
}

export async function removeScheduledMessage(userId: string, id: string): Promise<void> {
  const current = await getScheduledMessages(userId);
  const updated = current.filter((m) => m.id !== id);
  await idbSet(getStoreKey(userId), updated);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('scheduled-messages-changed'));
  }
}

export async function getDueScheduledMessages(
  userId: string,
  conversationId?: string,
): Promise<ScheduledMessageItem[]> {
  const now = Date.now();
  const list = await getScheduledMessages(userId, conversationId);
  return list.filter((m) => m.scheduledFor <= now);
}
