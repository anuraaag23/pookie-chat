/**
 * Client-side attachment encryption. Runs entirely before anything is
 * sent to the backend — see docs/00-ARCHITECTURE.md §16 on the
 * device-encrypts-first architecture.
 */

function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

/**
 * Re-encodes an image through a canvas, which drops EXIF (including GPS)
 * because canvas pixel data never carries the original file's metadata
 * segments — only decoded pixels go in, and only a fresh file with no
 * metadata segments comes out. Non-image files pass through unchanged
 * (there's no equivalent metadata risk to strip, and no generic way to
 * "clean" an arbitrary document without altering its content).
 */
export async function stripImageMetadata(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file;
  try {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
      return file;
    }
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file; // if canvas isn't available for some reason, fail open to the original file rather than block the upload
    ctx.drawImage(bitmap, 0, 0);
    const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, outputType, 0.92));
    return blob ?? file;
  } catch {
    return file;
  }
}

export interface EncryptedFile {
  ciphertext: Uint8Array;
  dek: Uint8Array; // raw, NOT encrypted yet — the caller encrypts this with the message's ratchet key, same as any other message content
  mimeTypeHint: 'image' | 'file';
  originalSize: number;
}

export async function encryptFile(file: File): Promise<EncryptedFile> {
  const cleaned = await stripImageMetadata(file);
  const plaintextBytes = new Uint8Array(await cleaned.arrayBuffer());

  const dek = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', bs(dek), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(plaintextBytes));

  // IV is prefixed onto the ciphertext blob itself (rather than sent as
  // separate metadata) since the attachment endpoint accepts one raw
  // binary body — the DEK travels separately, inside the message.
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return {
    ciphertext: combined,
    dek,
    mimeTypeHint: file.type.startsWith('image/') ? 'image' : 'file',
    originalSize: file.size,
  };
}

export async function decryptFile(combined: Uint8Array, dek: Uint8Array): Promise<Blob> {
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const key = await crypto.subtle.importKey('raw', bs(dek), 'AES-GCM', false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(iv) }, key, bs(ciphertext));
  return new Blob([plaintext]);
}
