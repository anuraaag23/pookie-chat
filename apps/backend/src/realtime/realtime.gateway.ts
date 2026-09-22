import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Inject } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { IsBoolean, IsString, validateOrReject } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { verifyAccessToken } from '../domain/tokens';
import { AppConfig } from '../config/env';
import { APP_CONFIG } from '../config/config.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { PrismaService } from '../prisma/prisma.service';

class TypingEventDto {
  @IsString()
  conversationId!: string;

  @IsBoolean()
  isTyping!: boolean;
}

/**
 * This is written against `@nestjs/websockets` + socket.io per the
 * chosen architecture (docs/00-ARCHITECTURE.md) — it is real, complete
 * code, not executable in this sandbox for the same reason nothing
 * requiring `npm install` is (no network access here). The equivalent
 * protocol-level behavior (auth-on-connect, message push, typing relay,
 * read receipts) is what verification-harness/ actually exercises end to
 * end, using a hand-rolled WebSocket implementation built only to prove
 * the design — see the final report for exactly what that did and didn't
 * confirm.
 */
@WebSocketGateway({ cors: false }) // CORS is handled by the one configured WEB_ORIGIN at the HTTP layer, not re-opened here
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly registry: ConnectionRegistryService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(socket: Socket) {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    const payload = typeof token === 'string' ? verifyAccessToken(token, this.config.accessTokenSecret) : null;
    if (!payload) {
      socket.disconnect(true);
      return;
    }
    // The token can be cryptographically valid and unexpired but still
    // belong to a device that's since been revoked (Settings → Devices,
    // or "log out all other devices") — reject the connection itself,
    // not just future actions on it, so a revoked device can never
    // reconnect using its old token regardless of how much of its 15
    // minutes remain. Same check AccessTokenGuard applies to HTTP.
    const device = await this.prisma.device.findUnique({ where: { id: payload.deviceId }, select: { revokedAt: true } });
    if (!device || device.revokedAt) {
      socket.disconnect(true);
      return;
    }
    (socket.data as any).userId = payload.userId;
    (socket.data as any).deviceId = payload.deviceId;
    if (!this.registry.register(payload.userId, payload.deviceId, socket)) {
      socket.disconnect(true);
      return;
    }
    await this.touchLastSeen(payload.deviceId);
  }

  handleDisconnect(socket: Socket) {
    const userId = (socket.data as any).userId;
    const deviceId = (socket.data as any).deviceId;
    if (userId && deviceId) this.registry.unregister(userId, deviceId, socket);
    // "Offline" the moment the last socket for this device actually
    // closes, not left at whatever lastSeenAt happened to be from the
    // last heartbeat — the UI's online/offline indicator (isDeviceOnline)
    // is a separate, live in-memory check, but lastSeenAt is what a
    // returning "Last active" timestamp in Settings shows if the device
    // stays offline, so it needs to reflect the actual disconnect moment.
    if (deviceId && !this.registry.isDeviceOnline(deviceId)) this.touchLastSeen(deviceId);
  }

  /** Client-initiated, on an interval, so a long-lived idle connection's lastSeenAt doesn't go stale between actual actions. */
  @SubscribeMessage('heartbeat')
  async onHeartbeat(@ConnectedSocket() socket: Socket) {
    const deviceId = (socket.data as any).deviceId;
    if (deviceId) await this.touchLastSeen(deviceId);
  }

  private async touchLastSeen(deviceId: string) {
    await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } }).catch(() => {
      // Device may have been revoked/deleted concurrently — not fatal to
      // the connection lifecycle event that triggered this.
    });
  }

  @SubscribeMessage('typing')
  async onTyping(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const dto = plainToInstance(TypingEventDto, body);
    try {
      await validateOrReject(dto);
    } catch {
      return; // malformed input is silently dropped, not trusted
    }
    const userId = (socket.data as any).userId;
    if (!this.registry.allowTyping(userId)) return; // rate-limited — silently dropped, same as malformed input above
    // The typer's (userId's) own setting — same principle as read
    // receipts: this is a preference about what *you* reveal about your
    // own activity, checked against whoever is about to type, not
    // whoever receives it. Previously missing entirely, so disabling
    // this in Settings had no actual effect — the event was relayed
    // either way.
    const settings = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (settings && !settings.typingIndicatorEnabled) return;
    const convo = await this.prisma.conversation.findUnique({ where: { id: dto.conversationId } });
    if (!convo || (convo.userAId !== userId && convo.userBId !== userId)) return;
    const otherId = convo.userAId === userId ? convo.userBId : convo.userAId;
    // Never persisted — see docs' explicit "do not store typing events".
    this.registry.pushToUser(otherId, 'typing', { conversationId: dto.conversationId, isTyping: dto.isTyping, from: userId });
  }
}
