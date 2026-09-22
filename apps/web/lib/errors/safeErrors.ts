export type ErrorCategory =
  | 'offline'
  | 'backend-unavailable'
  | 'not-found'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'server-error'
  | 'socket-disconnected'
  | 'unknown';

export interface SafeErrorInfo {
  category: ErrorCategory;
  title: string;
  message: string;
  actionType: 'retry' | 'home' | 'back' | 'reconnect';
}

const FORBIDDEN_WORDS = [
  'select',
  'insert',
  'update',
  'delete',
  'from',
  'where',
  'prisma',
  'postgres',
  'sql',
  'database',
  'table',
  'column',
  'constraint',
  'token',
  'secret',
  'password',
  'hash',
  'jwt',
  'at Object',
  'at Module',
  'at process',
  'node_modules',
  'internal/',
  'econnrefused',
  'enotfound',
];

/**
 * Ensures user-facing error strings never expose internal stack traces,
 * database errors, SQL statements, secrets, or framework details.
 */
export function isTechnicalOrSensitive(text: string): boolean {
  const lower = text.toLowerCase();
  return FORBIDDEN_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

/**
 * Maps any error (HTTP status, fetch network failure, unexpected runtime error,
 * or browser offline event) to a safe, user-friendly, and branded Pookie Chat
 * error presentation.
 */
export function getSafeErrorInfo(error: unknown): SafeErrorInfo {
  // 1. Browser is explicitly offline (guard with typeof window and strict false check for SSR/Node compatibility)
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      category: 'offline',
      title: 'No Internet Connection',
      message: 'Check your connection and try again.',
      actionType: 'retry',
    };
  }

  // 2. Check for HTTP status codes on ApiError or response-like objects
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status: unknown }).status
    : undefined;

  if (typeof status === 'number') {
    if (status === 401) {
      return {
        category: 'unauthorized',
        title: 'Session Expired',
        message: 'Your session has expired. Please sign in again.',
        actionType: 'home',
      };
    }
    if (status === 403) {
      return {
        category: 'forbidden',
        title: 'Access Denied',
        message: "You don't have permission to perform this action.",
        actionType: 'back',
      };
    }
    if (status === 404) {
      return {
        category: 'not-found',
        title: 'Page Not Found',
        message: "We couldn't find the page or resource you're looking for.",
        actionType: 'home',
      };
    }
    if (status === 429) {
      return {
        category: 'rate-limited',
        title: 'Too Many Requests',
        message: 'Too many attempts. Please wait a moment and try again.',
        actionType: 'retry',
      };
    }
    if (status >= 500 && status < 600) {
      return {
        category: 'server-error',
        title: 'Service Unavailable',
        message: 'Pookie Chat is temporarily unavailable. Please try again in a few moments.',
        actionType: 'retry',
      };
    }
  }

  // 3. Network connection / fetch failures
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';

  const isNetworkFailure =
    error instanceof TypeError &&
    /failed to fetch|network|load failed|fetch failed/i.test(rawMessage);

  if (isNetworkFailure || /econnrefused|enotfound/i.test(rawMessage)) {
    return {
      category: 'backend-unavailable',
      title: "Can't Connect",
      message: 'Pookie Chat is having trouble connecting right now. Please try again.',
      actionType: 'retry',
    };
  }

  // 4. Fallback safe error
  return {
    category: 'unknown',
    title: 'Something Went Wrong',
    message: "We couldn't complete that action. Please try again.",
    actionType: 'retry',
  };
}
