import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import { ConnectionRegistryService } from '../realtime/connection-registry.service';
import {
  validateRoomName,
  validateMaxMembers,
  generateRoomCode,
  normalizeRoomCode,
  hashRoomCode,
  encryptRoomCode,
  decryptRoomCode,
  verifyRoomCode,
} from '../domain/room';
import {
  CreateRoomDto,
  UpdateRoomDto,
  AcceptRequestDto,
  SendRoomMessageDto,
  StoreKeyPackageDto,
} from './dto/rooms.dto';

const MAX_CODE_COLLISION_RETRY_ATTEMPTS = 5;
const MAX_MESSAGE_RETRY_ATTEMPTS = 5;

@Injectable()
export class RoomsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: ConnectionRegistryService,
  ) {}

  async create(userId: string, dto: CreateRoomDto) {
    const nameVal = validateRoomName(dto.name);
    if (!nameVal.valid) {
      throw new BadRequestException(nameVal.error);
    }

    const membersVal = validateMaxMembers(dto.maxMembers);
    if (!membersVal.valid) {
      throw new BadRequestException(membersVal.error);
    }

    for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRY_ATTEMPTS; attempt++) {
      const code = generateRoomCode();
      const codeHmac = hashRoomCode(code, this.config.pairingCodePepper);
      const codeText = encryptRoomCode(code, this.config.pairingCodePepper);

      try {
        const room = await this.prisma.$transaction(async (tx) => {
          const created = await tx.room.create({
            data: {
              name: nameVal.normalized,
              ownerId: userId,
              codeHmac,
              codeText,
              joinPolicy: dto.joinPolicy,
              maxMembers: membersVal.value,
              status: 'ACTIVE',
              keyEpoch: 1,
            },
          });

          await tx.roomMember.create({
            data: {
              roomId: created.id,
              userId,
              role: 'OWNER',
            },
          });

          return created;
        });

        return {
          room: {
            id: room.id,
            name: room.name,
            maxMembers: room.maxMembers,
            memberCount: 1,
            joinPolicy: room.joinPolicy,
            code,
            role: 'OWNER',
            createdAt: room.createdAt,
          },
        };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          continue; // Code collision, retry
        }
        throw err;
      }
    }

    throw new BadRequestException('Could not generate a unique room code. Please try again.');
  }

  async listUserRooms(userId: string) {
    const rooms = await this.prisma.room.findMany({
      where: {
        status: 'ACTIVE',
        members: { some: { userId } },
      },
      include: {
        members: {
          select: {
            id: true,
            userId: true,
            role: true,
            joinedAt: true,
            user: { select: { username: true, displayName: true } },
          },
        },
        owner: { select: { id: true, username: true, displayName: true } },
        messages: {
          orderBy: { sequenceNumber: 'desc' },
          take: 1,
          select: { id: true, sentAt: true, messageType: true, clientMessageId: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return rooms.map((r) => {
      const myMembership = r.members.find((m) => m.userId === userId);
      return {
        id: r.id,
        name: r.name,
        maxMembers: r.maxMembers,
        memberCount: r.members.length,
        joinPolicy: r.joinPolicy,
        role: myMembership?.role ?? 'MEMBER',
        owner: r.owner,
        lastMessage: r.messages[0] ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  async getRoom(userId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, displayName: true } },
          },
          take: 50,
          orderBy: { joinedAt: 'asc' },
        },
        owner: { select: { id: true, username: true, displayName: true } },
      },
    });

    if (!room || room.status === 'DELETED') {
      throw new NotFoundException('Room not found');
    }

    const myMembership = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!myMembership) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const totalMemberCount = await this.prisma.roomMember.count({ where: { roomId } });

    let code: string | null = null;
    if (room.ownerId === userId && room.codeText) {
      try {
        code = decryptRoomCode(room.codeText, this.config.pairingCodePepper);
      } catch {
        code = null;
      }
    }

    return {
      id: room.id,
      name: room.name,
      maxMembers: room.maxMembers,
      memberCount: totalMemberCount,
      joinPolicy: room.joinPolicy,
      status: room.status,
      keyEpoch: room.keyEpoch,
      role: myMembership.role,
      code,
      owner: {
        id: room.owner.id,
        username: room.owner.username,
        displayName: room.owner.displayName,
      },
      members: room.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        username: m.user.username,
        displayName: m.user.displayName,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      createdAt: room.createdAt,
    };
  }

  async getMembers(userId: string, roomId: string, page = 1, limit = 50) {
    const myMembership = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!myMembership) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safePage = Math.max(page, 1);
    const skip = (safePage - 1) * safeLimit;

    const [members, total] = await Promise.all([
      this.prisma.roomMember.findMany({
        where: { roomId },
        skip,
        take: safeLimit,
        orderBy: { joinedAt: 'asc' },
        include: {
          user: { select: { id: true, username: true, displayName: true } },
        },
      }),
      this.prisma.roomMember.count({ where: { roomId } }),
    ]);

    return {
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        username: m.user.username,
        displayName: m.user.displayName,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  async joinByCode(userId: string, code: string) {
    const normalized = normalizeRoomCode(code);
    const codeHmac = hashRoomCode(normalized, this.config.pairingCodePepper);

    // SEC-M01 FIX: Direct O(1) indexed lookup via unique codeHmac
    // instead of scanning all active rooms into Node.js heap memory.
    const room = await this.prisma.room.findUnique({
      where: { codeHmac },
      select: {
        id: true,
        name: true,
        status: true,
        maxMembers: true,
        joinPolicy: true,
        ownerId: true,
        members: { select: { userId: true } },
      },
    });

    if (!room || room.status !== 'ACTIVE') {
      throw new BadRequestException('Invalid room code');
    }

    if (room.members.some((m) => m.userId === userId)) {
      return { status: 'ALREADY_MEMBER', roomId: room.id, roomName: room.name };
    }

    if (room.members.length >= room.maxMembers) {
      throw new BadRequestException('Room is full');
    }

    if (room.joinPolicy === 'OPEN') {
      await this.prisma.$transaction(async (tx) => {
        const count = await tx.roomMember.count({ where: { roomId: room.id } });
        if (count >= room.maxMembers) {
          throw new BadRequestException('Room is full');
        }
        await tx.roomMember.create({
          data: {
            roomId: room.id,
            userId,
            role: 'MEMBER',
          },
        });
      });

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, displayName: true },
      });

      this.registry.pushToUsers(
        room.members.map((m) => m.userId),
        'room:member_joined',
        { roomId: room.id, user, memberCount: room.members.length + 1 },
      );

      return { status: 'JOINED', roomId: room.id, roomName: room.name };
    }

    // APPROVAL_REQUIRED:
    const existingReq = await this.prisma.roomJoinRequest.findFirst({
      where: {
        roomId: room.id,
        requesterId: userId,
        status: 'PENDING',
      },
    });

    if (existingReq) {
      return {
        status: 'PENDING',
        roomId: room.id,
        roomName: room.name,
        message: 'Your join request is already pending.',
      };
    }

    const req = await this.prisma.roomJoinRequest.create({
      data: {
        roomId: room.id,
        requesterId: userId,
        status: 'PENDING',
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true },
    });

    this.registry.pushToUser(room.ownerId, 'room:join_request', {
      requestId: req.id,
      roomId: room.id,
      roomName: room.name,
      requester: user,
      createdAt: req.createdAt,
    });

    return {
      status: 'REQUEST_SENT',
      roomId: room.id,
      roomName: room.name,
      message: 'Join request sent. Waiting for the room owner to approve your request.',
    };
  }

  async getPendingRequests(userId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.status !== 'ACTIVE') {
      throw new NotFoundException('Room not found');
    }

    if (room.ownerId !== userId) {
      throw new ForbiddenException('Only the room owner can view join requests');
    }

    const requests = await this.prisma.roomJoinRequest.findMany({
      where: { roomId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        requester: {
          select: {
            id: true,
            username: true,
            displayName: true,
            devices: {
              where: { revokedAt: null },
              orderBy: { lastSeenAt: 'desc' },
              take: 1,
              select: { identityDhPublic: true },
            },
          },
        },
      },
    });

    return requests.map((r) => ({
      id: r.id,
      roomId: r.roomId,
      requester: {
        id: r.requester.id,
        username: r.requester.username,
        displayName: r.requester.displayName,
        identityDhPublic: r.requester.devices[0]?.identityDhPublic ?? null,
      },
      createdAt: r.createdAt,
      status: r.status,
    }));
  }

  async acceptRequest(ownerId: string, roomId: string, requestId: string, dto: AcceptRequestDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room || room.status !== 'ACTIVE') {
        throw new NotFoundException('Room not found');
      }
      if (room.ownerId !== ownerId) {
        throw new ForbiddenException('Only the room owner can accept join requests');
      }

      const req = await tx.roomJoinRequest.findUnique({ where: { id: requestId } });
      if (!req || req.roomId !== roomId) {
        throw new NotFoundException('Request not found');
      }
      if (req.status !== 'PENDING') {
        throw new BadRequestException('This join request is no longer active');
      }

      const count = await tx.roomMember.count({ where: { roomId } });
      if (count >= room.maxMembers) {
        throw new BadRequestException('Room is full');
      }

      await tx.roomJoinRequest.update({
        where: { id: requestId },
        data: {
          status: 'ACCEPTED',
          reviewedAt: new Date(),
          reviewedById: ownerId,
        },
      });

      const existingMember = await tx.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId: req.requesterId } },
      });
      if (!existingMember) {
        await tx.roomMember.create({
          data: {
            roomId,
            userId: req.requesterId,
            role: 'MEMBER',
          },
        });
      }

      if (dto.encryptedKey && dto.nonce) {
        await tx.roomKeyPackage.upsert({
          where: {
            roomId_keyEpoch_recipientUserId: {
              roomId,
              keyEpoch: room.keyEpoch,
              recipientUserId: req.requesterId,
            },
          },
          create: {
            roomId,
            keyEpoch: room.keyEpoch,
            recipientUserId: req.requesterId,
            encryptedKey: Buffer.from(dto.encryptedKey, 'base64'),
            nonce: Buffer.from(dto.nonce, 'base64'),
            senderUserId: ownerId,
          },
          update: {
            encryptedKey: Buffer.from(dto.encryptedKey, 'base64'),
            nonce: Buffer.from(dto.nonce, 'base64'),
            senderUserId: ownerId,
          },
        });
      }

      const requester = await tx.user.findUnique({
        where: { id: req.requesterId },
        select: { id: true, username: true, displayName: true },
      });

      const members = await tx.roomMember.findMany({
        where: { roomId },
        select: { userId: true },
      });

      return {
        room,
        requester: requester!,
        memberUserIds: members.map((m) => m.userId),
        newMemberCount: count + 1,
      };
    });

    // Notify requester
    this.registry.pushToUser(result.requester.id, 'room:join_accepted', {
      roomId,
      roomName: result.room.name,
    });

    // Notify all room members
    this.registry.pushToUsers(result.memberUserIds, 'room:member_joined', {
      roomId,
      user: result.requester,
      memberCount: result.newMemberCount,
    });

    return {
      success: true,
      memberCount: result.newMemberCount,
      user: result.requester,
    };
  }

  async rejectRequest(ownerId: string, roomId: string, requestId: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const room = await tx.room.findUnique({ where: { id: roomId } });
      if (!room || room.status !== 'ACTIVE') {
        throw new NotFoundException('Room not found');
      }
      if (room.ownerId !== ownerId) {
        throw new ForbiddenException('Only the room owner can reject join requests');
      }

      const req = await tx.roomJoinRequest.findUnique({ where: { id: requestId } });
      if (!req || req.roomId !== roomId) {
        throw new NotFoundException('Request not found');
      }
      if (req.status !== 'PENDING') {
        throw new BadRequestException('This join request is no longer active');
      }

      await tx.roomJoinRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          reviewedAt: new Date(),
          reviewedById: ownerId,
        },
      });

      return { room, req };
    });

    // Notify rejected user
    this.registry.pushToUser(result.req.requesterId, 'room:join_rejected', {
      roomId,
      roomName: result.room.name,
    });

    // Per Requirement 10: existing room members receive NOTHING.
    return { success: true };
  }

  async listMessages(userId: string, roomId: string, limit = 100) {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const messages = await this.prisma.roomMessage.findMany({
      where: { roomId, deletedAt: null },
      orderBy: { sequenceNumber: 'asc' },
      take: limit,
      include: {
        sender: { select: { id: true, username: true, displayName: true } },
      },
    });

    return messages.map((m) => ({
      id: m.id,
      roomId: m.roomId,
      sender: m.sender,
      sequenceNumber: Number(m.sequenceNumber),
      clientMessageId: m.clientMessageId,
      ciphertext: m.ciphertext.toString('base64'),
      iv: m.nonce.toString('base64'),
      messageType: m.messageType,
      keyEpoch: m.keyEpoch,
      replyToMessageId: m.replyToMessageId,
      sentAt: m.sentAt,
    }));
  }

  async sendMessage(userId: string, roomId: string, dto: SendRoomMessageDto) {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.status !== 'ACTIVE') {
      throw new NotFoundException('Room is no longer active');
    }

    for (let attempt = 0; attempt < MAX_MESSAGE_RETRY_ATTEMPTS; attempt++) {
      const maxSeq = await this.prisma.roomMessage.aggregate({
        where: { roomId },
        _max: { sequenceNumber: true },
      });
      const sequenceNumber = (maxSeq._max.sequenceNumber ?? 0n) + 1n;

      try {
        const message = await this.prisma.roomMessage.create({
          data: {
            roomId,
            senderId: userId,
            sequenceNumber,
            clientMessageId: dto.clientMessageId,
            ciphertext: Buffer.from(dto.ciphertext, 'base64'),
            nonce: Buffer.from(dto.iv, 'base64'),
            messageType: dto.messageType ?? 'TEXT',
            keyEpoch: dto.keyEpoch ?? room.keyEpoch,
            replyToMessageId: dto.replyToMessageId ?? null,
            sentAt: new Date(),
          },
          include: {
            sender: { select: { id: true, username: true, displayName: true } },
          },
        });

        // Broadcast to all room members
        const members = await this.prisma.roomMember.findMany({
          where: { roomId },
          select: { userId: true },
        });

        this.registry.pushToUsers(
          members.map((m) => m.userId),
          'room:message',
          {
            id: message.id,
            roomId,
            sender: message.sender,
            sequenceNumber: Number(message.sequenceNumber),
            clientMessageId: message.clientMessageId,
            ciphertext: dto.ciphertext,
            iv: dto.iv,
            messageType: message.messageType,
            keyEpoch: message.keyEpoch,
            replyToMessageId: message.replyToMessageId,
            sentAt: message.sentAt,
          },
        );

        return {
          id: message.id,
          sequenceNumber: Number(message.sequenceNumber),
          sentAt: message.sentAt,
        };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // Check if deduped by clientMessageId
          const existing = await this.prisma.roomMessage.findUnique({
            where: { roomId_clientMessageId: { roomId, clientMessageId: dto.clientMessageId } },
          });
          if (existing) {
            return {
              id: existing.id,
              sequenceNumber: Number(existing.sequenceNumber),
              sentAt: existing.sentAt,
            };
          }
          continue; // Sequence collision, retry
        }
        throw err;
      }
    }

    throw new BadRequestException('Could not send message. Please retry.');
  }

  async leaveRoom(userId: string, roomId: string) {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) {
      throw new NotFoundException('Membership not found');
    }

    if (member.role === 'OWNER') {
      throw new BadRequestException('Room owner cannot leave the room. Delete or close the room instead.');
    }

    await this.prisma.roomMember.delete({ where: { id: member.id } });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true },
    });

    const remaining = await this.prisma.roomMember.findMany({
      where: { roomId },
      select: { userId: true },
    });

    this.registry.pushToUsers(
      remaining.map((m) => m.userId),
      'room:member_left',
      { roomId, user, memberCount: remaining.length },
    );

    return { success: true };
  }

  async deleteRoom(ownerId: string, roomId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      include: { members: { select: { userId: true } } },
    });

    if (!room || room.status !== 'ACTIVE') {
      throw new NotFoundException('Room not found');
    }

    if (room.ownerId !== ownerId) {
      throw new ForbiddenException('Only the room owner can delete the room');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.room.update({
        where: { id: roomId },
        data: { status: 'DELETED' },
      });

      await tx.roomJoinRequest.updateMany({
        where: { roomId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
    });

    this.registry.pushToUsers(
      room.members.map((m) => m.userId),
      'room:closed',
      { roomId, roomName: room.name },
    );

    return { success: true };
  }

  async storeKeyPackage(userId: string, roomId: string, dto: StoreKeyPackageDto) {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.status !== 'ACTIVE') {
      throw new NotFoundException('Room not found');
    }

    const keyEpoch = dto.keyEpoch ?? room.keyEpoch;

    await this.prisma.roomKeyPackage.upsert({
      where: {
        roomId_keyEpoch_recipientUserId: {
          roomId,
          keyEpoch,
          recipientUserId: dto.recipientUserId,
        },
      },
      create: {
        roomId,
        keyEpoch,
        recipientUserId: dto.recipientUserId,
        encryptedKey: Buffer.from(dto.encryptedKey, 'base64'),
        nonce: Buffer.from(dto.nonce, 'base64'),
        senderUserId: userId,
      },
      update: {
        encryptedKey: Buffer.from(dto.encryptedKey, 'base64'),
        nonce: Buffer.from(dto.nonce, 'base64'),
        senderUserId: userId,
      },
    });

    return { success: true };
  }

  async getKeyPackage(userId: string, roomId: string, keyEpoch?: number) {
    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!member) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const room = await this.prisma.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('Room not found');

    const epoch = keyEpoch ?? room.keyEpoch;
    const pkg = await this.prisma.roomKeyPackage.findUnique({
      where: {
        roomId_keyEpoch_recipientUserId: {
          roomId,
          keyEpoch: epoch,
          recipientUserId: userId,
        },
      },
      include: {
        senderUser: {
          select: {
            id: true,
            username: true,
            devices: {
              where: { revokedAt: null },
              orderBy: { lastSeenAt: 'desc' },
              take: 1,
              select: { identityDhPublic: true },
            },
          },
        },
      },
    });

    if (!pkg) {
      return { keyPackage: null };
    }

    return {
      keyPackage: {
        roomId: pkg.roomId,
        keyEpoch: pkg.keyEpoch,
        encryptedKey: pkg.encryptedKey.toString('base64'),
        nonce: pkg.nonce.toString('base64'),
        sender: {
          id: pkg.senderUser.id,
          username: pkg.senderUser.username,
          identityDhPublic: pkg.senderUser.devices[0]?.identityDhPublic ?? null,
        },
      },
    };
  }

  async updateRoom(ownerId: string, roomId: string, dto: UpdateRoomDto) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
    });
    if (!room || room.status !== 'ACTIVE') {
      throw new NotFoundException('Room not found');
    }
    if (room.ownerId !== ownerId) {
      throw new ForbiddenException('Only the room owner can update room settings');
    }

    const data: Prisma.RoomUpdateInput = {};

    if (dto.name !== undefined) {
      const nameVal = validateRoomName(dto.name);
      if (!nameVal.valid) {
        throw new BadRequestException(nameVal.error);
      }
      data.name = nameVal.normalized;
    }

    if (dto.maxMembers !== undefined) {
      const membersVal = validateMaxMembers(dto.maxMembers);
      if (!membersVal.valid) {
        throw new BadRequestException(membersVal.error);
      }
      const currentMemberCount = await this.prisma.roomMember.count({ where: { roomId } });
      if (membersVal.value < currentMemberCount) {
        throw new BadRequestException(
          `Cannot reduce maximum members below current member count (${currentMemberCount})`,
        );
      }
      data.maxMembers = membersVal.value;
    }

    if (dto.joinPolicy !== undefined) {
      data.joinPolicy = dto.joinPolicy;
    }

    const updated = await this.prisma.room.update({
      where: { id: roomId },
      data,
    });

    const members = await this.prisma.roomMember.findMany({
      where: { roomId },
      select: { userId: true },
    });

    this.registry.pushToUsers(
      members.map((m) => m.userId),
      'room:updated',
      {
        roomId,
        name: updated.name,
        maxMembers: updated.maxMembers,
        joinPolicy: updated.joinPolicy,
      },
    );

    return {
      id: updated.id,
      name: updated.name,
      maxMembers: updated.maxMembers,
      joinPolicy: updated.joinPolicy,
    };
  }

  async removeMember(ownerId: string, roomId: string, targetUserId: string) {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
    });
    if (!room || room.status !== 'ACTIVE') {
      throw new NotFoundException('Room not found');
    }
    if (room.ownerId !== ownerId) {
      throw new ForbiddenException('Only the room owner can remove members');
    }
    if (targetUserId === ownerId) {
      throw new BadRequestException('Room owner cannot be removed. Close or delete the room instead.');
    }

    const member = await this.prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      include: { user: { select: { id: true, username: true, displayName: true } } },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }

    const updatedRoom = await this.prisma.$transaction(async (tx) => {
      await tx.roomMember.delete({ where: { id: member.id } });
      return tx.room.update({
        where: { id: roomId },
        data: { keyEpoch: { increment: 1 } },
      });
    });

    const remainingMembers = await this.prisma.roomMember.findMany({
      where: { roomId },
      select: { userId: true },
    });

    // Notify removed user
    this.registry.pushToUser(targetUserId, 'room:member_removed', {
      roomId,
      roomName: room.name,
    });

    // Notify remaining members of leave and key rotation requirement
    this.registry.pushToUsers(
      remainingMembers.map((m) => m.userId),
      'room:member_left',
      {
        roomId,
        user: member.user,
        memberCount: remainingMembers.length,
      },
    );
    this.registry.pushToUsers(
      remainingMembers.map((m) => m.userId),
      'room:key_rotation_required',
      {
        roomId,
        newKeyEpoch: updatedRoom.keyEpoch,
      },
    );

    return { success: true, newKeyEpoch: updatedRoom.keyEpoch };
  }
}
