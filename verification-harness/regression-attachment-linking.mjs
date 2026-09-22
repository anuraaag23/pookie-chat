// Regression tests for THE FIX found during the final pre-runtime audit's
// API-contract inventory (backend routes vs. what the frontend actually
// sends): messages.service.ts's send() used to only call
// AttachmentsService.linkToMessage when BOTH dto.attachmentId AND
// dto.encryptedDek were present. Grepping the entire apps/web tree found
// zero references to `encryptedDek` anywhere — the real sendFile()
// (app/chat/[conversationId]/page.tsx) has only ever sent `attachmentId`,
// since the actual DEK already travels end-to-end inside the message's
// own ratchet-encrypted ciphertext. That meant every attachment sent
// through the real app silently failed to link to its message, and was
// swept away by the orphan-attachment cleanup an hour later — completely
// undownloadable by anyone, including the sender, the entire time.
//
// This bug was invisible to every prior harness check because the harness
// itself had NO attachment-linking logic in its /api/messages handler at
// all (fixed alongside this — see server.mjs's own comment on THE FIX),
// and every existing attachment-related test seeded the `attachments`
// table directly via SQL rather than driving a real POST through the
// actual endpoint the way sendFile() does. These tests exercise the real
// HTTP endpoint end to end instead.
import { createHarness } from './server.mjs';
import { randomUUID } from 'node:crypto';

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

  // No real X3DH handshake needed — attachment linking doesn't care
  // whether the ciphertext is genuinely decryptable, only that a message
  // row gets created with the given attachmentId. Registration still
  // uses random-but-correctly-shaped key material, matching the same
  // simplified pattern already established in
  // regression-pairing-code-collision.mjs / regression-refresh-logout.mjs.
  async function registerUser(name) {
    const result = await call(null, 'POST', '/api/auth/register', {
      password: `${name}-password-123`,
      username: `harness_${name}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      deviceName: name,
      platform: 'web',
      identityDhPublic: randomUUID(),
      identitySigningPublic: randomUUID(),
      signedPrekeyPublic: randomUUID(),
      signedPrekeySignature: randomUUID(),
      oneTimePrekeysPublic: [randomUUID()],
    });
    return result.data;
  }

  const alice = await registerUser('alice');
  const bob = await registerUser('bob');
  const pairing = await call(alice.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
  const redeemed = await call(bob.accessToken, 'POST', '/api/pairing/redeem', { code: pairing.data.code });
  const conversationId = redeemed.data.conversationId;
  check('Setup: Alice and Bob are paired', !!conversationId);

  function seedUploadedAttachment(uploaderId, convoId) {
    const id = randomUUID();
    db.prepare('INSERT INTO attachments (id, conversation_id, uploader_id, drive_file_id, uploaded_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      convoId,
      uploaderId,
      `drive-file-${id}`,
      new Date().toISOString(),
    );
    return id;
  }

  function sendMessagePayload(overrides = {}) {
    return {
      conversationId,
      clientMessageId: randomUUID(),
      ciphertext: 'not-real-ciphertext-attachment-linking-does-not-care',
      iv: 'AAAAAAAAAAAAAAAA',
      messageType: 'IMAGE',
      sessionEpoch: 1,
      ...overrides,
    };
  }

  // --- THE FIX: attachmentId alone (no encryptedDek) links successfully ---
  const attachmentId1 = seedUploadedAttachment(alice.userId, conversationId);
  const send1 = await call(alice.accessToken, 'POST', '/api/messages', sendMessagePayload({ attachmentId: attachmentId1 }));
  check('THE FIX: sending with only attachmentId (no encryptedDek — matches the real frontend exactly) succeeds', send1.status === 201);
  const row1 = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId1);
  check('THE FIX: the attachment is actually linked to the new message afterward', row1.message_id === send1.data.id);
  check('encrypted_dek correctly stays null when the client never sends one', row1.encrypted_dek === null);

  // --- encryptedDek is still accepted and stored when a client does provide one ---
  const attachmentId2 = seedUploadedAttachment(alice.userId, conversationId);
  const send2 = await call(alice.accessToken, 'POST', '/api/messages', sendMessagePayload({ attachmentId: attachmentId2, encryptedDek: 'c2FtcGxlLWRlaw==' }));
  check('Sending with both attachmentId and encryptedDek still succeeds', send2.status === 201);
  const row2 = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId2);
  check('encryptedDek is stored when the client does provide one', row2.encrypted_dek === 'c2FtcGxlLWRlaw==');

  // --- Ownership: cannot link an attachment someone else uploaded ---
  const attachmentId3 = seedUploadedAttachment(bob.userId, conversationId); // Bob uploaded it
  const send3 = await call(alice.accessToken, 'POST', '/api/messages', sendMessagePayload({ attachmentId: attachmentId3 })); // Alice tries to send it
  check('Cannot link an attachment uploaded by someone else', send3.status === 403);
  const row3 = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachmentId3);
  check('The attachment stays unlinked after a rejected ownership mismatch', row3.message_id === null);

  // --- Conversation mismatch: cannot link an attachment uploaded for a different conversation ---
  const bobOwnPairing = await call(bob.accessToken, 'POST', '/api/pairing/create', { durationSeconds: 900 });
  const carol = await registerUser('carol');
  const carolRedeemed = await call(carol.accessToken, 'POST', '/api/pairing/redeem', { code: bobOwnPairing.data.code });
  const otherConversationId = carolRedeemed.data.conversationId;
  const attachmentId4 = seedUploadedAttachment(alice.userId, otherConversationId); // uploaded for the Bob/Carol conversation
  const send4 = await call(alice.accessToken, 'POST', '/api/messages', sendMessagePayload({ attachmentId: attachmentId4 })); // sent into the Alice/Bob conversation
  check('Cannot link an attachment uploaded for a different conversation', send4.status === 403);

  // --- Double-linking: cannot re-link an already-linked attachment ---
  const send5 = await call(alice.accessToken, 'POST', '/api/messages', sendMessagePayload({ attachmentId: attachmentId1 })); // attachmentId1 is already linked from send1 above
  check('Cannot link an attachment that is already linked to a different message', send5.status === 403);

  // --- A nonexistent attachmentId is rejected cleanly, not a crash ---
  const send6 = await call(alice.accessToken, 'POST', '/api/messages', sendMessagePayload({ attachmentId: randomUUID() }));
  check('A nonexistent attachmentId is rejected with 404, not a 500', send6.status === 404);

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
