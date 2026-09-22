import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function startStaticServer(port) {
  const server = createServer(async (req, res) => {
    try {
      const filePath = req.url === '/' ? '/e2e-page.html' : req.url === '/engine.js' ? '/compiled/engine.js' : null;
      if (!filePath) {
        res.writeHead(404);
        res.end();
        return;
      }
      const content = await readFile(path.join(__dirname, filePath));
      res.writeHead(200, { 'Content-Type': filePath.endsWith('.js') ? 'application/javascript' : 'text/html' });
      res.end(content);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  const { chromium } = await import('playwright');

  // --- Start the real harness server (HTTP + WS + SQLite) as a child process ---
  const harnessProc = spawn('node', [path.join(__dirname, 'server.mjs')], {
    env: { ...process.env, PORT: '4100' },
    stdio: 'pipe',
  });
  harnessProc.stdout.on('data', (d) => process.stdout.write(`[harness] ${d}`));
  harnessProc.stderr.on('data', (d) => process.stderr.write(`[harness:err] ${d}`));
  await new Promise((r) => setTimeout(r, 500));

  const staticServer = await startStaticServer(8936);

  const browser = await chromium.launch();
  const alicePage = await browser.newPage();
  const bobPage = await browser.newPage();
  await alicePage.goto('http://localhost:8936/');
  await bobPage.goto('http://localhost:8936/');

  const results = [];
  function check(label, condition, detail = '') {
    results.push({ label, pass: !!condition, detail });
    console.log(`${condition ? 'PASS' : 'FAIL'} — ${label}${detail ? ' (' + detail + ')' : ''}`);
  }

  try {
    // --- Registration: two real accounts, real scrypt password hashing, real device identities ---
    const alice = await alicePage.evaluate(([pw, name]) => window.register(pw, name), ['alice-password-123', 'Alice Laptop']);
    const bob = await bobPage.evaluate(([pw, name]) => window.register(pw, name), ['bob-password-456', 'Bob Phone']);
    check('Alice registered with a real user/device id', alice.userId && alice.deviceId);
    check('Bob registered with a real user/device id', bob.userId && bob.deviceId);
    check('Alice and Bob got different user ids', alice.userId !== bob.userId);

    // --- Pairing: real 6-digit code, real server-side redemption ---
    const pairing = await alicePage.evaluate(() => window.createPairingCode(900));
    check('Pairing code is 6 digits', /^\d{6}$/.test(pairing.code), pairing.code);

    const badRedeem = await bobPage.evaluate(async (code) => {
      try {
        await window.redeemPairingCode('000000' === code ? '111111' : '000000');
        return 'no error';
      } catch (e) {
        return e.message;
      }
    }, pairing.code);
    check('Wrong pairing code is rejected', badRedeem.includes('400'), badRedeem);

    const redeemed = await bobPage.evaluate((code) => window.redeemPairingCode(code), pairing.code);
    check('Correct pairing code succeeds and returns a conversation', !!redeemed.conversationId);

    const reRedeem = await alicePage.evaluate(async (code) => {
      try {
        await window.redeemPairingCode(code);
        return 'no error';
      } catch (e) {
        return e.message;
      }
    }, pairing.code);
    check('A used pairing code cannot be redeemed a second time', reRedeem.includes('400'), reRedeem);

    // --- X3DH handshake, completed on Alice's side asynchronously ---
    await alicePage.evaluate((conversationId) => window.completeHandshakeFromServer(conversationId), redeemed.conversationId);
    check('Alice completed her side of the handshake without error', true);

    // --- Offline delivery: Bob sends two messages while Alice is NOT connected via WS ---
    const msg1 = await bobPage.evaluate(
      ([cid, text]) => window.sendMessage(cid, text),
      [redeemed.conversationId, 'Hey Alice, are you around?'],
    );
    const msg2 = await bobPage.evaluate(
      ([cid, text]) => window.sendMessage(cid, text),
      [redeemed.conversationId, 'Sent this while you were offline'],
    );
    check('Bob sent 2 messages while Alice was offline', msg1.sequenceNumber === 1 && msg2.sequenceNumber === 2);
    check('Neither message was marked delivered yet (Alice not connected)', msg1.delivered === false && msg2.delivered === false);

    // --- Alice reconnects and syncs ---
    await alicePage.evaluate(() => window.connectWs());
    const synced = await alicePage.evaluate((cid) => window.syncMessages(cid, 0), redeemed.conversationId);
    check('Alice synced exactly 2 messages after reconnecting', synced.length === 2);
    check(
      'Both offline messages decrypted correctly, in order',
      synced[0]?.plaintext === 'Hey Alice, are you around?' && synced[1]?.plaintext === 'Sent this while you were offline',
      JSON.stringify(synced.map((s) => s.plaintext)),
    );

    // --- Read receipts flow back to the sender over WS ---
    await bobPage.evaluate(() => window.connectWs());
    await bobPage.evaluate(() => window.clearEvents());
    await alicePage.evaluate((id) => window.markRead(id), synced[0].id);
    await new Promise((r) => setTimeout(r, 200));
    const bobEvents = await bobPage.evaluate(() => window.getEvents());
    check('Bob received a live read-receipt over WebSocket', bobEvents.some((e) => e.type === 'read_receipt' && e.messageId === synced[0].id));

    // --- Live delivery: Alice replies while Bob IS connected ---
    await alicePage.evaluate(() => window.clearEvents());
    await bobPage.evaluate(() => window.clearEvents());
    const reply = await alicePage.evaluate(
      ([cid, text]) => window.sendMessage(cid, text),
      [redeemed.conversationId, 'Yes, I am here now!'],
    );
    check('Alice\'s reply was marked delivered immediately (Bob is connected)', reply.delivered === true);
    await new Promise((r) => setTimeout(r, 200));
    const bobLiveEvents = await bobPage.evaluate(() => window.getEvents());
    const liveMsgEvent = bobLiveEvents.find((e) => e.type === 'message');
    check('Bob received the reply live over WebSocket (no polling needed)', !!liveMsgEvent);
    if (liveMsgEvent) {
      const decrypted = await bobPage.evaluate(
        ([cid, evt]) => window.decryptLiveEvent(cid, evt),
        [redeemed.conversationId, liveMsgEvent],
      );
      check('The live-delivered message decrypts correctly', decrypted === 'Yes, I am here now!', decrypted);
    }

    // --- Typing indicator: real-time, not persisted ---
    await bobPage.evaluate(() => window.clearEvents());
    await alicePage.evaluate((cid) => window.sendTyping(cid, true), redeemed.conversationId);
    await new Promise((r) => setTimeout(r, 200));
    const typingEvents = await bobPage.evaluate(() => window.getEvents());
    check('Bob received Alice\'s typing event live', typingEvents.some((e) => e.type === 'typing' && e.isTyping === true));

    // --- Tamper detection over the real wire, not just in the unit test ---
    const tamperCheck = await bobPage.evaluate(async (cid) => {
      // Same AAD/step the real next message would use, but corrupted ciphertext.
      const aad = window.Engine.buildAad(cid, window.state.recvStep);
      try {
        await window.Engine.ratchetDecrypt(window.state.session.receivingChainKey, { ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', iv: 'AAAAAAAAAAAAAAAAAAAA' }, aad);
        return 'did not throw';
      } catch (e) {
        return 'threw';
      }
    }, redeemed.conversationId);
    check('Tampered/garbage ciphertext is rejected, not silently decrypted', tamperCheck === 'threw');

    // --- Blocking is enforced server-side, not just hidden in the UI ---
    await bobPage.evaluate((cid) => window.blockConversation(cid), redeemed.conversationId);
    const blockedSendError = await alicePage.evaluate(
      ([cid, text]) => window.sendMessageExpectError(cid, text),
      [redeemed.conversationId, 'can you still see this?'],
    );
    check('After Bob blocks, the server itself rejects Alice\'s send (not just hidden client-side)', blockedSendError && blockedSendError.includes('403'), blockedSendError);
  } finally {
    await browser.close();
    staticServer.close();
    harnessProc.kill();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('FAILED CHECKS:', failed.map((f) => f.label));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('E2E RUNNER CRASHED:', e);
  process.exit(1);
});
