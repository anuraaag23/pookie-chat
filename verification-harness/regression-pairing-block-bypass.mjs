// Regression tests for SECURITY AUDIT FINDING F1 (HIGH):
// pairing.service.ts's redeem() used to reactivate an existing
// BLOCKED_BY_A/BLOCKED_BY_B conversation, because its conversation.upsert
// update branch set status: 'ACTIVE' with no check of the row's *current*
// status first. Mirrored in this harness's own /api/pairing/redeem handler
// (same bug, same fix — see server.mjs). The required invariant, per
// conversations.service.ts's unblock() (already correct, already shipped):
// only the person who initiated a block may lift it. Redeeming a fresh
// pairing code must never be a side-channel around that.
//
// This file also adds the harness's first working /api/conversations/:id/
// unblock route (mirroring ConversationsService.unblock exactly) — the only
// prior reference to "unblock" in this repo (regression-sync-fix.mjs) called
// a route that didn't exist and never checked the result. Without a real
// unblock, there's no way to drive the "legitimate unblock still works"
// half of this fix's own required coverage (item F below) over real HTTP.
//
// Honesty note on concurrency (item G/consistent with this engagement's
// established methodology — see regression-pairing-code-collision.mjs's own
// header for the same caveat applied to a different fix): node:sqlite's
// DatabaseSync runs every statement in a request handler synchronously with
// no `await` in between, so there is no genuine interleaving window inside
// a single request for a "concurrent" test to land in — anything claiming
// to test a real race here would not actually be exercising one. What CAN
// be verified, and is verified below: (1) the block check in server.mjs
// runs and rejects before the pairing code is ever marked USED — there is
// no window, real or simulated, where it half-applies; (2) the real
// pairing.service.ts fix (code-review-only, like every Prisma/$transaction
// change this entire engagement, per apps/backend never having a working
// npm install/Postgres in any sandbox) uses the exact same WHERE-guard
// compare-and-swap idiom already proven race-safe for the pairing code's
// own concurrent-redeem protection a few lines above it in the same
// function — not a new, unproven pattern.
import { createHarness } from './server.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const results = [];
function check(label, cond, detail = '') {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${detail ? ' (' + detail + ')' : ''}`);
}

async function run() {
  const { server, db } = createHarness();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  async function call(token, method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  // No real X3DH handshake is needed to exercise redeem()'s block check —
  // it runs before any crypto bundle is even assembled — so registration
  // is stubbed down to the minimum register() needs, same as
  // regression-pairing-code-collision.mjs.
  async function registerUser(label) {
    const result = await call(null, 'POST', '/api/auth/register', {
      password: 'correct horse battery staple',
      username: `harness_${label}_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      deviceName: `${label}-device`,
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
    });
    return { userId: result.data.userId, accessToken: result.data.accessToken };
  }

  const createPairing = (token) => call(token, 'POST', '/api/pairing/create', { durationSeconds: 900 });
  const redeem = (token, code) => call(token, 'POST', '/api/pairing/redeem', { code });
  const block = (token, conversationId) => call(token, 'POST', `/api/conversations/${conversationId}/block`, {});
  const unblock = (token, conversationId) => call(token, 'POST', `/api/conversations/${conversationId}/unblock`, {});
  const status = (token, conversationId) => call(token, 'GET', `/api/conversations/${conversationId}`, undefined);
  const pairingCodeRow = (pairingId) => db.prepare('SELECT status, used_by_user_id FROM pairing_codes WHERE id = ?').get(pairingId);

  // ============================================================
  // Baseline pairing so there's an established, ACTIVE conversation to
  // block — mirrors the audit's attack scenario setup exactly.
  // ============================================================
  const alice = await registerUser('alice');
  const bob = await registerUser('bob');

  const initialPairing = await createPairing(alice.accessToken);
  const initialRedeem = await redeem(bob.accessToken, initialPairing.data.code);
  const conversationId = initialRedeem.data.conversationId;
  check('Setup: initial pairing succeeds', initialRedeem.status === 200 && !!conversationId);
  check('Setup: a brand-new conversation starts at epoch 1', initialRedeem.data.sessionEpoch === 1, `got ${initialRedeem.data.sessionEpoch}`);

  // ============================================================
  // A. Bob blocks Alice.
  // ============================================================
  const blockResult = await block(bob.accessToken, conversationId);
  check('A. Bob can block the conversation', blockResult.status === 200);
  const statusAfterBlock = await status(bob.accessToken, conversationId);
  check(
    'A. Conversation is now BLOCKED_BY_B (Bob is user_b in canonical order here) or BLOCKED_BY_A — some blocked status either way',
    statusAfterBlock.data.status === 'BLOCKED_BY_A' || statusAfterBlock.data.status === 'BLOCKED_BY_B',
    `got ${statusAfterBlock.data.status}`,
  );
  const blockedStatus = statusAfterBlock.data.status;
  const epochAtBlockTime = statusAfterBlock.data.sessionEpoch;
  check('A. Blocking alone does not change sessionEpoch', epochAtBlockTime === 1, `got ${epochAtBlockTime}`);

  // ============================================================
  // B, C, D, E. Alice (the blocked party) generates a brand-new pairing
  // code and gets Bob (the blocker) to redeem it — the exact attack
  // scenario from the audit report. This must fail, with the generic
  // error, the conversation untouched, and the epoch untouched.
  // ============================================================
  const attackPairing = await createPairing(alice.accessToken);
  const attackRedeem = await redeem(bob.accessToken, attackPairing.data.code);

  check('B. THE FIX: a new pairing code from the blocked party cannot reactivate the conversation', attackRedeem.status === 400, `got status ${attackRedeem.status}`);
  check(
    'C. The response is the exact same generic message used for every other invalid/expired code — no signal that the code was valid or that a block exists',
    attackRedeem.data.error === 'Invalid or expired code',
    `got ${JSON.stringify(attackRedeem.data)}`,
  );

  const statusAfterAttack = await status(bob.accessToken, conversationId);
  check('D. Conversation status is completely unchanged after the rejected redemption', statusAfterAttack.data.status === blockedStatus, `got ${statusAfterAttack.data.status}`);
  check('E. sessionEpoch does not change because of the rejected redemption', statusAfterAttack.data.sessionEpoch === epochAtBlockTime, `got ${statusAfterAttack.data.sessionEpoch}`);

  const attackCodeRow = pairingCodeRow(attackPairing.data.pairingId);
  check(
    'Requirement 3: the rejected redemption does not consume (even partially) the pairing code — still ACTIVE, still unredeemed',
    attackCodeRow?.status === 'ACTIVE' && attackCodeRow?.used_by_user_id === null,
    `got ${JSON.stringify(attackCodeRow)}`,
  );

  // A second, independent attempt with a fresh code confirms this isn't a
  // one-shot fluke of the specific code above.
  const secondAttackPairing = await createPairing(alice.accessToken);
  const secondAttackRedeem = await redeem(bob.accessToken, secondAttackPairing.data.code);
  check('Repeat attack attempt (fresh code) is also rejected', secondAttackRedeem.status === 400 && secondAttackRedeem.data.error === 'Invalid or expired code');

  // The reverse direction — Bob (the blocker) generating a code and Alice
  // (the blocked party) redeeming it — must be rejected identically. The
  // invariant is about the *conversation's* blocked status, not about who
  // happens to hold the code this time.
  const reverseDirectionPairing = await createPairing(bob.accessToken);
  const reverseDirectionRedeem = await redeem(alice.accessToken, reverseDirectionPairing.data.code);
  check(
    'Reverse direction: a code from the blocker, redeemed by the blocked party, is also rejected while blocked',
    reverseDirectionRedeem.status === 400 && reverseDirectionRedeem.data.error === 'Invalid or expired code',
  );

  // ============================================================
  // The blocked party cannot lift their own block via the unblock
  // endpoint either — reinforces that only Bob (whoever actually holds
  // the block) can undo it, the exact invariant F1 protects.
  // ============================================================
  const aliceTriesUnblock = await unblock(alice.accessToken, conversationId);
  check('Alice (the blocked party, not the blocker) cannot unblock', aliceTriesUnblock.status === 403, `got ${aliceTriesUnblock.status}`);
  const statusAfterWrongUnblock = await status(bob.accessToken, conversationId);
  check('Conversation remains blocked after the wrong party\'s unblock attempt', statusAfterWrongUnblock.data.status === blockedStatus);

  // ============================================================
  // F. A legitimate unblock (by whoever actually blocked) still allows
  // the normal pairing/reconnection flow afterward.
  // ============================================================
  const legitUnblock = await unblock(bob.accessToken, conversationId);
  check('F. The actual blocker can unblock', legitUnblock.status === 200, `got ${legitUnblock.status}`);
  const statusAfterUnblock = await status(bob.accessToken, conversationId);
  check('F. Conversation is ACTIVE again after a legitimate unblock', statusAfterUnblock.data.status === 'ACTIVE', `got ${statusAfterUnblock.data.status}`);
  check('F. Unblocking alone does not bump sessionEpoch (only a subsequent redemption does)', statusAfterUnblock.data.sessionEpoch === epochAtBlockTime);

  const postUnblockPairing = await createPairing(alice.accessToken);
  const postUnblockRedeem = await redeem(bob.accessToken, postUnblockPairing.data.code);
  check('F. After a legitimate unblock, a fresh pairing code redeems successfully', postUnblockRedeem.status === 200, `got ${postUnblockRedeem.status}`);
  check('F. Post-unblock redemption reuses the same conversation', postUnblockRedeem.data.conversationId === conversationId);
  check('F. Post-unblock redemption correctly bumps sessionEpoch', postUnblockRedeem.data.sessionEpoch === epochAtBlockTime + 1, `got ${postUnblockRedeem.data.sessionEpoch}`);
  const statusAfterRepair = await status(bob.accessToken, conversationId);
  check('F. Conversation is ACTIVE after the post-unblock re-pair', statusAfterRepair.data.status === 'ACTIVE');

  // ============================================================
  // Preserve normal behavior: genuinely new pairing between two users who
  // have never had any conversation at all is completely unaffected.
  // ============================================================
  const carol = await registerUser('carol');
  const dave = await registerUser('dave');
  const freshPairing = await createPairing(carol.accessToken);
  const freshRedeem = await redeem(dave.accessToken, freshPairing.data.code);
  check('Preserved: a genuinely new pairing (no prior conversation) still succeeds', freshRedeem.status === 200 && freshRedeem.data.sessionEpoch === 1, `got ${JSON.stringify(freshRedeem.data)}`);

  // ============================================================
  // Preserve normal behavior: re-pairing an ACTIVE (never blocked)
  // conversation still works and still bumps the epoch — the fix must
  // only ever exclude the two blocked statuses, nothing else.
  // ============================================================
  const activeConvoId = freshRedeem.data.conversationId;
  const activeRepair = await createPairing(carol.accessToken);
  const activeRepairRedeem = await redeem(dave.accessToken, activeRepair.data.code);
  check('Preserved: re-pairing an already-ACTIVE conversation still succeeds', activeRepairRedeem.status === 200);
  check('Preserved: re-pairing an already-ACTIVE conversation still bumps sessionEpoch', activeRepairRedeem.data.sessionEpoch === 2, `got ${activeRepairRedeem.data.sessionEpoch}`);
  check('Preserved: re-pairing an already-ACTIVE conversation reuses the same conversationId', activeRepairRedeem.data.conversationId === activeConvoId);

  // ============================================================
  // Preserve normal behavior: an expired code and an already-used code
  // still hit their own pre-existing rejection paths, unaffected by
  // where the new block check was inserted.
  // ============================================================
  const expiringPairing = await createPairing(carol.accessToken);
  db.prepare("UPDATE pairing_codes SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), expiringPairing.data.pairingId);
  const expiredRedeem = await redeem(dave.accessToken, expiringPairing.data.code);
  check('Preserved: an expired code is still rejected with the generic message', expiredRedeem.status === 400 && expiredRedeem.data.error === 'Invalid or expired code');

  const reuseAttempt = await redeem(dave.accessToken, freshPairing.data.code); // already USED above
  check('Preserved: an already-used code is still rejected with the generic message', reuseAttempt.status === 400 && reuseAttempt.data.error === 'Invalid or expired code');

  const selfPairAttempt = await createPairing(carol.accessToken);
  const selfPairRedeem = await redeem(carol.accessToken, selfPairAttempt.data.code);
  check('Preserved: pairing with yourself is still its own distinct rejection, not the generic one', selfPairRedeem.status === 400 && selfPairRedeem.data.error === 'Cannot pair with yourself');

  // ============================================================
  // Static wiring check: the redeem handler's own source actually
  // contains the block-status guard, so a future edit that removes the
  // guard while leaving everything else untouched cannot silently pass
  // just because no test above happens to be run.
  // ============================================================
  const serverSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'server.mjs'), 'utf8');
  const redeemHandlerMatch = serverSource.match(/'\/api\/pairing\/redeem'\) \{[\s\S]*?\n {6}\}\n\n {6}\/\/ -+ Handshake/);
  check(
    "Static check: the /api/pairing/redeem handler's own source checks for BLOCKED_BY_A/BLOCKED_BY_B before reactivating",
    !!redeemHandlerMatch && redeemHandlerMatch[0].includes('BLOCKED_BY_A') && redeemHandlerMatch[0].includes('BLOCKED_BY_B'),
  );

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
