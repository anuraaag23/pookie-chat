// Regression tests for THE FIX found during the V1 pre-runtime
// hardening pass: an attachment upload that's never linked to a message
// (the client crashed, or the tab closed, between the upload finishing
// and send() being called) sat in the database — and in Google Drive —
// forever. download() already correctly refuses to serve an unlinked
// attachment to anyone (no message means no conversation to check
// membership against), so this was never a confidentiality problem, but
// it was an indefinite, invisible storage leak. The Prisma schema
// comment on Attachment.messageId had claimed since early in this
// project that "the same expiry job" handled this — it never did, for
// either job; this was found by checking that claim against the actual
// code, the same technique that has found several other "documented but
// never wired up" bugs across this project's history (GoogleDriveService
// .deleteFile, pairingCode.ts's lockout functions, disappearAt itself).
//
// AttachmentsService.cleanupOrphanedAttachments is new in this pass.
// Mirrors server.mjs's own mirror of it, same approach as every other
// regression file here.
import { createHarness } from './server.mjs';
import { randomUUID } from 'node:crypto';

const results = [];
function check(label, cond, detail = '') {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}${detail ? ' (' + detail + ')' : ''}`);
}

function isoMsAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

async function run() {
  const { server, db, cleanupOrphanedAttachments } = createHarness();
  await new Promise((r) => server.listen(0, r));

  // No HTTP/auth/pairing needed for this file — cleanupOrphanedAttachments
  // operates purely on the attachments table, so rows are seeded directly,
  // the same shortcut server.mjs's own comment on the attachments table
  // describes taking for the linked-attachment-cleanup tests in
  // regression-sync-fix.mjs.
  const conversationId = randomUUID();

  function seed({ messageId, ageMs }) {
    const id = randomUUID();
    db.prepare('INSERT INTO attachments (id, message_id, conversation_id, drive_file_id, uploaded_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      messageId,
      conversationId,
      `drive-file-${id}`,
      isoMsAgo(ageMs),
    );
    return id;
  }

  // ORPHANED_ATTACHMENT_MAX_AGE_MS is 5000 in the harness (see server.mjs)
  // vs. an hour in the real service — same "much shorter for a fast
  // deterministic test" pattern as EXPIRY_SWEEP_INTERVAL_MS elsewhere.
  const oldOrphan = seed({ messageId: null, ageMs: 10_000 }); // orphaned, past the cutoff
  const youngOrphan = seed({ messageId: null, ageMs: 1_000 }); // orphaned, but not old enough yet
  const linkedOldMessageId = randomUUID();
  const linkedOld = seed({ messageId: linkedOldMessageId, ageMs: 10_000 }); // old, but linked — must survive regardless of age

  const removedCount = cleanupOrphanedAttachments();
  check('THE FIX: an orphaned attachment past the cutoff is removed', removedCount === 1, `removed ${removedCount}`);

  const oldOrphanRow = db.prepare('SELECT * FROM attachments WHERE id = ?').get(oldOrphan);
  check('THE FIX: the old orphaned row is actually gone from the database', oldOrphanRow === undefined);

  const youngOrphanRow = db.prepare('SELECT * FROM attachments WHERE id = ?').get(youngOrphan);
  check('A recently-uploaded orphan (not yet past the cutoff) is left alone', !!youngOrphanRow);

  const linkedOldRow = db.prepare('SELECT * FROM attachments WHERE id = ?').get(linkedOld);
  check('An attachment linked to a message is never swept, no matter how old', !!linkedOldRow);

  // Running the sweep again immediately must be a safe no-op — nothing
  // left to remove, and no error from re-scanning an empty result set.
  const secondRun = cleanupOrphanedAttachments();
  check('Running the sweep again with nothing new to clean up is a safe no-op', secondRun === 0, `removed ${secondRun}`);

  // Simulates the young orphan later aging past the cutoff (rather than
  // sleeping 5 real seconds) — same "control the clock, not wall time"
  // approach as this file's own isoMsAgo helper already takes.
  db.prepare('UPDATE attachments SET uploaded_at = ? WHERE id = ?').run(isoMsAgo(10_000), youngOrphan);
  const thirdRun = cleanupOrphanedAttachments();
  check('An orphan that later crosses the age cutoff is swept on the next run', thirdRun === 1);
  check(
    'Only the newly-aged-out row was removed — the still-linked attachment is untouched',
    !!db.prepare('SELECT * FROM attachments WHERE id = ?').get(linkedOld),
  );

  // The DELETE's own `AND message_id IS NULL` guard (protection against
  // a genuine concurrent link-then-sweep race, where a row was selected
  // as orphaned but gets linked to a message before its individual
  // DELETE runs) is checked here at the SQL-pattern level, not by
  // exercising a real race through cleanupOrphanedAttachments() itself —
  // confirmed via mutation testing (temporarily dropping the guard from
  // server.mjs, then deleted) that no check in this file actually
  // depends on that guard: every currently-orphaned-and-old row this
  // suite constructs is already filtered out by the SELECT's own
  // `message_id IS NULL` before the guard would ever matter, and this
  // harness's SQLite backing runs fully synchronously with no await gap
  // between selection and each row's delete — a real concurrent request
  // landing in that gap isn't reproducible here, same documented
  // limitation as retryOnUniqueConflict's write-conflict tests in
  // regression-sync-fix.mjs. The guard is genuinely over-determined
  // against this suite's coverage (same category of finding as burn()'s
  // pending_handshakes cleanup in regression-handshake-burn-repair.mjs)
  // — kept in the real code as defense-in-depth for the race it targets,
  // not because a test here proves it fires.
  const raceId = seed({ messageId: null, ageMs: 10_000 });
  db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(randomUUID(), raceId); // "send() wins the race" — links it first
  db.prepare('DELETE FROM attachments WHERE id = ? AND message_id IS NULL').run(raceId); // the guard pattern itself, run directly
  check('The guarded-delete SQL pattern never matches a row linked out from under it', !!db.prepare('SELECT * FROM attachments WHERE id = ?').get(raceId));

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
