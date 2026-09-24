import { Module } from '@nestjs/common';
import { ConversationRequestsController } from './conversation-requests.controller';
import { ConversationRequestsService } from './conversation-requests.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [PrismaModule, RealtimeModule],
  controllers: [ConversationRequestsController],
  providers: [ConversationRequestsService],
  exports: [ConversationRequestsService],
})
export class ConversationRequestsModule {}
