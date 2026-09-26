/**
 * Formats the remaining time for a temporary conversation.
 * Examples:
 * - 42 seconds -> "00:42 remaining"
 * - 59 minutes 42 seconds -> "59:42 remaining"
 * - 2 hours 14 minutes 8 seconds -> "02:14:08 remaining"
 * - 1 day 6 hours 32 minutes -> "1d 06h 32m remaining"
 * - 0 or negative -> "00:00 remaining" (never displays negative numbers)
 */
export function formatCountdown(expiresAt: string | Date | number, nowMs: number = Date.now()): string {
  const expiryMs =
    typeof expiresAt === 'string'
      ? new Date(expiresAt).getTime()
      : typeof expiresAt === 'number'
      ? expiresAt
      : expiresAt.getTime();

  const diffMs = expiryMs - nowMs;
  if (diffMs <= 0 || isNaN(diffMs)) {
    return '00:00 remaining';
  }

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m remaining`;
  }
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} remaining`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} remaining`;
}

/**
 * Checks whether a temporary chat has expired.
 */
export function isTemporaryChatExpired(
  expiresAt: string | Date | number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const expiryMs =
    typeof expiresAt === 'string'
      ? new Date(expiresAt).getTime()
      : typeof expiresAt === 'number'
      ? expiresAt
      : expiresAt.getTime();
  return isNaN(expiryMs) || expiryMs <= nowMs;
}
