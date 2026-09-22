import { Module } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';
import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AttachmentsModule } from '../attachments/attachments.module';

@Module({
  // THE FIX (found during the real-environment boot audit): MessagesService's
  // constructor injects AttachmentsService (used by deleteMessage/the
  // disappearing-message expiry sweep to clean up a message's linked
  // attachment), but AttachmentsModule was never imported here — only
  // AuthModule and RealtimeModule were. This is exactly the class of bug
  // no test in this project could ever have caught: the domain/unit tests
  // exercise pure functions, not NestJS classes via real dependency
  // injection, and the verification harness hand-rolls its own HTTP
  // handling without NestJS's DI container at all. NestFactory.create(AppModule)
  // would have thrown "Nest can't resolve dependencies of MessagesService"
  // and refused to boot, before the server ever started listening —
  // confirmed by systematically checking every other service's
  // constructor against its own module's imports (ConversationsService
  // needs the exact same AttachmentsService and already imports
  // AttachmentsModule correctly; this was the one place it was missing).
  imports: [AuthModule, RealtimeModule, AttachmentsModule],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
