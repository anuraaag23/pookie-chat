import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsService } from '../../../dist/settings/settings.service.js';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';

function createMockSettingsHarness() {
  const userSettings = new Map<string, any>();

  const mockPrisma = {
    userSettings: {
      findUnique: async ({ where }: any) => {
        return userSettings.get(where.userId) || null;
      },
      create: async ({ data }: any) => {
        const record = { ...data, updatedAt: new Date() };
        userSettings.set(data.userId, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = userSettings.get(where.userId) || { userId: where.userId };
        const updated = { ...existing, ...data, updatedAt: new Date() };
        userSettings.set(where.userId, updated);
        return updated;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = userSettings.get(where.userId);
        const updated = existing ? { ...existing, ...update } : { userId: where.userId, ...create };
        userSettings.set(where.userId, updated);
        return updated;
      },
    },
  };

  const service = new SettingsService(mockPrisma as any);
  return { service, userSettings };
}

test('Feature Passwords: first-time setup, verification, and get() status', async () => {
  const { service } = createMockSettingsHarness();
  const userId = 'user-features-1';

  // Initially, no feature passwords are configured
  const initial = await service.get(userId);
  assert.equal(initial.hasBurnPassword, false);
  assert.equal(initial.hasChatLockPassword, false);
  assert.equal(initial.hasHideChatPassword, false);
  // Ensure hashes are NEVER exposed
  assert.equal((initial as any).burnPasswordHash, undefined);
  assert.equal((initial as any).chatLockPasswordHash, undefined);
  assert.equal((initial as any).hideChatPasswordHash, undefined);

  // 1. Set Chat Lock password for first time
  const setLock = await service.setFeaturePassword(userId, 'lock', 'lockSecret123');
  assert.equal(setLock.success, true);

  // 2. Set Burn password for first time
  const setBurn = await service.setFeaturePassword(userId, 'burn', 'burnSecret456');
  assert.equal(setBurn.success, true);

  // 3. Status reflection
  const afterSet = await service.get(userId);
  assert.equal(afterSet.hasChatLockPassword, true);
  assert.equal(afterSet.hasBurnPassword, true);
  assert.equal(afterSet.hasHideChatPassword, false);

  // 4. Verification with correct password returns true
  const verifyLockOk = await service.verifyFeaturePassword(userId, 'lock', 'lockSecret123');
  assert.equal(verifyLockOk.valid, true);

  const verifyBurnOk = await service.verifyFeaturePassword(userId, 'burn', 'burnSecret456');
  assert.equal(verifyBurnOk.valid, true);

  // 5. Verification with wrong password throws UnauthorizedException
  await assert.rejects(
    () => service.verifyFeaturePassword(userId, 'lock', 'wrongSecret'),
    (err: any) => err instanceof UnauthorizedException,
  );

  // 6. Cross-feature isolation: lock password cannot verify burn
  await assert.rejects(
    () => service.verifyFeaturePassword(userId, 'burn', 'lockSecret123'),
    (err: any) => err instanceof UnauthorizedException,
  );
});

test('Feature Passwords: change requires current password and validates correctly', async () => {
  const { service } = createMockSettingsHarness();
  const userId = 'user-features-2';

  // Initial set
  await service.setFeaturePassword(userId, 'hide', 'hideOriginalPass');

  // Attempting to change without current password throws UnauthorizedException
  await assert.rejects(
    () => service.setFeaturePassword(userId, 'hide', 'newHidePass'),
    (err: any) => err instanceof UnauthorizedException && err.message.includes('Current password required'),
  );

  // Attempting to change with wrong current password throws UnauthorizedException
  await assert.rejects(
    () => service.setFeaturePassword(userId, 'hide', 'newHidePass', 'wrongCurrentPass'),
    (err: any) => err instanceof UnauthorizedException && err.message.includes('Incorrect current password'),
  );

  // Changing with correct current password succeeds
  const changeRes = await service.setFeaturePassword(userId, 'hide', 'newHidePass', 'hideOriginalPass');
  assert.equal(changeRes.success, true);

  // Old password no longer verifies
  await assert.rejects(
    () => service.verifyFeaturePassword(userId, 'hide', 'hideOriginalPass'),
    (err: any) => err instanceof UnauthorizedException,
  );

  // New password verifies
  const newVerify = await service.verifyFeaturePassword(userId, 'hide', 'newHidePass');
  assert.equal(newVerify.valid, true);
});

test('Feature Passwords: removal requires current password and resets status', async () => {
  const { service } = createMockSettingsHarness();
  const userId = 'user-features-3';

  await service.setFeaturePassword(userId, 'burn', 'burnSecret789');

  // Wrong password cannot remove
  await assert.rejects(
    () => service.removeFeaturePassword(userId, 'burn', 'wrongSecret'),
    (err: any) => err instanceof UnauthorizedException,
  );

  // Correct password removes
  const removeRes = await service.removeFeaturePassword(userId, 'burn', 'burnSecret789');
  assert.equal(removeRes.success, true);

  // Status is now false
  const settings = await service.get(userId);
  assert.equal(settings.hasBurnPassword, false);

  // Verification now throws BadRequestException because not configured
  await assert.rejects(
    () => service.verifyFeaturePassword(userId, 'burn', 'burnSecret789'),
    (err: any) => err instanceof BadRequestException && err.message.includes('not configured'),
  );
});
