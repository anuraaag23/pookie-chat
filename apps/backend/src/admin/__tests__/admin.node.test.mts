import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminGuard } from '../../../dist/admin/admin.guard.js';
import { SuperadminGuard } from '../../../dist/admin/superadmin.guard.js';
import { AdminService } from '../../../dist/admin/admin.service.js';
import { AccountStatus, RoomJoinPolicy, RoomStatus, UserRole } from '@prisma/client';

function createMockExecutionContext(req: any) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as any;
}

test('AdminGuard: rejects unauthenticated requests', async () => {
  const mockPrisma = { user: { findUnique: async () => null } };
  const guard = new AdminGuard(mockPrisma as any);
  const req = {};

  await assert.rejects(
    async () => guard.canActivate(createMockExecutionContext(req)),
    /UnauthorizedException/,
  );
});

test('AdminGuard: rejects regular USER role with ForbiddenException', async () => {
  const mockPrisma = {
    user: {
      findUnique: async () => ({
        id: 'u-1',
        username: 'regular_user',
        email: 'user@example.com',
        role: UserRole.USER,
        status: AccountStatus.ACTIVE,
        lockedUntil: null,
      }),
    },
  };
  const guard = new AdminGuard(mockPrisma as any);
  const req = { auth: { userId: 'u-1', deviceId: 'd-1' } };

  await assert.rejects(
    async () => guard.canActivate(createMockExecutionContext(req)),
    /Administrative privileges required/,
  );
});

test('AdminGuard: rejects inactive/banned user', async () => {
  const mockPrisma = {
    user: {
      findUnique: async () => ({
        id: 'u-banned',
        username: 'banned_admin',
        email: 'banned@example.com',
        role: UserRole.ADMIN,
        status: AccountStatus.DELETED,
        lockedUntil: null,
      }),
    },
  };
  const guard = new AdminGuard(mockPrisma as any);
  const req = { auth: { userId: 'u-banned', deviceId: 'd-1' } };

  await assert.rejects(
    async () => guard.canActivate(createMockExecutionContext(req)),
    /Account is not active/,
  );
});

test('AdminGuard: rejects locked administrator account', async () => {
  const mockPrisma = {
    user: {
      findUnique: async () => ({
        id: 'u-locked',
        username: 'locked_admin',
        email: 'locked@example.com',
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        lockedUntil: new Date(Date.now() + 60000),
      }),
    },
  };
  const guard = new AdminGuard(mockPrisma as any);
  const req = { auth: { userId: 'u-locked', deviceId: 'd-1' } };

  await assert.rejects(
    async () => guard.canActivate(createMockExecutionContext(req)),
    /Account is currently locked/,
  );
});

test('AdminGuard: permits active ADMIN and SUPERADMIN, attaching adminUser to request', async () => {
  const mockPrisma = {
    user: {
      findUnique: async () => ({
        id: 'u-admin',
        username: 'boss',
        email: 'admin@pookie.app',
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        lockedUntil: null,
      }),
    },
  };
  const guard = new AdminGuard(mockPrisma as any);
  const req: any = { auth: { userId: 'u-admin', deviceId: 'd-1' } };

  const allowed = await guard.canActivate(createMockExecutionContext(req));
  assert.equal(allowed, true);
  assert.equal(req.adminUser.username, 'boss');
  assert.equal(req.adminUser.role, UserRole.ADMIN);
});

test('SuperadminGuard: permits only SUPERADMIN role', () => {
  const guard = new SuperadminGuard();

  const adminReq: any = {
    adminUser: { id: 'u-admin', role: UserRole.ADMIN },
  };
  assert.throws(
    () => guard.canActivate(createMockExecutionContext(adminReq)),
    /Superadmin privileges required/,
  );

  const superReq: any = {
    adminUser: { id: 'u-super', role: UserRole.SUPERADMIN },
  };
  assert.equal(guard.canActivate(createMockExecutionContext(superReq)), true);
});

test('AdminService: updateUserStatus prevents self-ban', async () => {
  const service = new AdminService({} as any, {} as any, {} as any, {} as any, {} as any);
  await assert.rejects(
    async () => service.updateUserStatus('admin-1', 'admin-1', { status: AccountStatus.DELETED }),
    /Cannot ban your own administrator account/i,
  );
});

test('AdminService: bootstrapAdmin succeeds with valid secret and upgrades account', async () => {
  let updatedRole: any = null;
  const mockPrisma: any = {
    user: {
      findFirst: async () => ({ id: 'u-99', username: 'tilakdhari', email: 'tilak@example.com' }),
      update: async (args: any) => {
        updatedRole = args.data.role;
        return { id: 'u-99', username: 'tilakdhari', email: 'tilak@example.com', role: args.data.role };
      },
    },
    adminAuditLog: {
      create: async () => ({ id: 'log-1' }),
    },
  };

  const config: any = { adminBootstrapSecret: 'super-secret-bootstrap-token-123' };
  const service = new AdminService(mockPrisma, {} as any, {} as any, {} as any, config);

  // Reject wrong secret
  await assert.rejects(
    async () => service.bootstrapAdmin({ secret: 'wrong-key', identifier: 'tilakdhari' }),
    /Invalid bootstrap secret/,
  );

  // Accept correct secret
  const res = await service.bootstrapAdmin({
    secret: 'super-secret-bootstrap-token-123',
    identifier: 'tilakdhari',
  });
  assert.equal(res.ok, true);
  assert.equal(updatedRole, UserRole.SUPERADMIN);
});
