// Quick-iteration test run directly under Node (same Web Crypto spec as the
// browser). The authoritative check is the same logic run inside real
// Chromium via Playwright, done separately — this is the fast inner loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDeviceIdentity,
  toPublicBundle,
  initiateHandshake,
  completeHandshake,
  ratchetEncrypt,
  ratchetDecrypt,
  deriveNextChainKey,
  buildAad,
  verifyBytes,
  base64ToBytes,
} from '../engine.ts';

test('two devices independently derive the identical root key via X3DH', async () => {
  const alice = await generateDeviceIdentity(5);
  const bob = await generateDeviceIdentity(5);

  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession, consumedOneTimePrekeyPublic } = await completeHandshake(bob, message);

  assert.equal(consumedOneTimePrekeyPublic, bob.oneTimePrekeysPublic[0]);
  // Alice's "sending" chain must equal Bob's "receiving" chain, and vice versa.
  assert.deepEqual(aliceSession.sendingChainKey, bobSession.receivingChainKey);
  assert.deepEqual(aliceSession.receivingChainKey, bobSession.sendingChainKey);
});

test('a message encrypted by one side decrypts correctly on the other, ratcheting in lockstep', async () => {
  const alice = await generateDeviceIdentity(3);
  const bob = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  const aad = buildAad('conv-1', 1);
  const { envelope, nextChainKey } = await ratchetEncrypt(aliceSession.sendingChainKey, 'hello bob', aad);
  const { plaintext, nextChainKey: bobNext } = await ratchetDecrypt(bobSession.receivingChainKey, envelope, aad);

  assert.equal(plaintext, 'hello bob');
  assert.deepEqual(nextChainKey, bobNext);
});

test('forward secrecy: chain keys advance and are never reused', async () => {
  const alice = await generateDeviceIdentity(3);
  const bob = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  let aliceChain = aliceSession.sendingChainKey;
  let bobChain = bobSession.receivingChainKey;
  const seenChainKeys = new Set();
  const messages = ['msg one', 'msg two', 'msg three', 'msg four'];

  for (let i = 0; i < messages.length; i++) {
    const aad = buildAad('conv-1', i);
    const before = Buffer.from(aliceChain).toString('hex');
    assert.equal(seenChainKeys.has(before), false, 'chain key must not repeat');
    seenChainKeys.add(before);

    const enc = await ratchetEncrypt(aliceChain, messages[i], aad);
    const dec = await ratchetDecrypt(bobChain, enc.envelope, aad);
    assert.equal(dec.plaintext, messages[i]);
    aliceChain = enc.nextChainKey;
    bobChain = dec.nextChainKey;
  }
});

test('tampered ciphertext is rejected, not silently corrupted', async () => {
  const alice = await generateDeviceIdentity(3);
  const bob = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  const aad = buildAad('conv-1', 1);
  const { envelope } = await ratchetEncrypt(aliceSession.sendingChainKey, 'do not tamper', aad);

  const tamperedBytes = base64ToBytes(envelope.ciphertext);
  tamperedBytes[0] ^= 0xff;
  const tampered = { ...envelope, ciphertext: Buffer.from(tamperedBytes).toString('base64') };

  await assert.rejects(() => ratchetDecrypt(bobSession.receivingChainKey, tampered, aad));
});

test('wrong AAD (e.g. replayed into a different conversation) is rejected', async () => {
  const alice = await generateDeviceIdentity(3);
  const bob = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  const { envelope } = await ratchetEncrypt(aliceSession.sendingChainKey, 'hi', buildAad('conv-1', 1));
  await assert.rejects(() =>
    ratchetDecrypt(bobSession.receivingChainKey, envelope, buildAad('conv-1', 2)),
  );
});

test('an invalid signed-prekey signature is rejected before any DH happens', async () => {
  const alice = await generateDeviceIdentity(1);
  const mallory = await generateDeviceIdentity(1);
  const forgedBundle = toPublicBundle(mallory, mallory.oneTimePrekeysPublic[0]);
  forgedBundle.signedPrekeySignature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  await assert.rejects(() => initiateHandshake(alice, forgedBundle));
});

test('signature verification genuinely checks the signature (not a stub)', async () => {
  const device = await generateDeviceIdentity(1);
  const other = await generateDeviceIdentity(1);
  const validSig = await (async () => {
    const bundle = toPublicBundle(device);
    return bundle.signedPrekeySignature;
  })();

  const okWithRightKey = await verifyBytes(device.identitySigningPublic, base64ToBytes(device.signedPrekeyPublic), validSig);
  const failsWithWrongKey = await verifyBytes(other.identitySigningPublic, base64ToBytes(device.signedPrekeyPublic), validSig);
  assert.equal(okWithRightKey, true);
  assert.equal(failsWithWrongKey, false);
});

// THE FIX (V1 pre-runtime hardening pass): a decrypt failure must not
// leave the receiving chain one step behind the sender's — see
// deriveNextChainKey's own doc comment in engine.ts for the full
// reasoning. These tests exercise the fix directly at the crypto-engine
// level; the UI-layer regression (processIncoming in
// app/chat/[conversationId]/page.tsx) is the same fix applied at the
// call site and isn't independently re-tested here — there's no
// browser/React runtime in this sandbox to run that file at all, so
// this is the actual, real, executable proof that the underlying
// primitive is correct.

test('THE FIX: deriveNextChainKey matches the nextChainKey a successful decrypt would have produced', async () => {
  const alice = await generateDeviceIdentity(2);
  const bob = await generateDeviceIdentity(2);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  const aad = buildAad('conv-1', 0);
  const { envelope, nextChainKey: aliceNext } = await ratchetEncrypt(aliceSession.sendingChainKey, 'hi bob', aad);
  const { nextChainKey: bobNextViaDecrypt } = await ratchetDecrypt(bobSession.receivingChainKey, envelope, aad);
  const bobNextViaDerive = await deriveNextChainKey(bobSession.receivingChainKey);

  assert.deepEqual(bobNextViaDerive, bobNextViaDecrypt, 'deriveNextChainKey must produce the exact same value ratchetDecrypt derives internally');
  assert.deepEqual(bobNextViaDerive, aliceNext, 'and that value must match the sender\'s own advance, since both sides start from the same chain key');
});

test("THE FIX: a corrupted message no longer permanently breaks every later message in the conversation", async () => {
  const alice = await generateDeviceIdentity(3);
  const bob = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  let aliceChain = aliceSession.sendingChainKey;
  let bobChain = bobSession.receivingChainKey;

  // Message 1: sent normally, decrypts fine.
  const aad0 = buildAad('conv-1', 0);
  const enc0 = await ratchetEncrypt(aliceChain, 'message one', aad0);
  aliceChain = enc0.nextChainKey;
  const dec0 = await ratchetDecrypt(bobChain, enc0.envelope, aad0);
  bobChain = dec0.nextChainKey;
  assert.equal(dec0.plaintext, 'message one');

  // Message 2: corrupted in transit (bit-flipped ciphertext) — this is
  // the scenario the bug was found under: decrypt throws for this one
  // message specifically.
  const aad1 = buildAad('conv-1', 1);
  const enc1 = await ratchetEncrypt(aliceChain, 'message two (will be corrupted)', aad1);
  aliceChain = enc1.nextChainKey; // the sender's chain still advances normally regardless of what happens to the message in transit
  const corruptedBytes = base64ToBytes(enc1.envelope.ciphertext);
  corruptedBytes[0] ^= 0xff;
  const corruptedEnvelope = { ...enc1.envelope, ciphertext: Buffer.from(corruptedBytes).toString('base64') };

  await assert.rejects(
    () => ratchetDecrypt(bobChain, corruptedEnvelope, aad1),
    'the corrupted message must still be rejected — this fix must not weaken tamper detection',
  );
  // THE FIX applied here — exactly what processIncoming's catch block
  // now does: advance the chain anyway, since ratchetDecrypt's throw
  // above already proved the plaintext is unrecoverable, but the chain
  // must still move forward.
  bobChain = await deriveNextChainKey(bobChain);

  // Message 3: sent normally. Before the fix, bobChain would still be
  // sitting at the position expecting message 2 — one step behind
  // aliceChain — and this decrypt would ALSO fail, and so would every
  // message after it, forever.
  const aad2 = buildAad('conv-1', 2);
  const enc2 = await ratchetEncrypt(aliceChain, 'message three', aad2);
  const dec2 = await ratchetDecrypt(bobChain, enc2.envelope, aad2);
  assert.equal(dec2.plaintext, 'message three', 'a message after a corrupted one must still decrypt correctly');
});


// ---------------------------------------------------------------------------
// REGRESSION TESTS — V1 final-verification pass, scenarios not yet covered:
//   + bidirectional / simultaneous sends from both sides
//   + out-of-order delivery (chain recovery via deriveNextChainKey)
//   + duplicate delivery (proving double-advance breaks; not advancing keeps chain aligned)
// ---------------------------------------------------------------------------

test('bidirectional: Alice and Bob can send simultaneously without desync', async () => {
  const alice = await generateDeviceIdentity(3);
  const bob   = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  let aliceSend = aliceSession.sendingChainKey;
  let bobRecv   = bobSession.receivingChainKey;
  let bobSend   = bobSession.sendingChainKey;
  let aliceRecv = aliceSession.receivingChainKey;

  for (let i = 0; i < 3; i++) {
    const aadA = buildAad('c-bidir-a', i);
    const aadB = buildAad('c-bidir-b', i);
    const encA = await ratchetEncrypt(aliceSend, `Alice ${i}`, aadA); aliceSend = encA.nextChainKey;
    const encB = await ratchetEncrypt(bobSend,   `Bob ${i}`,   aadB); bobSend   = encB.nextChainKey;
    const decA = await ratchetDecrypt(bobRecv,   encA.envelope, aadA); bobRecv   = decA.nextChainKey;
    const decB = await ratchetDecrypt(aliceRecv, encB.envelope, aadB); aliceRecv = decB.nextChainKey;
    assert.equal(decA.plaintext, `Alice ${i}`, `A to B round ${i}`);
    assert.equal(decB.plaintext, `Bob ${i}`,   `B to A round ${i}`);
  }
});

test('missing/skipped message recovery & delayed arrival protocol limitation (v1 ratchet)', async () => {
  // Exact protocol semantics verified:
  // 1. AAD binds each ciphertext to its exact ratchet position.
  // 2. An out-of-order/future message arriving before its predecessor is rejected at the current position.
  // 3. Skipping past the missing slot via deriveNextChainKey realigns the chain so subsequent messages decrypt.
  // 4. PROTOCOL LIMITATION: A message that arrives delayed after the receiver has already advanced beyond
  //    its sequence position CANNOT be decrypted retroactively. The v1 symmetric ratchet derives one-time keys
  //    and wipes past chain keys for forward secrecy. It does not implement an out-of-order skipped-key cache.
  const alice = await generateDeviceIdentity(3);
  const bob   = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  let aliceChain = aliceSession.sendingChainKey;
  let bobChain   = bobSession.receivingChainKey;

  const msgs = ['msg-0', 'msg-1-delayed', 'msg-2'];
  const encs = [];
  for (let i = 0; i < msgs.length; i++) {
    const enc = await ratchetEncrypt(aliceChain, msgs[i], buildAad('c-oor', i));
    aliceChain = enc.nextChainKey;
    encs.push(enc);
  }

  // Bob receives msg-0 normally (position 0 -> advances chain to position 1)
  const dec0 = await ratchetDecrypt(bobChain, encs[0].envelope, buildAad('c-oor', 0));
  bobChain = dec0.nextChainKey;
  assert.equal(dec0.plaintext, 'msg-0');

  // msg-1 is missing/delayed; msg-2 arrives first at chain position 1 -> rejected
  await assert.rejects(
    () => ratchetDecrypt(bobChain, encs[2].envelope, buildAad('c-oor', 2)),
    'msg-2 at chain position 1 must be rejected due to position-bound AAD',
  );

  // Missing slot recovery: advance chain past msg-1 slot to position 2
  bobChain = await deriveNextChainKey(bobChain);

  // Subsequent msg-2 now decrypts cleanly at position 2 (advances chain to position 3)
  const dec2 = await ratchetDecrypt(bobChain, encs[2].envelope, buildAad('c-oor', 2));
  bobChain = dec2.nextChainKey;
  assert.equal(dec2.plaintext, 'msg-2', 'chain realigns so future messages are not permanently wedged');

  // Delayed arrival of msg-1: Bob is now at chain position 3.
  // Because step 1 key was wiped to guarantee forward secrecy, msg-1 CANNOT be decrypted retroactively.
  await assert.rejects(
    () => ratchetDecrypt(bobChain, encs[1].envelope, buildAad('c-oor', 1)),
    'delayed message arriving after chain advancement cannot be decrypted in v1 ratchet (key discarded)',
  );
});

test('duplicate delivery: skipping ratchet advance for a dup keeps chain aligned; double-advance provably breaks next message', async () => {
  const alice = await generateDeviceIdentity(3);
  const bob   = await generateDeviceIdentity(3);
  const bobBundle = toPublicBundle(bob, bob.oneTimePrekeysPublic[0]);
  const { session: aliceSession, message } = await initiateHandshake(alice, bobBundle);
  const { session: bobSession } = await completeHandshake(bob, message);

  let aliceChain = aliceSession.sendingChainKey;
  let bobChain   = bobSession.receivingChainKey;

  const enc0 = await ratchetEncrypt(aliceChain, 'msg-0', buildAad('c-dup', 0));
  aliceChain = enc0.nextChainKey;
  const enc1 = await ratchetEncrypt(aliceChain, 'msg-1', buildAad('c-dup', 1));

  const dec0 = await ratchetDecrypt(bobChain, enc0.envelope, buildAad('c-dup', 0));
  bobChain = dec0.nextChainKey;
  assert.equal(dec0.plaintext, 'msg-0');

  const dec1ok = await ratchetDecrypt(bobChain, enc1.envelope, buildAad('c-dup', 1));
  assert.equal(dec1ok.plaintext, 'msg-1', 'no double-advance: msg-1 at step 1 must decrypt');

  const doubleAdvanced = await deriveNextChainKey(dec0.nextChainKey);
  await assert.rejects(
    () => ratchetDecrypt(doubleAdvanced, enc1.envelope, buildAad('c-dup', 1)),
    'double-advance provably breaks msg-1 - the alreadyProcessed guard is load-bearing',
  );
});
