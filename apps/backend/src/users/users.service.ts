import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PublicUserResult {
  username: string;
  displayName: string | null;
}

export interface SearchResult {
  user: PublicUserResult | null;
  isSelf?: boolean;
}

// Mirrors PairingService's own canonicalPair (pairing.service.ts) — the
// same "always write/read the pair in sorted order" convention the
// Conversation.@@unique([userAId, userBId]) constraint depends on.
// Duplicated rather than imported: it's a two-line pure function, and
// importing across feature-module boundaries for something this small
// would be a bigger coupling than the four lines it saves.
function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Exact-match username lookup, gated by the target account's own
   * usernameSearchEnabled privacy setting — enforced HERE, server-side,
   * regardless of what the frontend does or doesn't show. Returns the
   * SAME shape (`{ user: null }`) whether the username doesn't exist at
   * all or belongs to a real account that has opted out of discovery —
   * a different response for those two cases would itself be the
   * privacy leak this is supposed to prevent (mirrors the existing
   * "generic invalid/expired" pattern PairingService already uses for
   * exactly this reason).
   *
   * This is also the single source of truth the frontend re-queries
   * immediately before acting on a "Start Chat" tap (see
   * apps/web/app/search/page.tsx) instead of trusting an
   * earlier-fetched, potentially-stale search result — the target may
   * have flipped their privacy setting, been deleted, or been blocked
   * in the time since the original search. There is no separate
   * "confirm before starting a chat" endpoint: calling this one again,
   * right before navigating into the existing pairing flow, IS that
   * re-check, so there's exactly one code path enforcing this instead
   * of two that could drift apart.
   */
  async searchByUsername(requesterUserId: string, username: string): Promise<SearchResult> {
    const target = await this.prisma.user.findUnique({
      where: { username },
      select: {
        id: true,
        username: true,
        displayName: true,
        status: true,
        settings: { select: { usernameSearchEnabled: true } },
      },
    });

    // Deleted/deactivated accounts are treated exactly like "doesn't
    // exist" here — same reasoning as above, no separate signal for
    // "used to exist."
    if (!target || target.status !== 'ACTIVE') return { user: null };

    if (target.id === requesterUserId) {
      // Self-search is harmless and deliberately distinguishable from a
      // real miss (the frontend shows "This is your username" rather
      // than "User not found") — but it never returns something a
      // client could use to start a self-chat, since self-chats aren't
      // a feature this app has ever supported.
      return { user: { username: target.username, displayName: target.displayName }, isSelf: true };
    }

    // A settings row may not exist yet for an account that has never
    // opened Settings — SettingsService.get() only lazily creates one on
    // first read (settings.service.ts). Absence here must mean the same
    // as the schema default (true, i.e. discoverable), never "treat as
    // private by omission," or every account that has simply never
    // visited Settings would silently vanish from search.
    const discoverable = target.settings?.usernameSearchEnabled ?? true;
    if (!discoverable) return { user: null };

    // Respect existing block semantics: if a conversation already exists
    // between these two accounts and either side has blocked the other,
    // this must not resurface them as a fresh "Start Chat" target. Same
    // generic response either way — never a signal for which side
    // blocked, matching this app's existing "never reveal who blocked
    // whom" convention (ConversationsService.unblock's own comment).
    const [userAId, userBId] = canonicalPair(requesterUserId, target.id);
    const existingConversation = await this.prisma.conversation.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
      select: { status: true },
    });
    if (existingConversation?.status === 'BLOCKED_BY_A' || existingConversation?.status === 'BLOCKED_BY_B') {
      return { user: null };
    }

    return { user: { username: target.username, displayName: target.displayName } };
  }
}
