// Regression tests for multi-device session management (Devices &
// Sessions, remote logout, revocation enforcement). Mirrors the real
// backend's auth.service.ts/access-token.guard.ts/realtime.gateway.ts
// logic in server.mjs so these run against real HTTP + real WebSocket
// connections, not a simulation of the logic in isolation.
import { createHarness } from './server.mjs';
import * as Engine from '../apps/web/lib/crypto/engine.ts';

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
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  function openWs(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}?token=${encodeURIComponent(token)}`);
      let closed = false;
      ws.addEventListener('close', () => {
        closed = true;
      });
      ws.addEventListener('open', () => {
        // Same timing caveat as the WS-rate-limit tests in
        // regression-sync-fix.mjs: the protocol handshake can complete
        // (firing 'open') before the server's application code decides
        // to reject and disconnect.
        setTimeout(() => resolve(closed ? null : ws), 50);
      });
      ws.addEventListener('error', reject);
    });
  }

  async function registerDevice(userId, password, identity, deviceName, platform = 'web') {
    const bundle = Engine.toPublicBundle(identity);
    const body = { deviceName, platform, ...bundle, oneTimePrekeysPublic: identity.oneTimePrekeysPublic };
    if (userId) {
      return (await call(null, 'POST', '/api/auth/login', { userId, password, ...body })).data;
    }
    const username = `harness_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return (await call(null, 'POST', '/api/auth/register', { password, username, ...body })).data;
  }

  // --- Alice registers her first device ---
  const aliceLaptopIdentity = await Engine.generateDeviceIdentity(3);
  const alice = await registerDevice(null, 'alice-pw-123', aliceLaptopIdentity, 'Laptop');

  // --- Session listing: shape and current-device identification ---
  let sessions = (await call(alice.accessToken, 'GET', '/api/auth/sessions')).data;
  check('Session listing: exactly 1 session right after first register', sessions.length === 1, `${sessions.length}`);
  check('Session listing: the only session is correctly flagged as the current device', sessions[0]?.isCurrentDevice === true);
  check('Session listing: offline before any WebSocket connects', sessions[0]?.online === false);
  check('Session listing: exposes deviceName/platform/createdAt/lastSeenAt for the frontend to consume', typeof sessions[0]?.deviceName === 'string' && typeof sessions[0]?.platform === 'string' && !!sessions[0]?.createdAt && !!sessions[0]?.lastSeenAt);

  // --- Real online status: reflects an actual WebSocket connection ---
  const wsLaptop = await openWs(alice.accessToken);
  await new Promise((r) => setTimeout(r, 60));
  sessions = (await call(alice.accessToken, 'GET', '/api/auth/sessions')).data;
  check('Online status: flips to true once the device has an active WebSocket connection', sessions.find((s) => s.deviceId === alice.deviceId)?.online === true);
  const lastSeenWhileOnline = sessions.find((s) => s.deviceId === alice.deviceId)?.lastSeenAt;

  wsLaptop.close();
  await new Promise((r) => setTimeout(r, 60));
  sessions = (await call(alice.accessToken, 'GET', '/api/auth/sessions')).data;
  check('Online status: flips back to false once the WebSocket actually disconnects', sessions.find((s) => s.deviceId === alice.deviceId)?.online === false);
  check('lastSeenAt updates on disconnect, not just on connect', sessions.find((s) => s.deviceId === alice.deviceId)?.lastSeenAt >= lastSeenWhileOnline);

  // --- Stable device identity: re-login with the same keys reuses the device ---
  const reLogin = await registerDevice(alice.userId, 'alice-pw-123', aliceLaptopIdentity, 'Laptop');
  check('Stable device identity: re-login with the same identity keys returns the same deviceId', reLogin.deviceId === alice.deviceId, `original=${alice.deviceId} relogin=${reLogin.deviceId}`);
  sessions = (await call(reLogin.accessToken, 'GET', '/api/auth/sessions')).data;
  const distinctDeviceIds = new Set(sessions.map((s) => s.deviceId));
  check('Stable device identity: no duplicate device row was created for the same browser install', distinctDeviceIds.size === 1, `${distinctDeviceIds.size} distinct devices across ${sessions.length} sessions`);

  // --- A genuinely different device (different keys) gets its own identity ---
  const alicePhoneIdentity = await Engine.generateDeviceIdentity(3);
  const alicePhone = await registerDevice(alice.userId, 'alice-pw-123', alicePhoneIdentity, 'Phone', 'android');
  check('A genuinely new device (different identity keys) is not conflated with the existing one', alicePhone.deviceId !== alice.deviceId);

  const wsPhone = await openWs(alicePhone.accessToken);
  await new Promise((r) => setTimeout(r, 60));

  // --- Immediate remote logout: Device A (laptop) logs out Device B (phone) ---
  sessions = (await call(reLogin.accessToken, 'GET', '/api/auth/sessions')).data;
  const phoneSession = sessions.find((s) => s.deviceId === alicePhone.deviceId);
  check('The phone session is visible to the laptop before revoke', !!phoneSession);

  let phoneGotRevokedEvent = false;
  wsPhone.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'session_revoked') phoneGotRevokedEvent = true;
  });
  let phoneSocketClosed = false;
  wsPhone.addEventListener('close', () => {
    phoneSocketClosed = true;
  });

  const revokeResult = await call(reLogin.accessToken, 'DELETE', `/api/auth/sessions/${phoneSession.id}`);
  check('Revoke request succeeds', revokeResult.status === 200, `status ${revokeResult.status}`);
  await new Promise((r) => setTimeout(r, 500)); // the scheduled disconnect (250ms) plus delivery time

  check('THE FIX: SESSION_REVOKED is delivered to the revoked device before it disconnects', phoneGotRevokedEvent);
  check('THE FIX: the revoked device\'s WebSocket is force-disconnected immediately, not left to expire naturally', phoneSocketClosed);

  const afterRevokeHttp = await call(alicePhone.accessToken, 'GET', '/api/auth/sessions');
  check(
    'THE FIX: a revoked device\'s access token is rejected on its very next HTTP request, even though the JWT itself has not expired',
    afterRevokeHttp.status === 401,
    `status ${afterRevokeHttp.status}`,
  );

  const reconnectAttempt = await openWs(alicePhone.accessToken);
  check('THE FIX: a revoked device cannot reconnect via WebSocket using its still-cryptographically-valid token', reconnectAttempt === null);

  // --- Idempotent repeated revoke ---
  const secondRevoke = await call(reLogin.accessToken, 'DELETE', `/api/auth/sessions/${phoneSession.id}`);
  check('Idempotent: revoking an already-revoked session succeeds rather than erroring', secondRevoke.status === 200, `status ${secondRevoke.status}`);

  // --- Authorization: a different user cannot revoke Alice's session by ID ---
  const charlieIdentity = await Engine.generateDeviceIdentity(3);
  const charlie = await registerDevice(null, 'charlie-pw-999', charlieIdentity, 'Charlie-Device');
  sessions = (await call(reLogin.accessToken, 'GET', '/api/auth/sessions')).data;
  const aliceLaptopSessionId = sessions.find((s) => s.deviceId === alice.deviceId).id;
  const crossUserRevoke = await call(charlie.accessToken, 'DELETE', `/api/auth/sessions/${aliceLaptopSessionId}`);
  check(
    'Unauthorized: a different user cannot revoke another user\'s session by changing the session ID',
    crossUserRevoke.status === 404,
    `status ${crossUserRevoke.status}`,
  );
  const stillValid = await call(reLogin.accessToken, 'GET', '/api/auth/sessions');
  check('The targeted session is unaffected by the rejected cross-user attempt', stillValid.status === 200);

  // --- Logout all other devices ---
  const aliceTabletIdentity = await Engine.generateDeviceIdentity(3);
  const aliceTablet = await registerDevice(alice.userId, 'alice-pw-123', aliceTabletIdentity, 'Tablet');
  const wsTablet = await openWs(aliceTablet.accessToken);
  let tabletClosed = false;
  let tabletGotRevokedEvent = false;
  wsTablet.addEventListener('close', () => {
    tabletClosed = true;
  });
  wsTablet.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'session_revoked') tabletGotRevokedEvent = true;
  });

  const revokeOthersResult = await call(reLogin.accessToken, 'POST', '/api/auth/sessions/revoke-others');
  check('Logout-all-other-devices: reports how many sessions it revoked', revokeOthersResult.data.revokedCount >= 1, JSON.stringify(revokeOthersResult.data));
  await new Promise((r) => setTimeout(r, 500));
  check('Logout-all-other-devices: the tablet is disconnected', tabletClosed);
  check('Logout-all-other-devices: the tablet receives SESSION_REVOKED', tabletGotRevokedEvent);

  const afterRevokeOthers = await call(reLogin.accessToken, 'GET', '/api/auth/sessions');
  check('The calling device\'s own session remains valid after revoke-others', afterRevokeOthers.status === 200);
  check(
    'Revoke-others correctly excludes the caller\'s own current session, not just "some" session',
    afterRevokeOthers.data.some((s) => s.deviceId === alice.deviceId),
  );

  const revokeOthersAgain = await call(reLogin.accessToken, 'POST', '/api/auth/sessions/revoke-others');
  check(
    'Idempotent: revoke-others called again with nothing left to revoke succeeds with a count of 0',
    revokeOthersAgain.status === 200 && revokeOthersAgain.data.revokedCount === 0,
    JSON.stringify(revokeOthersAgain.data),
  );

  // --- Security events were actually recorded ---
  const revokedEvents = db.prepare("SELECT * FROM security_events WHERE user_id = ? AND event_type = 'SESSION_REVOKED'").all(alice.userId);
  check('Security events: SESSION_REVOKED is recorded for both the individual revoke and revoke-others', revokedEvents.length >= 2, `${revokedEvents.length} events`);

  // --- Race between revoke and reconnect ---
  // Regardless of which the server happens to process first, the device
  // must end up disconnected and unable to stay connected — never in a
  // state where it's revoked in the database but still usable.
  const aliceWatchIdentity = await Engine.generateDeviceIdentity(3);
  const aliceWatch = await registerDevice(alice.userId, 'alice-pw-123', aliceWatchIdentity, 'Watch');
  sessions = (await call(reLogin.accessToken, 'GET', '/api/auth/sessions')).data;
  const watchSessionId = sessions.find((s) => s.deviceId === aliceWatch.deviceId).id;

  const [, raceReconnect] = await Promise.all([
    call(reLogin.accessToken, 'DELETE', `/api/auth/sessions/${watchSessionId}`),
    openWs(aliceWatch.accessToken),
  ]);
  await new Promise((r) => setTimeout(r, 500));
  // Whether the reconnect attempt above was rejected outright, or briefly
  // raced ahead and connected before the revoke's disconnect reached it,
  // the device must not be usable afterward.
  const watchStillConnected = raceReconnect !== null && raceReconnect.readyState === WebSocket.OPEN;
  check(
    'Race between revoke and reconnect: the device is never left connected and usable after the dust settles',
    !watchStillConnected,
    raceReconnect === null ? 'reconnect was rejected outright' : 'reconnect briefly opened, then was force-disconnected',
  );
  const watchHttpAfterRace = await call(aliceWatch.accessToken, 'GET', '/api/auth/sessions');
  check('Race between revoke and reconnect: HTTP access is also rejected afterward, regardless of the race outcome', watchHttpAfterRace.status === 401);

  server.close();
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

run().catch((e) => {
  console.error('CRASHED:', e);
  process.exit(1);
});
