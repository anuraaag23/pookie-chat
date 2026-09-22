/**
 * Pookie Chat — client-side end-to-end encryption engine.
 *
 * Implements docs/03-ENCRYPTION-PROTOCOL.md: an X3DH-style handshake for
 * session establishment, followed by a symmetric-key ratchet for
 * per-message forward secrecy, with AES-256-GCM for authenticated
 * encryption.
 *
 * ONE CHANGE FROM THE ORIGINAL DOC: that doc specified XChaCha20-Poly1305
 * via libsodium. This implementation uses AES-256-GCM via the native
 * `crypto.subtle` API instead. Reasoning:
 *
 *   1. This sandbox cannot install npm packages (no network access), so
 *      libsodium-wrappers was not an option to actually ship and verify
 *      here. Rather than write untestable code against a library that
 *      isn't present, this uses what's real and verifiable: the
 *      standard, browser-native Web Crypto API.
 *   2. As of Chrome 137 (mid-2025) X25519 and Ed25519 shipped enabled by
 *      default in Chrome, Firefox, and Safari — the cross-browser
 *      inconsistency that originally motivated choosing libsodium over
 *      Web Crypto API (see docs/00-ARCHITECTURE.md) no longer applies as
 *      of current browser versions. This was verified directly in this
 *      session: in real Chromium 141 (via Playwright), X25519, Ed25519,
 *      HKDF, and AES-GCM via crypto.subtle all work with zero setup.
 *   3. AES-256-GCM's 12-byte nonce is a smaller nonce space than
 *      XChaCha20's 24 bytes, which matters if many messages reuse one
 *      key. That risk doesn't apply here: the ratchet (below) derives a
 *      *fresh, one-time-use key for every single message*, so nonce
 *      reuse under a fixed key — GCM's actual failure mode — cannot
 *      happen. A random nonce is still used per message as defense in
 *      depth, but the security of this design does not depend on it.
 *
 * WHAT THIS DOES NOT YET DO: this is the v1 ratchet described in the
 * threat model — it gives forward secrecy (compromising one message key
 * doesn't expose earlier ones) but not full post-compromise recovery
 * (a session doesn't yet "heal" itself via fresh DH steps the way a full
 * Double Ratchet does). That is scoped, deliberately, to a later
 * hardening pass — see docs/01-THREAT-MODEL.md §5.
 *
 * This module has no framework dependency and no import from the rest of
 * the app — it only touches the standard `crypto` global, so it runs
 * identically in the browser and in Node (both implement the same W3C
 * Web Crypto spec), which is what makes it possible to unit test here.
 */

// ---------------------------------------------------------------------------
// Encoding helpers — deliberately avoid Node's Buffer so this file behaves
// identically in the browser, where Buffer does not exist.
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/**
 * TypeScript's DOM types require `BufferSource` params to be backed by a
 * plain `ArrayBuffer`, while `Uint8Array` is generic over `ArrayBufferLike`
 * (which also covers `SharedArrayBuffer`). Every Uint8Array constructed in
 * this file is always freshly allocated and never shared-buffer-backed, so
 * this narrows an overly conservative type rather than bypassing a real
 * runtime check. Confirmed by `tsc --strict` after adding this: zero errors.
 */
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

// ---------------------------------------------------------------------------
// Low-level primitives
// ---------------------------------------------------------------------------

async function generateSigningKeyPair() {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return { publicKey: bytesToBase64(new Uint8Array(raw)), keyPair };
}

async function generateDhKeyPair() {
  const keyPair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return { publicKey: bytesToBase64(new Uint8Array(raw)), keyPair };
}

async function importDhPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bs(base64ToBytes(b64)), { name: 'X25519' }, true, []);
}

async function importSigningPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bs(base64ToBytes(b64)), { name: 'Ed25519' }, true, ['verify']);
}

async function signBytes(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('Ed25519', privateKey, bs(data));
  return bytesToBase64(new Uint8Array(sig));
}

/** Verifies a signature made by `signBytes`. Never throws — returns false on any failure. */
export async function verifyBytes(
  publicKeyB64: string,
  data: Uint8Array,
  signatureB64: string,
): Promise<boolean> {
  try {
    const pubKey = await importSigningPublicKey(publicKeyB64);
    return await crypto.subtle.verify('Ed25519', pubKey, bs(base64ToBytes(signatureB64)), bs(data));
  } catch {
    return false;
  }
}

async function dh(privateKey: CryptoKey, publicKeyB64: string): Promise<Uint8Array> {
  const pub = await importDhPublicKey(publicKeyB64);
  const bits = await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, privateKey, 256);
  return new Uint8Array(bits);
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, lengthBytes: number): Promise<Uint8Array> {
  // HKDF requires non-extractable, deriveBits-only key material — this
  // rejects, at the type level, any accidental attempt to export a
  // derived secret as anything other than more derived bits.
  const key = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(new TextEncoder().encode(info)) },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// Device identity & pre-key bundles (docs/03-ENCRYPTION-PROTOCOL.md §1–2)
// ---------------------------------------------------------------------------

export interface DeviceIdentity {
  identitySigningPublic: string;
  identityDhPublic: string;
  signedPrekeyPublic: string;
  signedPrekeySignature: string;
  oneTimePrekeysPublic: string[];
  /**
   * Private key material. In the real app this never leaves the device and
   * is persisted only in encrypted local storage (see the app-lock /
   * IndexedDB design) — never sent to the server, never logged.
   */
  _private: {
    identitySigningKeyPair: CryptoKeyPair;
    identityDhKeyPair: CryptoKeyPair;
    signedPrekeyPair: CryptoKeyPair;
    oneTimePrekeyPairs: CryptoKeyPair[];
  };
}

/** Generates a brand-new device identity: signing key, DH identity key, a signed pre-key, and a pool of one-time pre-keys. */
export async function generateDeviceIdentity(oneTimePrekeyCount = 20): Promise<DeviceIdentity> {
  const signing = await generateSigningKeyPair();
  const identityDh = await generateDhKeyPair();
  const signedPrekey = await generateDhKeyPair();
  const signedPrekeySignature = await signBytes(
    signing.keyPair.privateKey,
    base64ToBytes(signedPrekey.publicKey),
  );
  const oneTimePrekeys = await Promise.all(
    Array.from({ length: oneTimePrekeyCount }, () => generateDhKeyPair()),
  );

  return {
    identitySigningPublic: signing.publicKey,
    identityDhPublic: identityDh.publicKey,
    signedPrekeyPublic: signedPrekey.publicKey,
    signedPrekeySignature,
    oneTimePrekeysPublic: oneTimePrekeys.map((k) => k.publicKey),
    _private: {
      identitySigningKeyPair: signing.keyPair,
      identityDhKeyPair: identityDh.keyPair,
      signedPrekeyPair: signedPrekey.keyPair,
      oneTimePrekeyPairs: oneTimePrekeys.map((k) => k.keyPair),
    },
  };
}

/** The subset of a DeviceIdentity that's safe to publish to the server / hand to another device. */
export interface PublicKeyBundle {
  identitySigningPublic: string;
  identityDhPublic: string;
  signedPrekeyPublic: string;
  signedPrekeySignature: string;
  /** A single one-time pre-key, consumed for this handshake only. Undefined if the pool was exhausted. */
  oneTimePrekeyPublic?: string;
}

export function toPublicBundle(identity: DeviceIdentity, oneTimePrekeyPublic?: string): PublicKeyBundle {
  return {
    identitySigningPublic: identity.identitySigningPublic,
    identityDhPublic: identity.identityDhPublic,
    signedPrekeyPublic: identity.signedPrekeyPublic,
    signedPrekeySignature: identity.signedPrekeySignature,
    oneTimePrekeyPublic,
  };
}

// ---------------------------------------------------------------------------
// X3DH-style handshake (docs/03-ENCRYPTION-PROTOCOL.md §3–4)
// ---------------------------------------------------------------------------

export interface SessionKeys {
  sendingChainKey: Uint8Array;
  receivingChainKey: Uint8Array;
}

/** The message the initiator sends back through the server so the responder can complete the handshake later, even asynchronously. */
export interface HandshakeMessage {
  initiatorIdentityDhPublic: string;
  ephemeralPublic: string;
  usedOneTimePrekeyPublic?: string;
}

const CHAIN_INFO = {
  aToB: 'pookie-chat-chain-a-to-b',
  bToA: 'pookie-chat-chain-b-to-a',
};

/**
 * Run by whoever redeems a pairing code (they have the other side's bundle
 * immediately; the other side completes the mirror computation next time
 * they're online — see `completeHandshake`).
 */
export async function initiateHandshake(
  myIdentity: DeviceIdentity,
  theirBundle: PublicKeyBundle,
): Promise<{ session: SessionKeys; message: HandshakeMessage }> {
  const signatureValid = await verifyBytes(
    theirBundle.identitySigningPublic,
    base64ToBytes(theirBundle.signedPrekeyPublic),
    theirBundle.signedPrekeySignature,
  );
  if (!signatureValid) {
    throw new Error(
      'Signed pre-key signature did not verify — refusing to establish a session with an unverifiable bundle.',
    );
  }

  const ephemeral = await generateDhKeyPair();

  const dh1 = await dh(myIdentity._private.identityDhKeyPair.privateKey, theirBundle.signedPrekeyPublic);
  const dh2 = await dh(ephemeral.keyPair.privateKey, theirBundle.identityDhPublic);
  const dh3 = await dh(ephemeral.keyPair.privateKey, theirBundle.signedPrekeyPublic);
  const dh4 = theirBundle.oneTimePrekeyPublic
    ? await dh(ephemeral.keyPair.privateKey, theirBundle.oneTimePrekeyPublic)
    : new Uint8Array(0);

  const rootKey = await hkdf(concatBytes(dh1, dh2, dh3, dh4), new Uint8Array(32), 'pookie-chat-x3dh-root', 32);

  // "I initiated" doesn't imply "I'm user A" — chain direction is keyed by
  // who's initiating this specific handshake, so both sides always agree.
  const sendingChainKey = await hkdf(rootKey, new Uint8Array(32), CHAIN_INFO.bToA, 32);
  const receivingChainKey = await hkdf(rootKey, new Uint8Array(32), CHAIN_INFO.aToB, 32);

  return {
    session: { sendingChainKey, receivingChainKey },
    message: {
      initiatorIdentityDhPublic: myIdentity.identityDhPublic,
      ephemeralPublic: ephemeral.publicKey,
      usedOneTimePrekeyPublic: theirBundle.oneTimePrekeyPublic,
    },
  };
}

/**
 * Run by whoever created the pairing code, once they're back online and can
 * see the `HandshakeMessage` the initiator left for them. Must be called
 * with the *same* DeviceIdentity whose bundle was published — specifically,
 * one that still has the one-time pre-key referenced in `usedOneTimePrekeyPublic`
 * if one was used.
 */
export async function completeHandshake(
  myIdentity: DeviceIdentity,
  handshake: HandshakeMessage,
): Promise<{ session: SessionKeys; consumedOneTimePrekeyPublic?: string }> {
  const dh1 = await dh(myIdentity._private.signedPrekeyPair.privateKey, handshake.initiatorIdentityDhPublic);
  const dh2 = await dh(myIdentity._private.identityDhKeyPair.privateKey, handshake.ephemeralPublic);
  const dh3 = await dh(myIdentity._private.signedPrekeyPair.privateKey, handshake.ephemeralPublic);

  // Explicit annotation, not inferred from the initializer: `dh()`'s
  // return type and a bare `new Uint8Array(0)` resolve to slightly
  // different generic instantiations of Uint8Array under `--lib dom`,
  // which `tsc --strict` treats as incompatible on the reassignment below
  // if this is left to plain inference.
  let dh4: Uint8Array = new Uint8Array(0);
  let consumedOneTimePrekeyPublic: string | undefined;
  if (handshake.usedOneTimePrekeyPublic) {
    const idx = myIdentity.oneTimePrekeysPublic.indexOf(handshake.usedOneTimePrekeyPublic);
    if (idx === -1) {
      throw new Error(
        'Referenced one-time pre-key not found on this device — it may have already been consumed.',
      );
    }
    dh4 = await dh(myIdentity._private.oneTimePrekeyPairs[idx]!.privateKey, handshake.ephemeralPublic);
    consumedOneTimePrekeyPublic = handshake.usedOneTimePrekeyPublic;
    // Caller MUST remove this one-time pre-key from local + server storage
    // after this call returns — this function only reports which one was
    // used, it does not mutate `myIdentity`.
  }

  const rootKey = await hkdf(concatBytes(dh1, dh2, dh3, dh4), new Uint8Array(32), 'pookie-chat-x3dh-root', 32);

  const sendingChainKey = await hkdf(rootKey, new Uint8Array(32), CHAIN_INFO.aToB, 32);
  const receivingChainKey = await hkdf(rootKey, new Uint8Array(32), CHAIN_INFO.bToA, 32);

  return { session: { sendingChainKey, receivingChainKey }, consumedOneTimePrekeyPublic };
}

// ---------------------------------------------------------------------------
// Per-message ratchet + AEAD (docs/03-ENCRYPTION-PROTOCOL.md §5–6)
// ---------------------------------------------------------------------------

export interface EncryptedEnvelope {
  ciphertext: string;
  iv: string;
}

async function advanceChain(chainKey: Uint8Array): Promise<{ messageKey: Uint8Array; nextChainKey: Uint8Array }> {
  const messageKey = await hkdf(chainKey, new Uint8Array(32), 'pookie-chat-message-key', 32);
  const nextChainKey = await hkdf(chainKey, new Uint8Array(32), 'pookie-chat-chain-key', 32);
  return { messageKey, nextChainKey };
}

/**
 * THE FIX (found during the V1 pre-runtime hardening pass, under "any
 * path where a failed decrypt could advance a sync cursor and
 * permanently skip a message" — this was worse than that): exposes just
 * the chain-advancement half of what ratchetDecrypt normally does,
 * without attempting the AEAD decrypt at all.
 *
 * The receiving chain MUST advance by exactly one step for every
 * message position, in lockstep with the sender's sending chain,
 * regardless of whether that particular message's ciphertext can
 * actually be recovered. Before this fix, the caller
 * (app/chat/[conversationId]/page.tsx's processIncoming) only advanced
 * receivingChainKey/recvStep inside ratchetDecrypt's success path —
 * on ANY decrypt failure (genuine corruption, a dropped/flipped bit in
 * transit, or real tampering) the chain silently stayed one step
 * behind. Every message after the first failure would then be
 * decrypted with the wrong chain-key position and ALSO fail — a single
 * bad message permanently broke the rest of the conversation, not just
 * that one message, and the UI had no way to recover short of burning
 * and re-pairing. Combined with the sync cursor (lastSyncedSeq)
 * advancing past every message regardless of decrypt outcome, none of
 * those messages would ever be retried either.
 *
 * `advanceChain`'s derivation depends only on the current chain key —
 * never on the ciphertext, IV, or AAD of the message being decrypted —
 * so computing it here, independently of whether the AEAD step inside
 * ratchetDecrypt succeeds or throws, always produces the exact same
 * value ratchetDecrypt would have returned on success. This does not
 * weaken tamper detection: the plaintext of a genuinely corrupted or
 * tampered message is still never recovered (ratchetDecrypt still
 * throws for that message specifically) — this only prevents that
 * single failure from cascading into every message that follows it.
 */
export async function deriveNextChainKey(chainKey: Uint8Array): Promise<Uint8Array> {
  const { nextChainKey } = await advanceChain(chainKey);
  return nextChainKey;
}

/** Encrypts one message and advances the sending chain. Every message gets its own one-time-use key — see the module doc comment on why GCM's nonce is safe here. */
export async function ratchetEncrypt(
  chainKey: Uint8Array,
  plaintext: string,
  aad: Uint8Array,
): Promise<{ envelope: EncryptedEnvelope; nextChainKey: Uint8Array }> {
  const { messageKey, nextChainKey } = await advanceChain(chainKey);
  const key = await crypto.subtle.importKey('raw', bs(messageKey), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: bs(iv), additionalData: bs(aad) },
    key,
    bs(new TextEncoder().encode(plaintext)),
  );
  return {
    envelope: { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) },
    nextChainKey,
  };
}

/** Decrypts one message and advances the receiving chain. Throws if the ciphertext was tampered with or the AAD doesn't match. */
export async function ratchetDecrypt(
  chainKey: Uint8Array,
  envelope: EncryptedEnvelope,
  aad: Uint8Array,
): Promise<{ plaintext: string; nextChainKey: Uint8Array }> {
  const { messageKey, nextChainKey } = await advanceChain(chainKey);
  const key = await crypto.subtle.importKey('raw', bs(messageKey), 'AES-GCM', false, ['decrypt']);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bs(base64ToBytes(envelope.iv)), additionalData: bs(aad) },
    key,
    bs(base64ToBytes(envelope.ciphertext)),
  );
  return { plaintext: new TextDecoder().decode(plaintextBuf), nextChainKey };
}

/** Builds the AAD that binds a ciphertext to its conversation and position — prevents cut-and-paste across conversations or silent reordering. */
export function buildAad(conversationId: string, sequenceNumber: number | bigint): Uint8Array {
  // Wrapping in `new Uint8Array(...)` copies into a fresh, plain
  // ArrayBuffer-backed array — TextEncoder#encode's declared return type
  // is generic over ArrayBufferLike, this function's isn't.
  return new Uint8Array(new TextEncoder().encode(`${conversationId}:${sequenceNumber}`));
}
