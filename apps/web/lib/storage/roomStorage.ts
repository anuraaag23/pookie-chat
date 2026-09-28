import { idbGet, idbSet, idbDelete } from './localDb';
import { resolveCryptoUserId } from './userScope';
import { base64ToBytes, bytesToBase64 } from '../crypto/roomCrypto';

export async function saveRoomKey(
  roomId: string,
  keyEpoch: number,
  roomKey: Uint8Array,
  explicitUserId?: string | null,
): Promise<void> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return;
  const b64 = bytesToBase64(roomKey);
  await idbSet(`roomKey:${uid}:${roomId}:${keyEpoch}`, b64);
}

export async function loadRoomKey(
  roomId: string,
  keyEpoch: number,
  explicitUserId?: string | null,
): Promise<Uint8Array | null> {
  const uid = await resolveCryptoUserId(explicitUserId);
  if (!uid) return null;
  let b64 = await idbGet<string>(`roomKey:${uid}:${roomId}:${keyEpoch}`);
  if (!b64) {
    const legacy = await idbGet<string>(`roomKey:${roomId}:${keyEpoch}`);
    if (legacy) {
      await idbSet(`roomKey:${uid}:${roomId}:${keyEpoch}`, legacy);
      await idbDelete(`roomKey:${roomId}:${keyEpoch}`);
      b64 = legacy;
    }
  }
  if (!b64) return null;
  try {
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}
