/**
 * Pure logic for recognizing "the same device logging in again," so login
 * doesn't blindly create a new Device row every time — see
 * AuthService.findOrCreateDevice for where this plugs in.
 */

export interface DeviceKeyBundle {
  identityDhPublic: string;
  identitySigningPublic: string;
}

export interface DeviceWithKeys extends DeviceKeyBundle {
  id: string;
}

/**
 * A device is the same physical/browser installation if both identity keys
 * match exactly. These are generated once per install and, per
 * docs/03-ENCRYPTION-PROTOCOL.md §11, are never rotated in place — only
 * replaced by a fresh pairing after an explicit "forget this device"
 * (this app's logout wipes them; see AuthContext.tsx). Two distinct devices
 * could never coincidentally share both keys, so an exact match on both is
 * a safe, sufficient signal — checking only one would not be: they're
 * generated independently, so a match on just one proves nothing about
 * the other.
 */
export function findMatchingDevice(existingDevices: DeviceWithKeys[], incoming: DeviceKeyBundle): DeviceWithKeys | null {
  return (
    existingDevices.find(
      (d) => d.identityDhPublic === incoming.identityDhPublic && d.identitySigningPublic === incoming.identitySigningPublic,
    ) ?? null
  );
}
