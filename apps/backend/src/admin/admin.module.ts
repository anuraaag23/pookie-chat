import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { SuperadminGuard } from './superadmin.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    AuthModule,
    MessagesModule,
    AttachmentsModule,
    RealtimeModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, SuperadminGuard],
  exports: [AdminService, AdminGuard, SuperadminGuard],
})
export class AdminModule {}
