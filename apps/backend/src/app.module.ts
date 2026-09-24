import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { HealthController } from './health/health.controller';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { PairingModule } from './pairing/pairing.module';
import { HandshakeModule } from './handshake/handshake.module';
import { MessagesModule } from './messages/messages.module';
import { ConversationsModule } from './conversations/conversations.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SettingsModule } from './settings/settings.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { UsersModule } from './users/users.module';
import { EmailModule } from './email/email.module';
import { StorageModule } from './storage/storage.module';
import { RoomsModule } from './rooms/rooms.module';
import { ConversationRequestsModule } from './conversation-requests/conversation-requests.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // Baseline rate limit, applied globally. Security-sensitive endpoints
    // (pairing-code redemption, login) get their own stricter, dedicated
    // limits on top of this — see their respective controllers.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthModule,
    EmailModule,
    PairingModule,
    HandshakeModule,
    RealtimeModule,
    StorageModule,
    AttachmentsModule,
    MessagesModule,
    ConversationsModule,
    SettingsModule,
    UsersModule,
    RoomsModule,
    ConversationRequestsModule,
  ],
  controllers: [HealthController],
  providers: [
    // The import above only configures storage/limits — NestJS's Throttler
    // does nothing unless a guard is actually registered. Global here means
    // every route gets the default 100/min unless overridden by a
    // controller-level @Throttle(), same as the comment above always
    // claimed but, until this provider existed, did not actually do.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
