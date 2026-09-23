import { idbGet, idbSet } from './localDb';
import { base64ToBytes, bytesToBase64 } from '../crypto/roomCrypto';

export async function saveRoomKey(
  roomId: string,
  keyEpoch: number,
  roomKey: Uint8Array,
): Promise<void> {
  const b64 = bytesToBase64(roomKey);
  await idbSet(`roomKey:${roomId}:${keyEpoch}`, b64);
}

export async function loadRoomKey(
  roomId: string,
  keyEpoch: number,
): Promise<Uint8Array | null> {
  const b64 = await idbGet<string>(`roomKey:${roomId}:${keyEpoch}`);
  if (!b64) return null;
  try {
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}
