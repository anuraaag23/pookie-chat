import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountStatus, Prisma, RoomStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MessagesService } from '../messages/messages.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { ConnectionRegistryService } from '../realtime/connection-registry.service';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import {
  AuditLogsQueryDto,
  BootstrapAdminDto,
  RoomsQueryDto,
  SecurityEventsQueryDto,
  UpdateRoomDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
  UserQueryDto,
} from './dto/admin.dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly messagesService: MessagesService,
    private readonly attachmentsService: AttachmentsService,
    private readonly connectionRegistry: ConnectionRegistryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async recordAudit(params: {
    adminId: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    details?: any;
    ipAddress?: string | null;
  }) {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId: params.adminId,
          action: params.action,
          targetType: params.targetType,
          targetId: params.targetId ?? null,
          details: params.details ? (params.details as Prisma.InputJsonValue) : undefined,
          ipAddress: params.ipAddress ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to record admin audit log: ${String(err)}`);
    }
  }

  async getMetrics() {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Database Ping latency
    const pingStart = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    const dbLatencyMs = Date.now() - pingStart;

    // Parallel aggregate counts
    const [
      totalUsers,
      activeUsers24h,
      activeUsers7d,
      activeUsers30d,
      bannedUsers,
      lockedUsers,
      verifiedEmailUsers,
      totalRooms,
      activeRooms,
      closedRooms,
      lockedRooms,
      totalConversations,
      totalDirectMessages,
      totalRoomMessages,
      directMessages24h,
      roomMessages24h,
      totalAttachments,
      storageAggregate,
      securityEvents24h,
      recentSecurityEvents,
      recentAuditLogs,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { lastLoginAt: { gte: oneDayAgo }, status: AccountStatus.ACTIVE } }),
      this.prisma.user.count({ where: { lastLoginAt: { gte: sevenDaysAgo }, status: AccountStatus.ACTIVE } }),
      this.prisma.user.count({ where: { lastLoginAt: { gte: thirtyDaysAgo }, status: AccountStatus.ACTIVE } }),
      this.prisma.user.count({ where: { status: AccountStatus.DELETED } }),
      this.prisma.user.count({ where: { lockedUntil: { gt: now } } }),
      this.prisma.user.count({ where: { emailVerifiedAt: { not: null } } }),
      this.prisma.room.count(),
      this.prisma.room.count({ where: { status: RoomStatus.ACTIVE } }),
      this.prisma.room.count({ where: { status: RoomStatus.CLOSED } }),
      this.prisma.room.count({ where: { joinLocked: true } }),
      this.prisma.conversation.count(),
      this.prisma.message.count(),
      this.prisma.roomMessage.count(),
      this.prisma.message.count({ where: { sentAt: { gte: oneDayAgo } } }),
      this.prisma.roomMessage.count({ where: { sentAt: { gte: oneDayAgo } } }),
      this.prisma.attachment.count(),
      this.prisma.attachment.aggregate({
        _sum: { encryptedSize: true },
      }),
      this.prisma.securityEvent.count({ where: { createdAt: { gte: oneDayAgo } } }),
      this.prisma.securityEvent.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, username: true, email: true } },
        },
      }),
      this.prisma.adminAuditLog.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          admin: { select: { id: true, username: true, email: true } },
        },
      }),
    ]);

    // 14-Day Activity Trend (Daily registrations and message activity)
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const [recentUsers, recentMessages] = await Promise.all([
      this.prisma.user.findMany({
        where: { createdAt: { gte: fourteenDaysAgo } },
        select: { createdAt: true },
      }),
      this.prisma.message.findMany({
        where: { sentAt: { gte: fourteenDaysAgo } },
        select: { sentAt: true },
      }),
    ]);

    const dailyStatsMap = new Map<string, { date: string; signups: number; messages: number }>();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      dailyStatsMap.set(key, { date: key, signups: 0, messages: 0 });
    }

    for (const u of recentUsers) {
      const key = u.createdAt.toISOString().slice(0, 10);
      const entry = dailyStatsMap.get(key);
      if (entry) entry.signups += 1;
    }

    for (const m of recentMessages) {
      const key = m.sentAt.toISOString().slice(0, 10);
      const entry = dailyStatsMap.get(key);
      if (entry) entry.messages += 1;
    }

    const activityTimeline = Array.from(dailyStatsMap.values());
    const totalStorageBytes = Number(storageAggregate._sum.encryptedSize ?? 0);

    const mem = process.memoryUsage();

    return {
      overview: {
        totalUsers,
        activeUsers24h,
        activeUsers7d,
        activeUsers30d,
        bannedUsers,
        lockedUsers,
        verifiedEmailUsers,
        totalRooms,
        activeRooms,
        closedRooms,
        lockedRooms,
        totalConversations,
        totalMessages: totalDirectMessages + totalRoomMessages,
        messages24h: directMessages24h + roomMessages24h,
        totalAttachments,
        totalStorageBytes,
        securityEvents24h,
      },
      system: {
        uptimeSeconds: Math.floor(process.uptime()),
        dbLatencyMs,
        nodeVersion: process.version,
        platform: process.platform,
        memory: {
          heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
          heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
          rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        },
      },
      activityTimeline,
      recentSecurityEvents: recentSecurityEvents.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        metadata: e.metadata,
        createdAt: e.createdAt,
        user: e.user ? { id: e.user.id, username: e.user.username, email: e.user.email } : null,
      })),
      recentAuditLogs: recentAuditLogs.map((a) => ({
        id: a.id,
        action: a.action,
        targetType: a.targetType,
        targetId: a.targetId,
        details: a.details,
        ipAddress: a.ipAddress,
        createdAt: a.createdAt,
        admin: { id: a.admin.id, username: a.admin.username, email: a.admin.email },
      })),
    };
  }

  async getUsers(query: UserQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {};

    if (query.search) {
      const search = query.search.trim().toLowerCase();
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.role) {
      where.role = query.role;
    }

    if (query.isLocked !== undefined) {
      if (query.isLocked) {
        where.lockedUntil = { gt: new Date() };
      } else {
        where.OR = [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }];
      }
    }

    const orderBy: Prisma.UserOrderByWithRelationInput = {
      [query.sortBy ?? 'createdAt']: query.sortOrder ?? 'desc',
    };

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        select: {
          id: true,
          username: true,
          email: true,
          displayName: true,
          status: true,
          role: true,
          failedLoginCount: true,
          lockedUntil: true,
          emailVerifiedAt: true,
          createdAt: true,
          lastLoginAt: true,
          _count: {
            select: {
              devices: true,
              roomMemberships: true,
              messagesSent: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        displayName: u.displayName,
        status: u.status,
        role: u.role,
        isLocked: !!(u.lockedUntil && u.lockedUntil > new Date()),
        failedLoginCount: u.failedLoginCount,
        lockedUntil: u.lockedUntil,
        emailVerified: !!u.emailVerifiedAt,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        devicesCount: u._count.devices,
        roomsCount: u._count.roomMemberships,
        messagesCount: u._count.messagesSent,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        devices: {
          orderBy: { lastSeenAt: 'desc' },
          select: {
            id: true,
            deviceName: true,
            platform: true,
            lastSeenAt: true,
            revokedAt: true,
            createdAt: true,
          },
        },
        authSessions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            deviceId: true,
            userAgent: true,
            ipHash: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
          },
        },
        securityEvents: {
          orderBy: { createdAt: 'desc' },
          take: 30,
        },
        roomMemberships: {
          include: {
            room: {
              select: {
                id: true,
                name: true,
                status: true,
                joinPolicy: true,
                joinLocked: true,
                createdAt: true,
              },
            },
          },
        },
        _count: {
          select: {
            conversationsAsA: true,
            conversationsAsB: true,
            messagesSent: true,
            roomMessagesSent: true,
            roomsOwned: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        status: user.status,
        role: user.role,
        isLocked: !!(user.lockedUntil && user.lockedUntil > new Date()),
        failedLoginCount: user.failedLoginCount,
        lockedUntil: user.lockedUntil,
        emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
        stats: {
          totalDirectConversations: user._count.conversationsAsA + user._count.conversationsAsB,
          totalDirectMessages: user._count.messagesSent,
          totalRoomMessages: user._count.roomMessagesSent,
          roomsOwned: user._count.roomsOwned,
          roomsJoined: user.roomMemberships.length,
          activeDevices: user.devices.filter((d) => !d.revokedAt).length,
        },
      },
      devices: user.devices,
      sessions: user.authSessions,
      securityEvents: user.securityEvents,
      rooms: user.roomMemberships.map((m) => ({
        roomId: m.roomId,
        name: m.room.name,
        role: m.role,
        joinedAt: m.joinedAt,
        status: m.room.status,
        joinLocked: m.room.joinLocked,
      })),
    };
  }

  async updateUserStatus(adminId: string, userId: string, dto: UpdateUserStatusDto, ip?: string) {
    if (adminId === userId && dto.status === AccountStatus.DELETED) {
      throw new BadRequestException('You cannot ban your own administrator account.');
    }

    const targetUser = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) throw new NotFoundException('User not found');

    if (dto.status === AccountStatus.DELETED) {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: { status: AccountStatus.DELETED },
        }),
        this.prisma.device.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        }),
        this.prisma.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now },
        }),
      ]);

      this.connectionRegistry.disconnectUser(userId);

      await this.recordAudit({
        adminId,
        action: 'BAN_USER',
        targetType: 'USER',
        targetId: userId,
        details: { username: targetUser.username, reason: dto.reason },
        ipAddress: ip,
      });

      return { ok: true, status: AccountStatus.DELETED };
    } else {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          status: AccountStatus.ACTIVE,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });

      await this.recordAudit({
        adminId,
        action: 'UNBAN_USER',
        targetType: 'USER',
        targetId: userId,
        details: { username: targetUser.username, reason: dto.reason },
        ipAddress: ip,
      });

      return { ok: true, status: AccountStatus.ACTIVE };
    }
  }

  async unlockUser(adminId: string, userId: string, ip?: string) {
    const targetUser = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) throw new NotFoundException('User not found');

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    await this.recordAudit({
      adminId,
      action: 'UNLOCK_ACCOUNT',
      targetType: 'USER',
      targetId: userId,
      details: { username: targetUser.username },
      ipAddress: ip,
    });

    return { ok: true, unlocked: true };
  }

  async revokeUserSessions(adminId: string, userId: string, ip?: string) {
    const targetUser = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) throw new NotFoundException('User not found');

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.device.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);

    this.connectionRegistry.disconnectUser(userId);

    await this.recordAudit({
      adminId,
      action: 'REVOKE_SESSIONS',
      targetType: 'USER',
      targetId: userId,
      details: { username: targetUser.username },
      ipAddress: ip,
    });

    return { ok: true, revoked: true };
  }

  async updateUserRole(adminId: string, userId: string, dto: UpdateUserRoleDto, ip?: string) {
    const targetUser = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) throw new NotFoundException('User not found');

    if (adminId === userId && dto.role !== UserRole.SUPERADMIN) {
      const superadminCount = await this.prisma.user.count({
        where: { role: UserRole.SUPERADMIN, status: AccountStatus.ACTIVE },
      });
      if (superadminCount <= 1) {
        throw new BadRequestException('Cannot demote yourself: you are the only remaining Superadmin.');
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
      select: { id: true, username: true, role: true },
    });

    await this.recordAudit({
      adminId,
      action: 'CHANGE_ROLE',
      targetType: 'USER',
      targetId: userId,
      details: { username: targetUser.username, previousRole: targetUser.role, newRole: dto.role },
      ipAddress: ip,
    });

    return { ok: true, user: updated };
  }

  async getRooms(query: RoomsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.RoomWhereInput = {};

    if (query.search) {
      where.name = { contains: query.search.trim(), mode: 'insensitive' };
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.joinPolicy) {
      where.joinPolicy = query.joinPolicy;
    }

    if (query.joinLocked !== undefined) {
      where.joinLocked = query.joinLocked;
    }

    const [rooms, total] = await Promise.all([
      this.prisma.room.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: { select: { id: true, username: true, email: true } },
          _count: { select: { members: true, messages: true, joinRequests: true } },
        },
      }),
      this.prisma.room.count({ where }),
    ]);

    return {
      rooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        joinPolicy: r.joinPolicy,
        joinLocked: r.joinLocked,
        maxMembers: r.maxMembers,
        keyEpoch: r.keyEpoch,
        createdAt: r.createdAt,
        owner: r.owner,
        membersCount: r._count.members,
        messagesCount: r._count.messages,
        pendingRequestsCount: r._count.joinRequests,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getRoomDetail(roomId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        owner: { select: { id: true, username: true, email: true } },
        members: {
          include: {
            user: { select: { id: true, username: true, email: true, status: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        joinRequests: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: {
            requester: { select: { id: true, username: true, email: true } },
          },
        },
        _count: { select: { messages: true, keyPackages: true } },
      },
    });

    if (!room) throw new NotFoundException('Room not found');

    return {
      room: {
        id: room.id,
        name: room.name,
        status: room.status,
        joinPolicy: room.joinPolicy,
        joinLocked: room.joinLocked,
        maxMembers: room.maxMembers,
        keyEpoch: room.keyEpoch,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        owner: room.owner,
        messagesCount: room._count.messages,
      },
      members: room.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        username: m.user.username,
        email: m.user.email,
        status: m.user.status,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      joinRequests: room.joinRequests.map((j) => ({
        id: j.id,
        requester: j.requester,
        status: j.status,
        createdAt: j.createdAt,
        reviewedAt: j.reviewedAt,
      })),
    };
  }

  async updateRoom(adminId: string, roomId: string, dto: UpdateRoomDto, ip?: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');

    const updated = await this.prisma.room.update({
      where: { id: roomId },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.joinLocked !== undefined ? { joinLocked: dto.joinLocked } : {}),
      },
    });

    await this.recordAudit({
      adminId,
      action: 'UPDATE_ROOM',
      targetType: 'ROOM',
      targetId: roomId,
      details: { name: room.name, patch: dto },
      ipAddress: ip,
    });

    return { ok: true, room: updated };
  }

  async getSecurityEvents(query: SecurityEventsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.SecurityEventWhereInput = {};
    if (query.eventType) where.eventType = query.eventType;
    if (query.userId) where.userId = query.userId;

    const [events, total] = await Promise.all([
      this.prisma.securityEvent.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, username: true, email: true } },
        },
      }),
      this.prisma.securityEvent.count({ where }),
    ]);

    return {
      events: events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        metadata: e.metadata,
        createdAt: e.createdAt,
        user: e.user,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getAuditLogs(query: AuditLogsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Prisma.AdminAuditLogWhereInput = {};
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;

    const [logs, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          admin: { select: { id: true, username: true, email: true } },
        },
      }),
      this.prisma.adminAuditLog.count({ where }),
    ]);

    return {
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        targetType: l.targetType,
        targetId: l.targetId,
        details: l.details,
        ipAddress: l.ipAddress,
        createdAt: l.createdAt,
        admin: l.admin,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async triggerSweep(adminId: string, type: 'messages' | 'attachments' | 'all', ip?: string) {
    let expiredMessagesSwept = 0;
    let expiredTemporaryChatsSwept = 0;
    let orphanedAttachmentsSwept = 0;

    if (type === 'messages' || type === 'all') {
      expiredMessagesSwept = await this.messagesService.cleanupExpiredMessages();
      expiredTemporaryChatsSwept = await this.messagesService.cleanupExpiredTemporaryChats();
    }

    if (type === 'attachments' || type === 'all') {
      orphanedAttachmentsSwept = await this.attachmentsService.cleanupOrphanedAttachments();
    }

    await this.recordAudit({
      adminId,
      action: 'SYSTEM_SWEEP',
      targetType: 'SYSTEM',
      details: {
        type,
        expiredMessagesSwept,
        expiredTemporaryChatsSwept,
        orphanedAttachmentsSwept,
      },
      ipAddress: ip,
    });

    return {
      ok: true,
      sweepResult: {
        expiredMessagesSwept,
        expiredTemporaryChatsSwept,
        orphanedAttachmentsSwept,
      },
    };
  }

  async bootstrapAdmin(dto: BootstrapAdminDto, ip?: string) {
    if (!this.config.adminBootstrapSecret) {
      throw new ForbiddenException('Admin bootstrap is not configured on this server.');
    }

    if (dto.secret !== this.config.adminBootstrapSecret) {
      throw new UnauthorizedException('Invalid bootstrap secret.');
    }

    const clean = dto.identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: clean }, { email: clean }],
      },
    });

    if (!user) throw new NotFoundException(`No user found matching "${dto.identifier}".`);

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { role: UserRole.SUPERADMIN },
      select: { id: true, username: true, email: true, role: true },
    });

    await this.recordAudit({
      adminId: user.id,
      action: 'BOOTSTRAP_ADMIN',
      targetType: 'USER',
      targetId: user.id,
      details: { identifier: dto.identifier, newRole: UserRole.SUPERADMIN },
      ipAddress: ip,
    });

    return { ok: true, user: updated };
  }
}
