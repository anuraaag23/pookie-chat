import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionRegistryService } from '../realtime/connection-registry.service';
import { normalizeUsername } from '../domain/username';
import { CreateConversationRequestDto } from './dto/conversation-requests.dto';

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

@Injectable()
export class ConversationRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistryService,
  ) {}

  async sendRequest(senderId: string, dto: CreateConversationRequestDto) {
    const normalizedTarget = normalizeUsername(dto.targetUsername);

    const target = await this.prisma.user.findUnique({
      where: { username: normalizedTarget },
      select: {
        id: true,
        username: true,
        displayName: true,
        status: true,
        settings: { select: { usernameSearchEnabled: true } },
      },
    });

    // Uniform not-found to prevent account enumeration
    if (!target || target.status !== 'ACTIVE') {
      throw new NotFoundException('User not found or unavailable');
    }

    if (target.id === senderId) {
      throw new BadRequestException('You cannot send a conversation request to yourself');
    }

    // Privacy setting check
    const discoverable = target.settings?.usernameSearchEnabled ?? true;
    if (!discoverable) {
      throw new NotFoundException('User not found or unavailable');
    }

    // Block check
    const [userAId, userBId] = canonicalPair(senderId, target.id);
    const existingConv = await this.prisma.conversation.findUnique({
      where: { userAId_userBId: { userAId, userBId } },
      select: { id: true, status: true },
    });

    if (existingConv) {
      if (existingConv.status === 'BLOCKED_BY_A' || existingConv.status === 'BLOCKED_BY_B') {
        throw new NotFoundException('User not found or unavailable');
      }
      if (existingConv.status === 'ACTIVE') {
        throw new BadRequestException('You already have an active conversation with this user');
      }
    }

    // Check for existing pending request from sender to recipient
    const existingPending = await this.prisma.conversationRequest.findFirst({
      where: {
        senderId,
        recipientId: target.id,
        status: 'PENDING',
      },
    });

    if (existingPending) {
      throw new ConflictException('A conversation request to this user is already pending');
    }

    const createdReq = await this.prisma.conversationRequest.create({
      data: {
        senderId,
        recipientId: target.id,
        status: 'PENDING',
      },
    });

    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { id: true, username: true, displayName: true },
    });

    // Notify recipient in real time
    this.registry.pushToUser(target.id, 'conversation:request_received', {
      requestId: createdReq.id,
      sender,
      createdAt: createdReq.createdAt,
    });

    return {
      success: true,
      requestId: createdReq.id,
      status: 'PENDING',
      targetUser: {
        id: target.id,
        username: target.username,
        displayName: target.displayName,
      },
    };
  }

  async listPending(userId: string) {
    const [incoming, outgoing] = await Promise.all([
      this.prisma.conversationRequest.findMany({
        where: { recipientId: userId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        include: {
          sender: { select: { id: true, username: true, displayName: true } },
        },
      }),
      this.prisma.conversationRequest.findMany({
        where: { senderId: userId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        include: {
          recipient: { select: { id: true, username: true, displayName: true } },
        },
      }),
    ]);

    return {
      incoming: incoming.map((req) => ({
        id: req.id,
        sender: req.sender,
        createdAt: req.createdAt,
      })),
      outgoing: outgoing.map((req) => ({
        id: req.id,
        recipient: req.recipient,
        createdAt: req.createdAt,
      })),
    };
  }

  async acceptRequest(userId: string, requestId: string) {
    const req = await this.prisma.conversationRequest.findUnique({
      where: { id: requestId },
      include: {
        recipient: { select: { id: true, username: true, displayName: true } },
      },
    });

    if (!req) {
      throw new NotFoundException('Request not found');
    }
    if (req.recipientId !== userId) {
      throw new ForbiddenException('You cannot accept a request addressed to someone else');
    }
    if (req.status !== 'PENDING') {
      throw new BadRequestException('This conversation request is no longer active');
    }

    const [userAId, userBId] = canonicalPair(req.senderId, userId);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.conversationRequest.update({
        where: { id: requestId },
        data: { status: 'ACCEPTED' },
      });

      const existingConv = await tx.conversation.findUnique({
        where: { userAId_userBId: { userAId, userBId } },
      });

      let conv;
      if (existingConv) {
        conv = await tx.conversation.update({
          where: { id: existingConv.id },
          data: {
            status: 'ACTIVE',
            sessionEpoch: { increment: 1 },
          },
        });
      } else {
        conv = await tx.conversation.create({
          data: {
            userAId,
            userBId,
            status: 'ACTIVE',
            sessionEpoch: 1,
          },
        });
      }

      return conv;
    });

    // Notify sender that their request was accepted
    this.registry.pushToUser(req.senderId, 'conversation:request_accepted', {
      requestId: req.id,
      conversationId: result.id,
      sessionEpoch: result.sessionEpoch,
      otherUser: req.recipient,
    });

    return {
      success: true,
      conversationId: result.id,
      sessionEpoch: result.sessionEpoch,
    };
  }

  async rejectRequest(userId: string, requestId: string) {
    const req = await this.prisma.conversationRequest.findUnique({
      where: { id: requestId },
    });

    if (!req) {
      throw new NotFoundException('Request not found');
    }
    if (req.recipientId !== userId) {
      throw new ForbiddenException('You cannot reject a request addressed to someone else');
    }
    if (req.status !== 'PENDING') {
      throw new BadRequestException('This conversation request is no longer active');
    }

    await this.prisma.conversationRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED' },
    });

    this.registry.pushToUser(req.senderId, 'conversation:request_rejected', {
      requestId: req.id,
    });

    return { success: true };
  }

  async cancelRequest(userId: string, requestId: string) {
    const req = await this.prisma.conversationRequest.findUnique({
      where: { id: requestId },
    });

    if (!req) {
      throw new NotFoundException('Request not found');
    }
    if (req.senderId !== userId) {
      throw new ForbiddenException('You cannot cancel a request you did not send');
    }
    if (req.status !== 'PENDING') {
      throw new BadRequestException('This conversation request is no longer active');
    }

    await this.prisma.conversationRequest.update({
      where: { id: requestId },
      data: { status: 'CANCELLED' },
    });

    return { success: true };
  }
}
