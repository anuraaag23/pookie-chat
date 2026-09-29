import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalAttachmentStore } from '../local-attachment-store.ts';

test('LocalAttachmentStore: Zero-knowledge local storage and round-trip read/write', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookie-store-test-'));
  const store = new LocalAttachmentStore(tempDir);

  t.after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // 1. Upload encrypted buffer
  const sampleCiphertext = Buffer.from('AES-256-GCM-CIPHERTEXT-BYTES-0102030405', 'utf8');
  const filename = 'test-asset-123.bin';
  const fileId = await store.save(sampleCiphertext, filename);

  assert.ok(fileId.startsWith('local:'), 'Stored fileId must use local: prefix');
  assert.equal(fileId, `local:${filename}`);

  // 2. File exists on disk at sanitized location
  const expectedDiskPath = path.join(tempDir, filename);
  assert.equal(fs.existsSync(expectedDiskPath), true, 'Ciphertext must be written to disk');

  // 3. Read retrieves exact ciphertext bit-for-bit
  const downloaded = await store.read(fileId);
  assert.ok(downloaded);
  assert.deepEqual(downloaded, sampleCiphertext, 'Retrieved bytes must match original ciphertext exactly');

  // 4. Also reads without the local: prefix
  const downloadedRaw = await store.read(filename);
  assert.ok(downloadedRaw);
  assert.deepEqual(downloadedRaw, sampleCiphertext);

  // 5. Delete removes the file cleanly
  const removed = await store.remove(fileId);
  assert.equal(removed, true, 'Remove must return true for existing file');
  assert.equal(fs.existsSync(expectedDiskPath), false, 'File must be removed from disk upon delete');

  // 6. Non-existent file returns null
  const missing = await store.read('non-existent-file.bin');
  assert.equal(missing, null);
});

test('LocalAttachmentStore: Directory traversal protection in filenames', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookie-store-traversal-'));
  const store = new LocalAttachmentStore(tempDir);

  t.after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const maliciousName = '../../../../etc/shadow';
  const ciphertext = Buffer.from('malicious-payload', 'utf8');

  const fileId = await store.save(ciphertext, maliciousName);
  assert.equal(fileId, 'local:shadow', 'Filename must be stripped to base name');

  // Verify it was stored inside tempDir, not in /etc/
  const expectedPath = path.join(tempDir, 'shadow');
  assert.equal(fs.existsSync(expectedPath), true);

  const downloaded = await store.read(fileId);
  assert.deepEqual(downloaded, ciphertext);
});

test('LocalAttachmentStore: Fallback logic preserves zero-knowledge security without GCP credentials', async () => {
  // Simulate the ManagedStorageProvider upload/download branching logic
  let driveConfigured = false;

  async function mockUpload(bytes: Buffer, name: string, store: LocalAttachmentStore): Promise<string> {
    if (driveConfigured) {
      return 'drive-file-id-123';
    }
    return store.save(bytes, name);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pookie-store-mock-'));
  const store = new LocalAttachmentStore(tempDir);

  try {
    const bytes = Buffer.from('zero-knowledge-secret-data');
    const resultId = await mockUpload(bytes, 'photo.jpg.enc', store);

    assert.equal(resultId, 'local:photo.jpg.enc');
    const retrieved = await store.read(resultId);
    assert.deepEqual(retrieved, bytes);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
