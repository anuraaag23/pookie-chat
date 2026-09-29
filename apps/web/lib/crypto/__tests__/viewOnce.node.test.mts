import test from 'node:test';
import assert from 'node:assert/strict';

interface AttachmentPayload {
  kind: 'attachment';
  attachmentId: string;
  dek: string;
  mimeTypeHint: 'image' | 'file';
  filename: string;
  caption?: string;
  viewOnce?: boolean;
  opened?: boolean;
}

function parseAttachmentPayload(text: string): AttachmentPayload | null {
  try {
    const parsed = JSON.parse(text);
    return parsed?.kind === 'attachment' ? (parsed as AttachmentPayload) : null;
  } catch {
    return null;
  }
}

test('View Once Media: Serialization and single-view lifecycle', () => {
  // 1. Sender encrypts and sends a View Once photo
  const initialPayload: AttachmentPayload = {
    kind: 'attachment',
    attachmentId: 'att_view_once_999',
    dek: 'dGVzdF9kZWtfYnl0ZXM=',
    mimeTypeHint: 'image',
    filename: 'ephemeral-secret.jpg',
    viewOnce: true,
    opened: false,
  };

  const rawJson = JSON.stringify(initialPayload);
  const parsed = parseAttachmentPayload(rawJson);
  assert.ok(parsed);
  assert.equal(parsed.viewOnce, true);
  assert.equal(parsed.opened, false);

  // 2. Recipient views the photo -> marks as opened
  const openedPayload: AttachmentPayload = {
    ...parsed,
    opened: true,
  };

  const openedJson = JSON.stringify(openedPayload);
  const parsedOpened = parseAttachmentPayload(openedJson);
  assert.ok(parsedOpened);
  assert.equal(parsedOpened.opened, true, 'Opened state must persist in updated payload');

  // 3. Re-parsing prevents opening a second time
  const canBeOpenedAgain = parsedOpened.viewOnce && !parsedOpened.opened;
  assert.equal(canBeOpenedAgain, false, 'Expired View Once photo must not be openable again');
});

test('View Once Media: Standard attachments are not affected by viewOnce flag', () => {
  const normalPayload: AttachmentPayload = {
    kind: 'attachment',
    attachmentId: 'att_normal_123',
    dek: 'ZGVrX25vcm1hbF9ieXRlcw==',
    mimeTypeHint: 'image',
    filename: 'family.jpg',
  };

  const parsed = parseAttachmentPayload(JSON.stringify(normalPayload));
  assert.ok(parsed);
  assert.equal(parsed.viewOnce, undefined);
  assert.equal(parsed.opened, undefined);
});
